use crate::agentic::coordination::ConversationCoordinator;
use crate::agentic::cowork::types::{CoworkSessionState, CoworkTask, CoworkTaskState};
use crate::agentic::tools::pipeline::SubagentParentInfo;
use crate::infrastructure::events::{emit_global_event, BackendEvent};
use crate::util::errors::{BitFunError, BitFunResult};
use log::{debug, warn};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use super::manager::{get_global_cowork_manager, CoworkManager};
use super::types::CoworkTaskResourceMode;

pub async fn run_scheduler_loop(
    manager: &CoworkManager,
    coordinator: Arc<ConversationCoordinator>,
    cowork_session_id: &str,
    cancel_token: CancellationToken,
) -> BitFunResult<()> {
    debug!("Cowork scheduler loop started: cowork_session_id={}", cowork_session_id);
    let mut join_set: JoinSet<()> = JoinSet::new();

    loop {
        // Drain completed task futures (avoid silent panics).
        loop {
            let done = tokio::time::timeout(std::time::Duration::from_millis(0), join_set.join_next()).await;
            match done {
                Ok(Some(Ok(()))) => continue,
                Ok(Some(Err(e))) => {
                    warn!("Cowork task future failed: cowork_session_id={}, error={}", cowork_session_id, e);
                    continue;
                }
                Ok(None) => break,
                Err(_) => break,
            }
        }

        if cancel_token.is_cancelled() {
            join_set.abort_all();
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
                join_set.abort_all();
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

        // Rebuild tasks snapshot after potential HITL updates.
        let snapshot = manager.get_session_snapshot(cowork_session_id)?;
        let session = snapshot.session;
        let tasks_by_id: HashMap<String, CoworkTask> =
            session.tasks.iter().cloned().map(|t| (t.id.clone(), t)).collect();

        // Permanently block tasks whose dependencies failed/cancelled.
        // Without this, the scheduler can stall forever (no runnable tasks, but not all terminal).
        for task_id in &session.task_order {
            if let Some(mut t) = tasks_by_id.get(task_id).cloned() {
                if matches!(t.state, CoworkTaskState::Draft | CoworkTaskState::Ready)
                    && deps_failed(&t, &tasks_by_id).is_some()
                {
                    if t.state != CoworkTaskState::Blocked {
                        let dep_id = deps_failed(&t, &tasks_by_id).unwrap_or_else(|| "unknown".to_string());
                        t.state = CoworkTaskState::Blocked;
                        t.error = Some(format!("Blocked: dependency '{}' failed or was cancelled", dep_id));
                        t.updated_at_ms = chrono::Utc::now().timestamp_millis();
                        manager.update_task(cowork_session_id, t.clone()).await?;
                        emit_task_state_changed(cowork_session_id, &t).await;
                    }
                }
            }
        }

        // Rebuild tasks snapshot after potential blocked updates.
        let snapshot = manager.get_session_snapshot(cowork_session_id)?;
        let session = snapshot.session;
        let tasks_by_id: HashMap<String, CoworkTask> =
            session.tasks.iter().cloned().map(|t| (t.id.clone(), t)).collect();

        // Check completion.
        if session
            .tasks
            .iter()
            .all(|t| {
                matches!(
                    t.state,
                    CoworkTaskState::Completed
                        | CoworkTaskState::Failed
                        | CoworkTaskState::Cancelled
                        | CoworkTaskState::Blocked
                )
            })
        {
            let has_failure = session
                .tasks
                .iter()
                .any(|t| matches!(t.state, CoworkTaskState::Failed | CoworkTaskState::Blocked));
            let new_state = if has_failure {
                CoworkSessionState::Error
            } else {
                CoworkSessionState::Completed
            };
            manager.update_session_state(cowork_session_id, new_state).await?;
            return Ok(());
        }

        // Parallel scheduling:
        // - runnable tasks: deps completed + HITL satisfied
        // - max_parallel: global cap
        // - workspace_write tasks are serialized (coarse write lock)
        let mut running_total = 0usize;
        let mut has_workspace_write_running = false;
        for t in tasks_by_id.values() {
            if t.state == CoworkTaskState::Running {
                running_total += 1;
                if t.resource_mode == CoworkTaskResourceMode::WorkspaceWrite {
                    has_workspace_write_running = true;
                }
            }
        }

        let max_parallel = std::cmp::max(1, session.roster.len());
        let mut scheduled_any = false;

        for task_id in &session.task_order {
            if running_total >= max_parallel {
                break;
            }

            let Some(t0) = tasks_by_id.get(task_id).cloned() else { continue };
            if !matches!(t0.state, CoworkTaskState::Draft | CoworkTaskState::Ready) {
                continue;
            }
            if !deps_completed(&t0, &tasks_by_id) {
                continue;
            }
            let hitl_ok = if t0.questions.is_empty() {
                true
            } else {
                !t0.user_answers.is_empty() && t0.state != CoworkTaskState::WaitingUserInput
            };
            if !hitl_ok {
                continue;
            }
            if t0.resource_mode == CoworkTaskResourceMode::WorkspaceWrite && has_workspace_write_running {
                continue;
            }

            let mut task = t0.clone();

            // Resolve assignee subagent type.
            let roster_member = session
                .roster
                .iter()
                .find(|m| m.id == task.assignee)
                .cloned()
                .ok_or_else(|| {
                    BitFunError::Validation(format!("Assignee not found in roster: {}", task.assignee))
                })?;

            // Mark ready if it was draft, then run.
            if task.state == CoworkTaskState::Draft {
                task.state = CoworkTaskState::Ready;
            }

            let now = chrono::Utc::now().timestamp_millis();
            task.state = CoworkTaskState::Running;
            task.started_at_ms = Some(now);
            task.updated_at_ms = now;
            manager.update_task(cowork_session_id, task.clone()).await?;
            emit_task_state_changed(cowork_session_id, &task).await;

            running_total += 1;
            scheduled_any = true;
            if task.resource_mode == CoworkTaskResourceMode::WorkspaceWrite {
                has_workspace_write_running = true;
            }

            let prompt = build_task_prompt(&session.goal, &task, &tasks_by_id);
            let cowork_session_id_owned = cowork_session_id.to_string();
            let coordinator = coordinator.clone();
            let cancel_token = cancel_token.clone();
            let subagent_type = roster_member.subagent_type.clone();
            let task_id_owned = task.id.clone();
            let task_for_run = task.clone();

            join_set.spawn(async move {
                let manager = get_global_cowork_manager();

                let parent = SubagentParentInfo {
                    tool_call_id: format!("cowork-task-{}", task_id_owned),
                    session_id: "cowork".to_string(),
                    dialog_turn_id: format!("cowork-run-{}", uuid::Uuid::new_v4()),
                };

                let result = coordinator
                    .execute_subagent(subagent_type, prompt, parent, None, Some(&cancel_token))
                    .await;

                let now2 = chrono::Utc::now().timestamp_millis();
                let mut task = task_for_run;
                match result {
                    Ok(r) => {
                        task.state = CoworkTaskState::Completed;
                        task.output_text = r.text;
                        task.error = None;
                        task.updated_at_ms = now2;
                        task.finished_at_ms = Some(now2);
                        if let Err(e) = manager.update_task(&cowork_session_id_owned, task.clone()).await {
                            warn!(
                                "Failed to update cowork task: cowork_session_id={}, task_id={}, error={}",
                                cowork_session_id_owned, task.id, e
                            );
                            return;
                        }

                        emit_cowork_event(
                            "cowork://task-output",
                            serde_json::json!({
                                "coworkSessionId": cowork_session_id_owned,
                                "taskId": task.id,
                                "outputText": task.output_text,
                                "timestamp": now2,
                            }),
                        )
                        .await;

                        emit_task_state_changed(&cowork_session_id_owned, &task).await;
                    }
                    Err(e) => {
                        if cancel_token.is_cancelled() || matches!(e, BitFunError::Cancelled(_)) {
                            task.state = CoworkTaskState::Cancelled;
                        } else {
                            task.state = CoworkTaskState::Failed;
                        }
                        task.error = Some(e.to_string());
                        task.updated_at_ms = now2;
                        task.finished_at_ms = Some(now2);
                        if let Err(e) = manager.update_task(&cowork_session_id_owned, task.clone()).await {
                            warn!(
                                "Failed to update cowork task: cowork_session_id={}, task_id={}, error={}",
                                cowork_session_id_owned, task.id, e
                            );
                            return;
                        }
                        emit_task_state_changed(&cowork_session_id_owned, &task).await;
                    }
                }
            });
        }

        if !scheduled_any {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
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

fn deps_failed(task: &CoworkTask, tasks_by_id: &HashMap<String, CoworkTask>) -> Option<String> {
    for dep_id in &task.deps {
        if let Some(t) = tasks_by_id.get(dep_id) {
            if matches!(t.state, CoworkTaskState::Failed | CoworkTaskState::Cancelled | CoworkTaskState::Blocked) {
                return Some(dep_id.clone());
            }
        }
    }
    None
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
- resourceMode: {resource_mode}

Dependencies (completed):
{deps_section}

User-provided answers (if any):
{answers}

Deliver:
- Provide the concrete output for this task.
- If resourceMode is `read_only`, DO NOT modify the workspace (no file writes, no destructive commands). Focus on analysis/research/review output.
- If you need clarification to proceed, list questions clearly (but still do as much as possible).
"#,
        goal = goal,
        task_id = task.id,
        title = task.title,
        desc = task.description,
        resource_mode = match task.resource_mode {
            CoworkTaskResourceMode::ReadOnly => "read_only",
            CoworkTaskResourceMode::WorkspaceWrite => "workspace_write",
        },
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
