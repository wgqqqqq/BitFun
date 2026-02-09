//! Cowork API (Tauri commands)
//!
//! This is a thin transport layer for the core cowork manager.

use std::sync::Arc;
use tauri::State;

use bitfun_core::agentic::coordination::ConversationCoordinator;
use bitfun_core::agentic::cowork::{
    get_global_cowork_manager, CoworkCancelRequest, CoworkCreateSessionRequest,
    CoworkCreateSessionResponse, CoworkGeneratePlanRequest, CoworkGetStateRequest,
    CoworkPauseRequest, CoworkSessionSnapshot, CoworkStartRequest, CoworkSubmitUserInputRequest,
    CoworkTask, CoworkUpdatePlanRequest,
};

#[tauri::command]
pub async fn cowork_create_session(
    request: CoworkCreateSessionRequest,
) -> Result<CoworkCreateSessionResponse, String> {
    let manager = get_global_cowork_manager();
    manager
        .create_session(request)
        .await
        .map_err(|e| format!("Failed to create cowork session: {}", e))
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

