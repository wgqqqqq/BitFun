//! Cowork API (Tauri commands)
//!
//! This is a thin transport layer for the core cowork manager.

use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

use crate::api::app_state::AppState;

use bitfun_core::agentic::coordination::ConversationCoordinator;
use bitfun_core::agentic::cowork::{
    get_global_cowork_manager, CoworkCancelRequest, CoworkCreateSessionRequest,
    CoworkCreateSessionResponse, CoworkGeneratePlanRequest, CoworkGetStateRequest,
    CoworkPauseRequest, CoworkSessionSnapshot, CoworkStartRequest, CoworkSubmitUserInputRequest,
    CoworkTask, CoworkUpdatePlanRequest,
};

#[tauri::command]
pub async fn cowork_create_session(
    state: State<'_, AppState>,
    request: CoworkCreateSessionRequest,
) -> Result<CoworkCreateSessionResponse, String> {
    let manager = get_global_cowork_manager();
    let mut resp = manager
        .create_session(request)
        .await
        .map_err(|e| format!("Failed to create cowork session: {}", e))?;

    // Auto-create a temporary workspace for cowork session (Eigent-like behavior).
    // The frontend will open this workspace explicitly before running tasks.
    let workspace_root: PathBuf = state
        .workspace_service
        .path_manager()
        .temp_dir()
        .join("cowork")
        .join(&resp.cowork_session_id);

    tokio::fs::create_dir_all(&workspace_root)
        .await
        .map_err(|e| format!("Failed to create cowork temp workspace: {}", e))?;

    let workspace_root_str = workspace_root.to_string_lossy().to_string();
    manager
        .set_session_workspace_root(&resp.cowork_session_id, workspace_root_str.clone())
        .await
        .map_err(|e| format!("Failed to set cowork workspace: {}", e))?;

    resp.workspace_root = Some(workspace_root_str);
    Ok(resp)
}

#[tauri::command]
pub async fn cowork_generate_plan(
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    request: CoworkGeneratePlanRequest,
) -> Result<Vec<CoworkTask>, String> {
    let manager = get_global_cowork_manager();
    manager
        .generate_plan(coordinator.inner().clone(), request)
        .await
        .map_err(|e| format!("Failed to generate cowork plan: {}", e))
}

#[tauri::command]
pub async fn cowork_update_plan(request: CoworkUpdatePlanRequest) -> Result<(), String> {
    let manager = get_global_cowork_manager();
    manager
        .update_plan(request)
        .await
        .map_err(|e| format!("Failed to update cowork plan: {}", e))
}

#[tauri::command]
pub async fn cowork_start(
    coordinator: State<'_, Arc<ConversationCoordinator>>,
    request: CoworkStartRequest,
) -> Result<(), String> {
    let manager = get_global_cowork_manager();
    manager
        .start(coordinator.inner().clone(), request)
        .await
        .map_err(|e| format!("Failed to start cowork: {}", e))
}

#[tauri::command]
pub async fn cowork_pause(request: CoworkPauseRequest) -> Result<(), String> {
    let manager = get_global_cowork_manager();
    manager
        .pause(request)
        .await
        .map_err(|e| format!("Failed to pause cowork: {}", e))
}

#[tauri::command]
pub async fn cowork_cancel(request: CoworkCancelRequest) -> Result<(), String> {
    let manager = get_global_cowork_manager();
    manager
        .cancel(request)
        .await
        .map_err(|e| format!("Failed to cancel cowork: {}", e))
}

#[tauri::command]
pub async fn cowork_get_state(request: CoworkGetStateRequest) -> Result<CoworkSessionSnapshot, String> {
    let manager = get_global_cowork_manager();
    manager
        .get_session_snapshot(&request.cowork_session_id)
        .map_err(|e| format!("Failed to get cowork state: {}", e))
}

#[tauri::command]
pub async fn cowork_submit_user_input(request: CoworkSubmitUserInputRequest) -> Result<(), String> {
    let manager = get_global_cowork_manager();
    manager
        .submit_user_input(request)
        .await
        .map_err(|e| format!("Failed to submit cowork user input: {}", e))
}
