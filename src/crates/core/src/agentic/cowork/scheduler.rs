use crate::agentic::coordination::ConversationCoordinator;
use crate::agentic::cowork::types::{CoworkSessionState, CoworkTask, CoworkTaskState};
use crate::agentic::tools::pipeline::SubagentParentInfo;
use crate::infrastructure::events::{emit_global_event, BackendEvent};
use crate::util::errors::{BitFunError, BitFunResult};
use log::{debug, warn};
use std::collections::HashMap;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

use super::manager::CoworkManager;

pub async fn run_scheduler_loop(
    manager: &CoworkManager,
    coordinator: Arc<ConversationCoordinator>,
    cowork_session_id: &str,
    cancel_token: CancellationToken,
) -> BitFunResult<()> {
    debug!("Cowork scheduler loop started: cowork_session_id={}", cowork_session_id);

    loop {
        if cancel_token.is_cancelled() {
            emit_cowork_event(
                "cowork://session-state",
                serde_json::json!({
                    "coworkSessionId": cowork_session_id,
                    "state": "cancelled",
                    "timestamp": chrono::Utc::now().timestamp_millis(),
                }),
            )
            .await;
            return Ok(());
        }

        let snapshot = manager.get_session_snapshot(cowork_session_id)?;
        let session = snapshot.session;

        match session.state {
            CoworkSessionState::Paused => {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                continue;
            }
            CoworkSessionState::Cancelled | CoworkSessionState::Completed | CoworkSessionState::Error => {
                return Ok(());
            }
            _ => {}
        }

        // Build quick lookup maps.
        let tasks_by_id: HashMap<String, CoworkTask> =
            session.tasks.into_iter().map(|t| (t.id.clone(), t)).collect();

        // Ensure deps refer to known tasks.
        for t in tasks_by_id.values() {
            for dep in &t.deps {
                if !tasks_by_id.contains_key(dep) {
                    return Err(BitFunError::Validation(format!(
                        "Task '{}' depends on unknown task id '{}'",
                        t.id, dep
                    )));
                }
            }
        }

        // Handle HITL: auto-mark tasks with questions as WaitingUserInput until answered.
        for task_id in &session.task_order {
            if let Some(mut t) = tasks_by_id.get(task_id).cloned() {
                if !t.questions.is_empty() && t.user_answers.is_empty() {
                    if t.state != CoworkTaskState::WaitingUserInput {
                        t.state = CoworkTaskState::WaitingUserInput;
                        t.updated_at_ms = chrono::Utc::now().timestamp_millis();
                        manager.update_task(cowork_session_id, t.clone()).await?;
                        emit_cowork_event(
                            "cowork://needs-user-input",
                            serde_json::json!({
                                "coworkSessionId": cowork_session_id,
                                "taskId": t.id,
                                "questions": t.questions,
                                "timestamp": t.updated_at_ms,
                            }),
                        )
                        .await;
                        emit_task_state_changed(cowork_session_id, &t).await;
                    }
                }
            }
        }

        // Rebuild tasks snapshot after potential updates.
        let snapshot = manager.get_session_snapshot(cowork_session_id)?;
        let session = snapshot.session;
        let tasks_by_id: HashMap<String, CoworkTask> =
            session.tasks.iter().cloned().map(|t| (t.id.clone(), t)).collect();

        // Check completion.
        if session
            .tasks
            .iter()
            .all(|t| matches!(t.state, CoworkTaskState::Completed | CoworkTaskState::Failed | CoworkTaskState::Cancelled))
        {
            let has_failure = session.tasks.iter().any(|t| t.state == CoworkTaskState::Failed);
            let new_state = if has_failure {
                CoworkSessionState::Error
            } else {
                CoworkSessionState::Completed
            };
            manager.update_session_state(cowork_session_id, new_state).await?;
            return Ok(());
        }

        // Pick next runnable task (MVP: sequential).
        let next_task_id = session.task_order.iter().find(|task_id| {
            if let Some(t) = tasks_by_id.get(*task_id) {
                matches!(t.state, CoworkTaskState::Draft | CoworkTaskState::Ready)
                    && deps_completed(t, &tasks_by_id)
                    && t.questions.is_empty().then_some(true).unwrap_or(!t.user_answers.is_empty())
                    && t.state != CoworkTaskState::WaitingUserInput
            } else {
                false
            }
        }).cloned();

        let Some(task_id) = next_task_id else {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            continue;
        };

        let mut task = tasks_by_id
            .get(&task_id)
            .cloned()
            .ok_or_else(|| BitFunError::NotFound(format!("Task not found: {}", task_id)))?;

        // Mark ready if it was draft.
        if task.state == CoworkTaskState::Draft {
            task.state = CoworkTaskState::Ready;
        }

        // Resolve assignee subagent type.
        let roster_member = session
            .roster
            .iter()
            .find(|m| m.id == task.assignee)
            .cloned()
            .ok_or_else(|| BitFunError::Validation(format!("Assignee not found in roster: {}", task.assignee)))?;

        // Run the task.
        let now = chrono::Utc::now().timestamp_millis();
        task.state = CoworkTaskState::Running;
        task.started_at_ms = Some(now);
        task.updated_at_ms = now;
        manager.update_task(cowork_session_id, task.clone()).await?;
        emit_task_state_changed(cowork_session_id, &task).await;

        let prompt = build_task_prompt(
            &session.goal,
            &task,
            &tasks_by_id,
        );

        let parent = SubagentParentInfo {
            tool_call_id: format!("cowork-task-{}", task.id),
            session_id: "cowork".to_string(),
            dialog_turn_id: format!("cowork-run-{}", uuid::Uuid::new_v4()),
        };

        let result = coordinator
            .execute_subagent(
                roster_member.subagent_type.clone(),
                prompt,
                parent,
                None,
                Some(&cancel_token),
            )
            .await;

        let now2 = chrono::Utc::now().timestamp_millis();
        match result {
            Ok(r) => {
                task.state = CoworkTaskState::Completed;
                task.output_text = r.text;
                task.error = None;
                task.updated_at_ms = now2;
                task.finished_at_ms = Some(now2);
                manager.update_task(cowork_session_id, task.clone()).await?;

                emit_cowork_event(
                    "cowork://task-output",
                    serde_json::json!({
                        "coworkSessionId": cowork_session_id,
                        "taskId": task.id,
                        "outputText": task.output_text,
                        "timestamp": now2,
                    }),
                )
                .await;

                emit_task_state_changed(cowork_session_id, &task).await;
            }
            Err(e) => {
                if cancel_token.is_cancelled() {
                    task.state = CoworkTaskState::Cancelled;
                } else {
                    task.state = CoworkTaskState::Failed;
                }
                task.error = Some(e.to_string());
                task.updated_at_ms = now2;
                task.finished_at_ms = Some(now2);
                manager.update_task(cowork_session_id, task.clone()).await?;
                emit_task_state_changed(cowork_session_id, &task).await;
            }
        }
    }
}

fn deps_completed(task: &CoworkTask, tasks_by_id: &HashMap<String, CoworkTask>) -> bool {
    task.deps.iter().all(|dep_id| {
        tasks_by_id
            .get(dep_id)
            .map(|t| t.state == CoworkTaskState::Completed)
            .unwrap_or(false)
    })
}

fn build_task_prompt(goal: &str, task: &CoworkTask, tasks_by_id: &HashMap<String, CoworkTask>) -> String {
    let mut deps_section = String::new();
    for dep_id in &task.deps {
        if let Some(dep) = tasks_by_id.get(dep_id) {
            deps_section.push_str(&format!(
                "\n- {}: {}\n  Output:\n{}\n",
                dep.id,
                dep.title,
                truncate(&dep.output_text, 2000)
            ));
        }
    }

    let answers = if task.user_answers.is_empty() {
        "N/A".to_string()
    } else {
        task.user_answers
            .iter()
            .enumerate()
            .map(|(i, a)| format!("{}. {}", i + 1, a))
            .collect::<Vec<_>>()
            .join("\n")
    };

    format!(
        r#"You are a cowork worker executing one task within a multi-agent plan.

Overall goal:
{goal}

Task:
- id: {task_id}
- title: {title}
- description: {desc}

Dependencies (completed):
{deps_section}

User-provided answers (if any):
{answers}

Deliver:
- Provide the concrete output for this task.
- If you need clarification to proceed, list questions clearly (but still do as much as possible).
"#,
        goal = goal,
        task_id = task.id,
        title = task.title,
        desc = task.description,
        deps_section = if deps_section.is_empty() { "None".to_string() } else { deps_section },
        answers = answers
    )
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    format!("{}...\n[truncated]", &s[..max])
}

async fn emit_task_state_changed(cowork_session_id: &str, task: &CoworkTask) {
    emit_cowork_event(
        "cowork://task-state-changed",
        serde_json::json!({
            "coworkSessionId": cowork_session_id,
            "taskId": task.id,
            "state": task.state,
            "assignee": task.assignee,
            "updatedAtMs": task.updated_at_ms,
            "startedAtMs": task.started_at_ms,
            "finishedAtMs": task.finished_at_ms,
            "error": task.error,
            "timestamp": chrono::Utc::now().timestamp_millis(),
        }),
    )
    .await;
}

async fn emit_cowork_event(event_name: &str, payload: serde_json::Value) {
    if let Err(e) = emit_global_event(BackendEvent::Custom {
        event_name: event_name.to_string(),
        payload,
    })
    .await
    {
        warn!("Failed to emit cowork event: event_name={}, error={}", event_name, e);
    }
}

