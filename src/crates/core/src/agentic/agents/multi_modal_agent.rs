use super::Agent;
use async_trait::async_trait;

pub struct MultiModalAgent {
    default_tools: Vec<String>,
}

impl MultiModalAgent {
    pub fn new() -> Self {
        Self {
            default_tools: vec![
                "AnalyzeImage".to_string(),
                "Read".to_string(),
                "Write".to_string(),
                "Edit".to_string(),
                "Glob".to_string(),
                "Grep".to_string(),
                "LS".to_string(),
                "WebSearch".to_string(),
                "WebFetch".to_string(),
                "DataFile".to_string(),
                "OfficeDoc".to_string(),
                "AskUserQuestion".to_string(),
            ],
        }
    }
}

#[async_trait]
impl Agent for MultiModalAgent {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn id(&self) -> &str {
        "MultiModal"
    }

    fn name(&self) -> &str {
        "MultiModal"
    }

    fn description(&self) -> &str {
        "Multi-modal assistant for image-centric analysis and cross-media task support"
    }

    fn prompt_template_name(&self) -> &str {
        "multi_modal_agent"
    }

    fn default_tools(&self) -> Vec<String> {
        self.default_tools.clone()
    }

    fn is_readonly(&self) -> bool {
        false
    }
}
