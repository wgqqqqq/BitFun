use super::Agent;
use async_trait::async_trait;

pub struct TaskSummaryAgent {
    default_tools: Vec<String>,
}

impl TaskSummaryAgent {
    pub fn new() -> Self {
        Self {
            default_tools: vec![
                "Read".to_string(),
                "Grep".to_string(),
                "Glob".to_string(),
            ],
        }
    }
}

#[async_trait]
impl Agent for TaskSummaryAgent {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn id(&self) -> &str {
        "TaskSummary"
    }

    fn name(&self) -> &str {
        "TaskSummary"
    }

    fn description(&self) -> &str {
        "Agent specialized in compressing scattered implementation details into concise task summaries and handoff notes"
    }

    fn prompt_template_name(&self) -> &str {
        "task_summary_agent"
    }

    fn default_tools(&self) -> Vec<String> {
        self.default_tools.clone()
    }

    fn is_readonly(&self) -> bool {
        true
    }
}
