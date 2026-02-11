//! Subagent API

use crate::api::app_state::AppState;
use bitfun_core::agentic::agents::{
    AgentCategory, AgentInfo, CustomSubagent, CustomSubagentConfig, CustomSubagentKind,
    SubAgentSource,
};
use bitfun_core::service::config::types::SubAgentConfig;
use log::warn;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSubagentsRequest {
    pub source: Option<SubAgentSource>,
}

#[tauri::command]
pub async fn list_subagents(
    state: State<'_, AppState>,
    request: ListSubagentsRequest,
) -> Result<Vec<AgentInfo>, String> {
    let list = state.agent_registry.get_subagents_info().await;

    let result = match request.source {
        Some(source) => list
            .into_iter()
            .filter(|a| a.subagent_source == Some(source))
            .collect(),
        None => list,
    };

    Ok(result)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSubagentRequest {
    pub subagent_id: String,
}

#[tauri::command]
pub async fn delete_subagent(
    state: State<'_, AppState>,
    request: DeleteSubagentRequest,
) -> Result<(), String> {
    let subagent_id = request.subagent_id;

    let file_path = state
        .agent_registry
        .remove_subagent(&subagent_id)
        .map_err(|e| e.to_string())?;

    if let Some(ref path) = file_path {
        if let Err(e) = std::fs::remove_file(path) {
            warn!("Failed to delete subagent file: path={}, error={}", path, e);
        }
    }

    let config_service = &state.config_service;
    let mut agent_models: HashMap<String, String> = config_service
        .get_config(Some("ai.agent_models"))
        .await
        .unwrap_or_default();
    agent_models.remove(&subagent_id);
    if let Err(e) = config_service
        .set_config("ai.agent_models", &agent_models)
        .await
    {
        warn!(
            "Failed to clean up ai.agent_models: subagent_id={}, error={}",
            subagent_id, e
        );
    }

    let mut subagent_configs: HashMap<String, SubAgentConfig> = config_service
        .get_config(Some("ai.subagent_configs"))
        .await
        .unwrap_or_default();
    subagent_configs.remove(&subagent_id);
    if let Err(e) = config_service
        .set_config("ai.subagent_configs", &subagent_configs)
        .await
    {
        warn!(
            "Failed to clean up ai.subagent_configs: subagent_id={}, error={}",
            subagent_id, e
        );
    }

    if let Err(e) = bitfun_core::service::config::reload_global_config().await {
        warn!(
            "Failed to reload global config after subagent deletion: subagent_id={}, error={}",
            subagent_id, e
        );
    }

    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubagentLevel {
    User,
    Project,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSubagentRequest {
    pub level: SubagentLevel,
    pub name: String,
    pub description: String,
    pub prompt: String,
    pub tools: Option<Vec<String>>,
    pub readonly: Option<bool>,
}

fn validate_agent_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Name cannot be empty".to_string());
    }
    let mut chars = name.chars();
    if !chars.next().map_or(false, |c| c.is_ascii_alphabetic()) {
        return Err("Name must start with a letter".to_string());
    }
    for c in chars {
        if !c.is_ascii_alphanumeric() && c != '-' && c != '_' {
            return Err("Name can only contain letters, numbers, -, _".to_string());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn create_subagent(
    state: State<'_, AppState>,
    request: CreateSubagentRequest,
) -> Result<(), String> {
    let name = request.name.trim();
    validate_agent_name(name)?;

    if request.level == SubagentLevel::Project {
        let wp = state.workspace_path.read().await;
        if wp.is_none() {
            return Err("Project-level Agent requires opening a workspace first".to_string());
        }
    }

    let modes = state.agent_registry.get_modes_info().await;
    let subagents = state.agent_registry.get_subagents_info().await;
    let existing: std::collections::HashSet<_> = modes
        .iter()
        .map(|m| m.id.as_str().to_lowercase())
        .chain(subagents.iter().map(|s| s.id.as_str().to_lowercase()))
        .collect();
    if existing.contains(name.to_lowercase().as_str()) {
        return Err(format!(
            "Name '{}' conflicts with existing mode or Sub Agent",
            name
        ));
    }

    let pm = state.workspace_service.path_manager();
    let agents_dir = match request.level {
        SubagentLevel::User => pm.user_agents_dir(),
        SubagentLevel::Project => {
            let wp = state.workspace_path.read().await;
            let root = wp.as_deref().ok_or("Workspace path not available")?;
            pm.project_agents_dir(root)
        }
    };

    std::fs::create_dir_all(&agents_dir)
        .map_err(|e| format!("Failed to create directory: {}", e))?;

    let tools = request.tools.filter(|t| !t.is_empty()).unwrap_or_else(|| {
        vec![
            "LS".to_string(),
            "Read".to_string(),
            "Glob".to_string(),
            "Grep".to_string(),
        ]
    });
    let kind = match request.level {
        SubagentLevel::User => CustomSubagentKind::User,
        SubagentLevel::Project => CustomSubagentKind::Project,
    };
    let file_path = agents_dir.join(format!("{}.md", name.to_lowercase()));
    let path_str = file_path.to_string_lossy().to_string();
    if file_path.exists() {
        return Err(format!("File '{}' already exists", path_str));
    }

    let readonly = request.readonly.unwrap_or(true);
    let subagent = CustomSubagent::new(
        name.to_string(),
        request.description.trim().to_string(),
        tools,
        request.prompt.trim().to_string(),
        readonly,
        path_str.clone(),
        kind,
    );
    subagent
        .save_to_file(None, None)
        .map_err(|e| e.to_string())?;

    let custom_config = CustomSubagentConfig {
        enabled: subagent.enabled,
        model: subagent.model.clone(),
    };

    state.agent_registry.register_agent(
        Arc::new(subagent),
        AgentCategory::SubAgent,
        Some(SubAgentSource::from_custom_kind(kind)),
        Some(custom_config),
    );

    Ok(())
}

#[tauri::command]
pub async fn reload_subagents(state: State<'_, AppState>) -> Result<(), String> {
    let workspace_root = state
        .workspace_path
        .read()
        .await
        .clone()
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    state
        .agent_registry
        .load_custom_subagents(workspace_root.as_path())
        .await;
    Ok(())
}

#[tauri::command]
pub async fn list_agent_tool_names(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let names: Vec<String> = state
        .tool_registry
        .iter()
        .map(|t| t.name().to_string())
        .collect();
    Ok(names)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSubagentConfigRequest {
    pub subagent_id: String,
    pub enabled: Option<bool>,
    pub model: Option<String>,
}

#[tauri::command]
pub async fn update_subagent_config(
    state: State<'_, AppState>,
    request: UpdateSubagentConfigRequest,
) -> Result<(), String> {
    let subagent_id = &request.subagent_id;

    if state
        .agent_registry
        .get_custom_subagent_config(subagent_id)
        .is_some()
    {
        state
            .agent_registry
            .update_and_save_custom_subagent_config(subagent_id, request.enabled, request.model)
            .map_err(|e| format!("Failed to update configuration: {}", e))?;
        Ok(())
    } else {
        let config_service = &state.config_service;

        if let Some(enabled) = request.enabled {
            let config = SubAgentConfig { enabled };
            let path = format!("ai.subagent_configs.{}", subagent_id);
            config_service
                .set_config(&path, serde_json::to_value(&config).unwrap())
                .await
                .map_err(|e| format!("Failed to update enabled status: {}", e))?;
        }

        if let Some(model) = request.model {
            let mut agent_models: HashMap<String, String> = config_service
                .get_config(Some("ai.agent_models"))
                .await
                .unwrap_or_default();
            agent_models.insert(subagent_id.clone(), model);
            config_service
                .set_config("ai.agent_models", &agent_models)
                .await
                .map_err(|e| format!("Failed to update model configuration: {}", e))?;
        }

        if let Err(e) = bitfun_core::service::config::reload_global_config().await {
            warn!(
                "Failed to reload global config after subagent config update: subagent_id={}, error={}",
                subagent_id, e
            );
        }

        Ok(())
    }
}
