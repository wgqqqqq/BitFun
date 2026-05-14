use super::types::*;
use crate::function_agents::common::{AgentError, AgentResult, Language};
use crate::infrastructure::ai::AIClient;
use crate::util::types::Message;
/**
 * AI analysis service
 *
 * Provides AI-driven work state analysis for the Startchat function agent
 */
use log::{debug, error, warn};
use std::sync::Arc;

/// Prompt template constants (embedded at compile time)
const WORK_STATE_ANALYSIS_PROMPT: &str = include_str!("prompts/work_state_analysis.md");

pub struct AIWorkStateService {
    ai_client: Arc<AIClient>,
}

impl AIWorkStateService {
    pub async fn new_with_agent_config(
        factory: Arc<crate::infrastructure::ai::AIClientFactory>,
        agent_name: &str,
    ) -> AgentResult<Self> {
        let ai_client = match factory.get_client_by_func_agent(agent_name).await {
            Ok(client) => client,
            Err(e) => {
                error!("Failed to get AI client: {}", e);
                return Err(AgentError::internal_error(format!(
                    "Failed to get AI client: {}",
                    e
                )));
            }
        };

        Ok(Self { ai_client })
    }

    pub async fn generate_complete_analysis(
        &self,
        git_state: &Option<GitWorkState>,
        git_diff: &str,
        language: &Language,
    ) -> AgentResult<AIGeneratedAnalysis> {
        let prompt = self.build_complete_analysis_prompt(git_state, git_diff, language);

        debug!(
            "Calling AI to generate complete analysis: prompt_length={}",
            prompt.len()
        );

        let response = self.call_ai(&prompt).await?;

        self.parse_complete_analysis(&response)
    }

    async fn call_ai(&self, prompt: &str) -> AgentResult<String> {
        debug!("Sending request to AI: prompt_length={}", prompt.len());

        let messages = vec![Message::user(prompt.to_string())];
        let response = self
            .ai_client
            .send_message(messages, None)
            .await
            .map_err(|e| {
                error!("AI call failed: {}", e);
                AgentError::internal_error(format!("AI call failed: {}", e))
            })?;

        debug!(
            "AI response received: response_length={}",
            response.text.len()
        );

        if response.text.is_empty() {
            error!("AI response is empty");
            Err(AgentError::internal_error(
                "AI response is empty".to_string(),
            ))
        } else {
            Ok(response.text)
        }
    }

    fn build_complete_analysis_prompt(
        &self,
        git_state: &Option<GitWorkState>,
        git_diff: &str,
        language: &Language,
    ) -> String {
        super::utils::build_complete_analysis_prompt(
            WORK_STATE_ANALYSIS_PROMPT,
            git_state,
            git_diff,
            language,
        )
    }

    fn parse_complete_analysis(&self, response: &str) -> AgentResult<AIGeneratedAnalysis> {
        let json_str = crate::util::extract_json_from_ai_response(response).ok_or_else(|| {
            error!(
                "Failed to extract JSON from analysis response: {}",
                response
            );
            AgentError::internal_error("Failed to extract JSON from analysis response")
        })?;

        debug!("Parsing JSON response: length={}", json_str.len());

        let parsed: serde_json::Value = serde_json::from_str(&json_str).map_err(|e| {
            error!(
                "Failed to parse complete analysis response: {}, response: {}",
                e, response
            );
            AgentError::internal_error(format!("Failed to parse complete analysis response: {}", e))
        })?;

        let summary = parsed["summary"]
            .as_str()
            .unwrap_or("You were working on development, with multiple files modified.")
            .to_string();

        let ongoing_work = Vec::new();

        let predicted_actions = if let Some(actions_array) = parsed["predicted_actions"].as_array()
        {
            super::utils::parse_predicted_actions_from_values(actions_array)
        } else {
            Vec::new()
        };
        let predicted_actions_count = predicted_actions.len();
        let predicted_actions = super::utils::normalize_predicted_actions(predicted_actions);

        if predicted_actions_count < 3 {
            warn!(
                "AI generated insufficient predicted actions ({}), adding defaults",
                predicted_actions_count
            );
        } else if predicted_actions_count > 3 {
            warn!(
                "AI generated too many predicted actions ({}), truncating to 3",
                predicted_actions_count
            );
        }

        let quick_actions = if let Some(actions_array) = parsed["quick_actions"].as_array() {
            super::utils::parse_quick_actions_from_values(actions_array)
        } else {
            Vec::new()
        };

        let quick_actions_count = quick_actions.len();
        let quick_actions = super::utils::limit_quick_actions(quick_actions);

        if quick_actions_count < 6 {
            // Don't fill defaults here, frontend has its own defaultActions with i18n support
            warn!(
                "AI generated insufficient quick actions ({}), frontend will use defaults",
                quick_actions_count
            );
        } else if quick_actions_count > 6 {
            warn!(
                "AI generated too many quick actions ({}), truncating to 6",
                quick_actions_count
            );
        }

        debug!(
            "Parsing completed: predicted_actions={}, quick_actions={}",
            predicted_actions.len(),
            quick_actions.len()
        );

        Ok(AIGeneratedAnalysis {
            summary,
            ongoing_work,
            predicted_actions,
            quick_actions,
        })
    }
}
