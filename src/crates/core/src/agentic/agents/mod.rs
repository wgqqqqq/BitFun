//! Mode system for BitFun
//!
//! Provides flexible mode selection with different system prompts and tool sets

mod definitions;
mod prompt_builder;
mod registry;

use crate::agentic::tools::framework::ToolExposure;
use crate::util::errors::{BitFunError, BitFunResult};
use async_trait::async_trait;
pub use definitions::custom::{CustomSubagent, CustomSubagentKind};
pub use definitions::hidden::{CodeReviewAgent, DeepReviewAgent, GenerateDocAgent, InitAgent};
pub use definitions::modes::{
    AgenticMode, ClawMode, CoworkMode, DebugMode, DeepResearchMode, PlanMode, TeamMode,
};
pub use definitions::review::{
    ArchitectureReviewerAgent, BusinessLogicReviewerAgent, FrontendReviewerAgent,
    PerformanceReviewerAgent, ReviewFixerAgent, ReviewJudgeAgent, SecurityReviewerAgent,
};
pub use definitions::shared::ReadonlySubagent;
pub use definitions::subagents::{
    ComputerUseMode, ExploreAgent, FileFinderAgent, ResearchSpecialistAgent,
};
use indexmap::IndexMap;
pub use prompt_builder::{
    PromptBuilder, PromptBuilderContext, RemoteExecutionHints, RequestContextPolicy,
    RequestContextSection,
};
pub use registry::catalog::{builtin_agent_specs, BuiltinAgentSpec};
pub use registry::types::{
    AgentCategory, AgentInfo, AgentToolPolicy, CustomSubagentConfig, SubAgentSource,
    SubagentListScope, SubagentQueryContext,
};
pub use registry::visibility::{
    BuiltinSubagentExposure, SubagentVisibilityPolicy, SubagentVisibilitySummary,
};
pub use registry::{get_agent_registry, AgentRegistry, CustomSubagentDetail};
use std::any::Any;
use std::path::Path;

// Include embedded prompts generated at compile time
include!(concat!(env!("OUT_DIR"), "/embedded_agents_prompt.rs"));

pub type AgentToolPolicyOverrides = IndexMap<String, ToolExposure>;

static EMPTY_AGENT_TOOL_POLICY_OVERRIDES: std::sync::LazyLock<AgentToolPolicyOverrides> =
    std::sync::LazyLock::new(AgentToolPolicyOverrides::default);

/// Agent trait defining the interface for all agents
#[async_trait]
pub trait Agent: Send + Sync + 'static {
    /// downcast to specific type
    fn as_any(&self) -> &dyn Any;

    /// Unique identifier for the agent
    fn id(&self) -> &str;

    /// Human-readable name
    fn name(&self) -> &str;

    /// Description of what the agent does
    fn description(&self) -> &str;

    /// Prompt template name for the agent.
    fn prompt_template_name(&self, model_name: Option<&str>) -> &str;

    fn system_reminder_template_name(&self) -> Option<&str> {
        None // by default, no system reminder
    }

    fn request_context_policy(&self) -> RequestContextPolicy {
        RequestContextPolicy::default()
    }

    /// Build the system prompt for this agent
    async fn build_prompt(&self, context: &PromptBuilderContext) -> BitFunResult<String> {
        let prompt_components = PromptBuilder::new(context.clone());
        let template_name = self.prompt_template_name(context.model_name.as_deref());
        let overlay_template = std::env::var("BITFUN_HARNESS_DIR")
            .ok()
            .and_then(|dir| load_harness_prompt_template(Path::new(&dir), template_name).ok())
            .flatten();
        let embedded_template = || {
            get_embedded_prompt(template_name).ok_or_else(|| {
                BitFunError::Agent(format!("{} not found in embedded files", template_name))
            })
        };
        let system_prompt_template = overlay_template
            .as_deref()
            .map(Ok)
            .unwrap_or_else(embedded_template)?;

        let prompt = prompt_components
            .build_prompt_from_template(system_prompt_template)
            .await?;

        Ok(prompt)
    }

    /// Get the system prompt for this agent
    async fn get_system_prompt(
        &self,
        context: Option<&PromptBuilderContext>,
    ) -> BitFunResult<String> {
        if let Some(context) = context {
            self.build_prompt(context).await
        } else {
            Err(BitFunError::Agent(
                "Prompt build context is required".to_string(),
            ))
        }
    }

    /// Get the system reminder for this agent, only used for modes
    /// system_reminder will be appended to the user_query
    /// This is not necessary for all modes
    /// index is not used for now (Cursor first time enter plan mode and keep plan mode will use different reminder)
    async fn get_system_reminder(&self, _index: usize) -> BitFunResult<String> {
        if let Some(system_reminder_template_name) = self.system_reminder_template_name() {
            let system_reminder =
                get_embedded_prompt(system_reminder_template_name).ok_or_else(|| {
                    BitFunError::Agent(format!(
                        "{} not found in embedded files",
                        system_reminder_template_name
                    ))
                })?;
            Ok(system_reminder.to_string())
        } else {
            Ok("".to_string())
        }
    }

    /// Get the list of default tools for this agent
    fn default_tools(&self) -> Vec<String>;

    /// Per-agent exposure overrides for allowed tools.
    ///
    /// Tools omitted here inherit their tool-defined default exposure.
    fn tool_exposure_overrides(&self) -> &AgentToolPolicyOverrides {
        &EMPTY_AGENT_TOOL_POLICY_OVERRIDES
    }

    /// Whether this agent is read-only (prevents file modifications)
    fn is_readonly(&self) -> bool {
        false
    }
}

fn load_harness_prompt_template(
    harness_dir: &Path,
    template_name: &str,
) -> std::io::Result<Option<String>> {
    let prompt_path = harness_dir
        .join("prompts")
        .join(format!("{}.md", template_name));
    if !prompt_path.is_file() {
        return Ok(None);
    }
    std::fs::read_to_string(prompt_path).map(Some)
}

#[cfg(test)]
mod harness_overlay_tests {
    use super::{load_harness_prompt_template, Agent, PromptBuilderContext};
    use async_trait::async_trait;
    use std::path::PathBuf;

    struct OverlayTestAgent;

    #[async_trait]
    impl Agent for OverlayTestAgent {
        fn as_any(&self) -> &dyn std::any::Any {
            self
        }

        fn id(&self) -> &str {
            "overlay-test"
        }

        fn name(&self) -> &str {
            "Overlay Test"
        }

        fn description(&self) -> &str {
            "Test agent"
        }

        fn prompt_template_name(&self, _model_name: Option<&str>) -> &str {
            "overlay_test"
        }

        fn default_tools(&self) -> Vec<String> {
            Vec::new()
        }
    }

    #[test]
    fn loads_harness_prompt_template_when_present() {
        let root = unique_temp_root();
        let prompts = root.join("prompts");
        std::fs::create_dir_all(&prompts).expect("create prompts dir");
        std::fs::write(prompts.join("overlay_test.md"), "overlay").expect("write prompt");

        let loaded = load_harness_prompt_template(&root, "overlay_test")
            .expect("load should succeed")
            .expect("prompt should exist");

        std::fs::remove_dir_all(root).ok();
        assert_eq!(loaded, "overlay");
    }

    #[tokio::test]
    async fn build_prompt_prefers_harness_overlay_template() {
        let root = unique_temp_root();
        let prompts = root.join("prompts");
        std::fs::create_dir_all(&prompts).expect("create prompts dir");
        std::fs::write(
            prompts.join("overlay_test.md"),
            "Harness prompt\n\n{ENV_INFO}",
        )
        .expect("write prompt");

        let previous = std::env::var("BITFUN_HARNESS_DIR").ok();
        std::env::set_var("BITFUN_HARNESS_DIR", &root);

        let context = PromptBuilderContext::new("/workspace", None, None);
        let prompt = OverlayTestAgent
            .build_prompt(&context)
            .await
            .expect("prompt should build");

        match previous {
            Some(value) => std::env::set_var("BITFUN_HARNESS_DIR", value),
            None => std::env::remove_var("BITFUN_HARNESS_DIR"),
        }
        std::fs::remove_dir_all(root).ok();

        assert!(prompt.contains("Harness prompt"));
        assert!(prompt.contains("Environment Information"));
    }

    fn unique_temp_root() -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("bitfun-harness-test-{}", uuid::Uuid::new_v4()));
        path
    }
}
