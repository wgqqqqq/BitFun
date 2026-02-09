use crate::agentic::coordination::ConversationCoordinator;
use crate::agentic::cowork::types::CoworkRosterMember;
use crate::agentic::tools::pipeline::SubagentParentInfo;
use crate::util::errors::{BitFunError, BitFunResult};
use log::{debug, warn};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanTaskDraft {
    pub title: String,
    pub description: String,
    #[serde(default)]
    pub deps: Vec<String>,
    #[serde(default)]
    pub assignee_role: Option<String>,
    /// `read_only` or `workspace_write` (optional; defaults to workspace_write)
    #[serde(default)]
    pub resource_mode: Option<String>,
    #[serde(default)]
    pub questions: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanDraft {
    pub tasks: Vec<PlanTaskDraft>,
}

pub async fn generate_plan_via_planner(
    coordinator: Arc<ConversationCoordinator>,
    planner_subagent_type: String,
    goal: String,
    roster: Vec<CoworkRosterMember>,
) -> BitFunResult<PlanDraft> {
    let prompt = build_decompose_prompt(&goal, &roster);
    debug!(
        "Cowork generate_plan_via_planner: planner_subagent_type={}",
        planner_subagent_type
    );

    // This is not a tool call. Still provide parent info for consistent event metadata if needed.
    let parent = SubagentParentInfo {
        tool_call_id: "cowork-planning".to_string(),
        session_id: "cowork".to_string(),
        dialog_turn_id: format!("cowork-planning-{}", uuid::Uuid::new_v4()),
    };

    let result = coordinator
        .execute_subagent(planner_subagent_type, prompt, parent, None, None)
        .await?;

    parse_plan_json(&result.text)
}

fn build_decompose_prompt(goal: &str, roster: &[CoworkRosterMember]) -> String {
    let roster_lines = roster
        .iter()
        .map(|m| {
            let agent_type = m
                .agent_type
                .as_deref()
                .map(|s| format!(", agentType: {}", s))
                .unwrap_or_default();
            format!(
                "- role: {}, id: {}, subagentType: {}{}",
                m.role, m.id, m.subagent_type, agent_type
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        r#"You are the Planner in a multi-agent cowork session.

Goal:
{goal}

Available roles (you MUST assign each task to one of these roles by role name):
{roster_lines}

Your job:
- Decompose the goal into a small set of actionable tasks (5-12 tasks).
- Tasks should be concrete and independently executable.
- Prefer parallelizable tasks and keep dependencies minimal.
- Distribute tasks across roles when reasonable.
- Add dependencies via task indices (0-based) to express ordering constraints.
- For each task, optionally add questions if human input is needed before running.

Output STRICT JSON ONLY (no markdown, no commentary) with this schema:
{{
  "tasks": [
    {{
      "title": "string",
      "description": "string",
      "deps": [0, 2],
      "assigneeRole": "Planner|Developer|Reviewer|Researcher|...",
      "resourceMode": "read_only|workspace_write",
      "questions": ["string", "string"]
    }}
  ]
}}

Notes:
- deps are indices into the tasks array, not ids.
- Keep descriptions short but precise.
"#
    )
}

fn parse_plan_json(model_text: &str) -> BitFunResult<PlanDraft> {
    // Extract JSON object from possibly noisy output.
    let start = model_text.find('{').ok_or_else(|| {
        BitFunError::AIClient("Planner output did not contain JSON object".to_string())
    })?;
    let end = model_text.rfind('}').ok_or_else(|| {
        BitFunError::AIClient("Planner output did not contain JSON object end".to_string())
    })?;
    let json_str = &model_text[start..=end];

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RawPlan {
        tasks: Vec<RawTask>,
    }
    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RawTask {
        title: String,
        description: String,
        #[serde(default)]
        deps: Vec<usize>,
        #[serde(default)]
        assignee_role: Option<String>,
        #[serde(default)]
        resource_mode: Option<String>,
        #[serde(default)]
        questions: Option<Vec<String>>,
    }

    let raw: RawPlan = serde_json::from_str(json_str).map_err(|e| {
        warn!("Failed to parse planner JSON: {}", e);
        BitFunError::AIClient(format!("Failed to parse plan JSON: {}", e))
    })?;

    if raw.tasks.is_empty() {
        return Err(BitFunError::AIClient(
            "Planner returned empty tasks list".to_string(),
        ));
    }

    // Convert deps indices to temporary string ids like "idx:3" which will later be resolved.
    // The manager will rewrite deps to actual task ids after it assigns ids.
    let tasks = raw
        .tasks
        .into_iter()
        .map(|t| PlanTaskDraft {
            title: t.title,
            description: t.description,
            deps: t.deps.into_iter().map(|i| format!("idx:{}", i)).collect(),
            assignee_role: t.assignee_role,
            resource_mode: t.resource_mode,
            questions: t.questions,
        })
        .collect::<Vec<_>>();

    Ok(PlanDraft { tasks })
}
