use super::Agent;
use async_trait::async_trait;

pub struct DocumentAgent {
    default_tools: Vec<String>,
}

impl DocumentAgent {
    pub fn new() -> Self {
        Self {
            default_tools: vec![
                "Read".to_string(),
                "Write".to_string(),
                "Edit".to_string(),
                "Delete".to_string(),
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
impl Agent for DocumentAgent {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn id(&self) -> &str {
        "Document"
    }

    fn name(&self) -> &str {
        "Document"
    }

    fn description(&self) -> &str {
        "Document specialist for drafting, rewriting, and maintaining structured work artifacts"
    }

    fn prompt_template_name(&self) -> &str {
        "document_agent"
    }

    fn default_tools(&self) -> Vec<String> {
        self.default_tools.clone()
    }

    fn is_readonly(&self) -> bool {
        false
    }
}
