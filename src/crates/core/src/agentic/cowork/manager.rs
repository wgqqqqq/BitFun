use crate::agentic::coordination::ConversationCoordinator;
use crate::agentic::cowork::planning::{generate_plan_via_planner, PlanDraft};
use crate::agentic::cowork::scheduler::run_scheduler_loop;
use crate::agentic::cowork::types::*;
use crate::infrastructure::events::{emit_global_event, BackendEvent};
use crate::util::errors::{BitFunError, BitFunResult};
use dashmap::DashMap;
use log::{debug, warn};
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct CoworkRuntime {
    cancel_token: CancellationToken,
    /// Ensures only one scheduler is running per session.
    scheduler_lock: Arc<Mutex<()>>,
}

/// Cowork manager (in-memory MVP).
///
/// Notes:
/// - Platform-agnostic: no Tauri usage, communicates via BackendEventSystem custom events.
/// - Persistence: currently in-memory only (can be extended later).
pub struct CoworkManager {
    sessions: DashMap<String, CoworkSession>,
    runtimes: DashMap<String, CoworkRuntime>,
}

impl CoworkManager {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
            runtimes: DashMap::new(),
        }
    }

    pub fn get_session_snapshot(&self, cowork_session_id: &str) -> BitFunResult<CoworkSessionSnapshot> {
        let session = self
            .sessions
            .get(cowork_session_id)
            .ok_or_else(|| BitFunError::NotFound(format!("Cowork session not found: {}", cowork_session_id)))?
            .clone();
        Ok(CoworkSessionSnapshot { session })
    }

    pub async fn create_session(&self, req: CoworkCreateSessionRequest) -> BitFunResult<CoworkCreateSessionResponse> {
        let now = chrono::Utc::now().timestamp_millis();
        let cowork_session_id = format!("cowork-{}", uuid::Uuid::new_v4());

        let roster = if req.roster.is_empty() {
            vec![
                CoworkRosterMember {
                    id: "planner".to_string(),
                    role: "Planner".to_string(),
                    agent_type: Some("task_agent".to_string()),
                    subagent_type: "Explore".to_string(),
                    description: "Decompose goals into tasks".to_string(),
                },
                CoworkRosterMember {
                    id: "developer".to_string(),
                    role: "Developer".to_string(),
                    agent_type: Some("developer_agent".to_string()),
                    subagent_type: "Explore".to_string(),
                    description: "Execute implementation tasks".to_string(),
                },
                CoworkRosterMember {
                    id: "reviewer".to_string(),
                    role: "Reviewer".to_string(),
                    agent_type: Some("coordinator_agent".to_string()),
                    subagent_type: "Explore".to_string(),
                    description: "Review outputs and catch issues".to_string(),
                },
                CoworkRosterMember {
                    id: "researcher".to_string(),
                    role: "Researcher".to_string(),
                    agent_type: Some("browser_agent".to_string()),
                    subagent_type: "Explore".to_string(),
                    description: "Investigate unknowns and gather context".to_string(),
                },
            ]
        } else {
            req.roster
        };

        let session = CoworkSession {
            cowork_session_id: cowork_session_id.clone(),
            goal: req.goal,
            state: CoworkSessionState::Draft,
            roster,
            task_order: vec![],
            tasks: vec![],
            created_at_ms: now,
            updated_at_ms: now,
        };

        self.sessions.insert(cowork_session_id.clone(), session.clone());
        self.runtimes.insert(
            cowork_session_id.clone(),
            CoworkRuntime {
                cancel_token: CancellationToken::new(),
                scheduler_lock: Arc::new(Mutex::new(())),
            },
        );

        emit_cowork_event(
            "cowork://session-created",
            serde_json::json!({
                "coworkSessionId": cowork_session_id,
                "goal": session.goal,
                "roster": session.roster,
                "timestamp": now,
            }),
        )
        .await;

        Ok(CoworkCreateSessionResponse { cowork_session_id: session.cowork_session_id })
    }

    pub async fn generate_plan(
        &self,
        coordinator: Arc<ConversationCoordinator>,
        req: CoworkGeneratePlanRequest,
    ) -> BitFunResult<Vec<CoworkTask>> {
        let now = chrono::Utc::now().timestamp_millis();

        let mut session = self
            .sessions
            .get(&req.cowork_session_id)
            .ok_or_else(|| BitFunError::NotFound(format!("Cowork session not found: {}", req.cowork_session_id)))?
            .clone();

        session.state = CoworkSessionState::Planning;
        session.updated_at_ms = now;
        self.sessions.insert(req.cowork_session_id.clone(), session.clone());

        emit_cowork_event(
            "cowork://session-state",
            serde_json::json!({
                "coworkSessionId": req.cowork_session_id,
                "state": session.state,
                "timestamp": now,
            }),
        )
        .await;

        let planner = session
            .roster
            .iter()
            .find(|m| m.id == "planner" || m.role.to_lowercase() == "planner")
            .cloned()
            .unwrap_or_else(|| session.roster.first().cloned().unwrap());

        let draft: PlanDraft = generate_plan_via_planner(
            coordinator,
            planner.subagent_type,
            session.goal.clone(),
            session.roster.clone(),
        )
        .await?;

        let mut tasks: Vec<CoworkTask> = draft
            .tasks
            .into_iter()
            .enumerate()
            .map(|(idx, t)| {
                let id = format!("task-{}-{}", idx + 1, uuid::Uuid::new_v4());
                let assignee = resolve_assignee(&session.roster, t.assignee_role.as_deref())
                    .unwrap_or_else(|| "developer".to_string());
                CoworkTask {
                    id,
                    title: t.title,
                    description: t.description,
                    deps: t.deps, // will be resolved from idx:N -> task ids below
                    assignee,
                    state: CoworkTaskState::Draft,
                    questions: t.questions.unwrap_or_default(),
                    user_answers: vec![],
                    output_text: String::new(),
                    error: None,
                    created_at_ms: now,
                    updated_at_ms: now,
                    started_at_ms: None,
                    finished_at_ms: None,
                }
            })
            .collect();

        // Resolve planner deps (idx:N) to actual task ids.
        let id_by_index = tasks.iter().map(|t| t.id.clone()).collect::<Vec<_>>();
        for task in &mut tasks {
            let mut resolved = Vec::new();
            for dep in &task.deps {
                if let Some(idx_str) = dep.strip_prefix("idx:") {
                    if let Ok(i) = idx_str.parse::<usize>() {
                        if let Some(task_id) = id_by_index.get(i) {
                            resolved.push(task_id.clone());
                            continue;
                        }
                    }
                }
                resolved.push(dep.clone());
            }
            task.deps = resolved;
        }

        let task_order = tasks.iter().map(|t| t.id.clone()).collect::<Vec<_>>();

        session.tasks = tasks.clone();
        session.task_order = task_order.clone();
        session.state = CoworkSessionState::Ready;
        session.updated_at_ms = now;
        self.sessions.insert(req.cowork_session_id.clone(), session.clone());

        emit_cowork_event(
            "cowork://plan-generated",
            serde_json::json!({
                "coworkSessionId": req.cowork_session_id,
                "tasks": session.tasks,
                "taskOrder": session.task_order,
                "timestamp": now,
            }),
        )
        .await;

        Ok(tasks)
    }

    pub async fn update_plan(&self, req: CoworkUpdatePlanRequest) -> BitFunResult<()> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut session = self
            .sessions
            .get(&req.cowork_session_id)
            .ok_or_else(|| BitFunError::NotFound(format!("Cowork session not found: {}", req.cowork_session_id)))?
            .clone();

        // Basic validation: deps must reference existing tasks.
        let task_ids: std::collections::HashSet<String> =
            req.tasks.iter().map(|t| t.id.clone()).collect();
        for t in &req.tasks {
            for dep in &t.deps {
                if !task_ids.contains(dep) {
                    return Err(BitFunError::Validation(format!(
                        "Task '{}' depends on unknown task id '{}'",
                        t.id, dep
                    )));
                }
            }
        }

        session.tasks = req.tasks;
        session.task_order = if req.task_order.is_empty() {
            session.tasks.iter().map(|t| t.id.clone()).collect()
        } else {
            req.task_order
        };
        session.state = CoworkSessionState::Ready;
        session.updated_at_ms = now;
        self.sessions.insert(req.cowork_session_id.clone(), session.clone());

        emit_cowork_event(
            "cowork://plan-updated",
            serde_json::json!({
                "coworkSessionId": req.cowork_session_id,
                "tasks": session.tasks,
                "taskOrder": session.task_order,
                "timestamp": now,
            }),
        )
        .await;

        Ok(())
    }

    pub async fn start(&self, coordinator: Arc<ConversationCoordinator>, req: CoworkStartRequest) -> BitFunResult<()> {
        let runtime = self
            .runtimes
            .get(&req.cowork_session_id)
            .ok_or_else(|| BitFunError::NotFound(format!("Cowork session runtime not found: {}", req.cowork_session_id)))?
            .clone();

        // Ensure only one scheduler loop runs per cowork session.
        let _guard = runtime.scheduler_lock.lock().await;

        let snapshot = self.get_session_snapshot(&req.cowork_session_id)?;
        if matches!(snapshot.session.state, CoworkSessionState::Running) {
            debug!("Cowork session already running: cowork_session_id={}", req.cowork_session_id);
            return Ok(());
        }

        self.update_session_state(&req.cowork_session_id, CoworkSessionState::Running)
            .await?;

        let manager = get_global_cowork_manager();
        let cowork_session_id = req.cowork_session_id.clone();
        let cancel_token = runtime.cancel_token.clone();

        tokio::spawn(async move {
            if let Err(e) = run_scheduler_loop(manager.as_ref(), coordinator, &cowork_session_id, cancel_token).await {
                warn!("Cowork scheduler failed: cowork_session_id={}, error={}", cowork_session_id, e);
                let _ = manager
                    .update_session_state(&cowork_session_id, CoworkSessionState::Error)
                    .await;
            }
        });

        Ok(())
    }

    pub async fn pause(&self, req: CoworkPauseRequest) -> BitFunResult<()> {
        self.update_session_state(&req.cowork_session_id, CoworkSessionState::Paused)
            .await
    }

    pub async fn cancel(&self, req: CoworkCancelRequest) -> BitFunResult<()> {
        if let Some(rt) = self.runtimes.get(&req.cowork_session_id) {
            rt.cancel_token.cancel();
        }
        self.update_session_state(&req.cowork_session_id, CoworkSessionState::Cancelled)
            .await
    }

    pub async fn submit_user_input(&self, req: CoworkSubmitUserInputRequest) -> BitFunResult<()> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut session = self
            .sessions
            .get(&req.cowork_session_id)
            .ok_or_else(|| BitFunError::NotFound(format!("Cowork session not found: {}", req.cowork_session_id)))?
            .clone();

        let mut changed = false;
        for t in &mut session.tasks {
            if t.id == req.task_id {
                t.user_answers = req.answers.clone();
                if t.state == CoworkTaskState::WaitingUserInput {
                    t.state = CoworkTaskState::Ready;
                }
                t.updated_at_ms = now;
                changed = true;
                break;
            }
        }

        if !changed {
            return Err(BitFunError::NotFound(format!(
                "Task not found: {}",
                req.task_id
            )));
        }

        session.updated_at_ms = now;
        self.sessions.insert(req.cowork_session_id.clone(), session.clone());

        emit_cowork_event(
            "cowork://plan-updated",
            serde_json::json!({
                "coworkSessionId": req.cowork_session_id,
                "tasks": session.tasks,
                "taskOrder": session.task_order,
                "timestamp": now,
            }),
        )
        .await;

        Ok(())
    }

    pub async fn update_task(&self, cowork_session_id: &str, task: CoworkTask) -> BitFunResult<()> {
        let now = chrono::Utc::now().timestamp_millis();
        let task_id = task.id.clone();
        let mut session = self
            .sessions
            .get(cowork_session_id)
            .ok_or_else(|| BitFunError::NotFound(format!("Cowork session not found: {}", cowork_session_id)))?
            .clone();

        let mut found = false;
        for t in &mut session.tasks {
            if t.id == task_id {
                *t = task.clone();
                t.updated_at_ms = now;
                found = true;
                break;
            }
        }
        if !found {
            return Err(BitFunError::NotFound(format!(
                "Task not found in session: {}",
                task_id
            )));
        }

        session.updated_at_ms = now;
        self.sessions.insert(cowork_session_id.to_string(), session);
        Ok(())
    }

    pub async fn update_session_state(
        &self,
        cowork_session_id: &str,
        state: CoworkSessionState,
    ) -> BitFunResult<()> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut session = self
            .sessions
            .get(cowork_session_id)
            .ok_or_else(|| BitFunError::NotFound(format!("Cowork session not found: {}", cowork_session_id)))?
            .clone();
        session.state = state;
        session.updated_at_ms = now;
        self.sessions.insert(cowork_session_id.to_string(), session);

        emit_cowork_event(
            "cowork://session-state",
            serde_json::json!({
                "coworkSessionId": cowork_session_id,
                "state": state,
                "timestamp": now,
            }),
        )
        .await;
        Ok(())
    }
}

impl Default for CoworkManager {
    fn default() -> Self {
        Self::new()
    }
}

static GLOBAL_COWORK_MANAGER: OnceLock<Arc<CoworkManager>> = OnceLock::new();

pub fn get_global_cowork_manager() -> Arc<CoworkManager> {
    GLOBAL_COWORK_MANAGER
        .get_or_init(|| Arc::new(CoworkManager::new()))
        .clone()
}

fn resolve_assignee(roster: &[CoworkRosterMember], assignee_role: Option<&str>) -> Option<String> {
    let role = assignee_role?;
    let role_lc = role.to_lowercase();
    roster
        .iter()
        .find(|m| m.role.to_lowercase() == role_lc || m.id.to_lowercase() == role_lc)
        .map(|m| m.id.clone())
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
