use super::Agent;
use async_trait::async_trait;

pub struct QuestionConfirmAgent {
    default_tools: Vec<String>,
}

impl QuestionConfirmAgent {
    pub fn new() -> Self {
        Self {
            default_tools: vec![
                "AskUserQuestion".to_string(),
                "LS".to_string(),
                "Read".to_string(),
                "Grep".to_string(),
                "Glob".to_string(),
            ],
        }
    }
}

#[async_trait]
impl Agent for QuestionConfirmAgent {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn id(&self) -> &str {
        "QuestionConfirm"
    }

    fn name(&self) -> &str {
        "QuestionConfirm"
    }

    fn description(&self) -> &str {
        "Agent specialized in clarifying ambiguous requests and collecting missing constraints before implementation starts"
    }

    fn prompt_template_name(&self) -> &str {
        "question_confirm_agent"
    }

    fn default_tools(&self) -> Vec<String> {
        self.default_tools.clone()
    }

    fn is_readonly(&self) -> bool {
        true
    }
}
