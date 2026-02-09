use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoworkSessionState {
    Draft,
    Planning,
    Ready,
    Running,
    Paused,
    Completed,
    Cancelled,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoworkTaskState {
    Draft,
    Ready,
    Blocked,
    Running,
    WaitingUserInput,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoworkRosterMember {
    /// Unique member id (stable within the cowork session)
    pub id: String,
    /// Human-friendly role name (Planner/Developer/Reviewer/Researcher...)
    pub role: String,
    /// Optional "agent type" (e.g. eigent-like coordinator_agent/developer_agent...)
    #[serde(default)]
    pub agent_type: Option<String>,
    /// BitFun subagent type id (e.g. "Explore", "FileFinder", custom agents...)
    pub subagent_type: String,
    /// Optional description shown in UI
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoworkTask {
    pub id: String,
    pub title: String,
    pub description: String,
    #[serde(default)]
    pub deps: Vec<String>,

    /// Roster member id
    pub assignee: String,
    pub state: CoworkTaskState,

    #[serde(default)]
    pub questions: Vec<String>,
    #[serde(default)]
    pub user_answers: Vec<String>,

    #[serde(default)]
    pub output_text: String,
    #[serde(default)]
    pub error: Option<String>,

    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    #[serde(default)]
    pub started_at_ms: Option<i64>,
    #[serde(default)]
    pub finished_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoworkSession {
    pub cowork_session_id: String,
    pub goal: String,
    pub state: CoworkSessionState,
    pub roster: Vec<CoworkRosterMember>,

    /// Task ids in display order
    pub task_order: Vec<String>,
    /// Task list (duplicated from internal map for UI convenience)
    pub tasks: Vec<CoworkTask>,

    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoworkSessionSnapshot {
    pub session: CoworkSession,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoworkCreateSessionRequest {
    pub goal: String,
    #[serde(default)]
    pub roster: Vec<CoworkRosterMember>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoworkCreateSessionResponse {
    pub cowork_session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoworkGeneratePlanRequest {
    pub cowork_session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoworkUpdatePlanRequest {
    pub cowork_session_id: String,
    pub tasks: Vec<CoworkTask>,
    #[serde(default)]
    pub task_order: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoworkStartRequest {
    pub cowork_session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoworkPauseRequest {
    pub cowork_session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoworkCancelRequest {
    pub cowork_session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoworkGetStateRequest {
    pub cowork_session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoworkSubmitUserInputRequest {
    pub cowork_session_id: String,
    pub task_id: String,
    pub answers: Vec<String>,
}
