use super::Agent;
use async_trait::async_trait;

pub struct BrowserAgent {
    default_tools: Vec<String>,
}

impl BrowserAgent {
    pub fn new() -> Self {
        Self {
            default_tools: vec![
                "WebSearch".to_string(),
                "WebFetch".to_string(),
                "Read".to_string(),
                "Write".to_string(),
                "Edit".to_string(),
                "Grep".to_string(),
                "Glob".to_string(),
                "LS".to_string(),
                "DataFile".to_string(),
                "OfficeDoc".to_string(),
                "AskUserQuestion".to_string(),
            ],
        }
    }
}

#[async_trait]
impl Agent for BrowserAgent {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn id(&self) -> &str {
        "Browser"
    }

    fn name(&self) -> &str {
        "Browser"
    }

    fn description(&self) -> &str {
        "Research-focused agent for full web search, web content extraction, and evidence-based summaries"
    }

    fn prompt_template_name(&self) -> &str {
        "browser_agent"
    }

    fn default_tools(&self) -> Vec<String> {
        self.default_tools.clone()
    }

    fn is_readonly(&self) -> bool {
        false
    }
}
