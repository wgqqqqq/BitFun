//! Conversation history persistence API

use bitfun_core::infrastructure::PathManager;
use bitfun_core::service::conversation::{
    ConversationPersistenceManager, DialogTurnData, SessionMetadata,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetSessionsRequest {
    pub workspace_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadHistoryRequest {
    pub session_id: String,
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveTurnRequest {
    pub turn_data: DialogTurnData,
    pub workspace_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveMetadataRequest {
    pub metadata: SessionMetadata,
    pub workspace_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteSessionRequest {
    pub session_id: String,
    pub workspace_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TouchSessionRequest {
    pub session_id: String,
    pub workspace_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadSessionMetadataRequest {
    pub session_id: String,
    pub workspace_path: String,
}

#[tauri::command]
pub async fn get_conversation_sessions(
    request: GetSessionsRequest,
    path_manager: State<'_, Arc<PathManager>>,
) -> Result<Vec<SessionMetadata>, String> {
    let workspace_path = PathBuf::from(&request.workspace_path);

    let manager = ConversationPersistenceManager::new(path_manager.inner().clone(), workspace_path.clone())
        .await
        .map_err(|e| format!("Failed to create persistence manager: {}", e))?;

    let sessions = manager
        .get_session_list()
        .await
        .map_err(|e| format!("Failed to get session list: {}", e))?;

    Ok(sessions)
}

#[tauri::command]
pub async fn load_conversation_history(
    request: LoadHistoryRequest,
    path_manager: State<'_, Arc<PathManager>>,
) -> Result<Vec<DialogTurnData>, String> {
    let workspace_path = PathBuf::from(&request.workspace_path);

    let manager = ConversationPersistenceManager::new(path_manager.inner().clone(), workspace_path)
        .await
        .map_err(|e| format!("Failed to create persistence manager: {}", e))?;

    let turns = if let Some(limit) = request.limit {
        manager.load_recent_turns(&request.session_id, limit).await
    } else {
        manager.load_session_turns(&request.session_id).await
    };

    turns.map_err(|e| format!("Failed to load conversation history: {}", e))
}

#[tauri::command]
pub async fn save_dialog_turn(
    request: SaveTurnRequest,
    path_manager: State<'_, Arc<PathManager>>,
) -> Result<(), String> {
    let workspace_path = PathBuf::from(&request.workspace_path);

    let manager = ConversationPersistenceManager::new(path_manager.inner().clone(), workspace_path)
        .await
        .map_err(|e| format!("Failed to create persistence manager: {}", e))?;

    manager
        .save_dialog_turn(&request.turn_data)
        .await
        .map_err(|e| format!("Failed to save dialog turn: {}", e))
}

#[tauri::command]
pub async fn save_session_metadata(
    request: SaveMetadataRequest,
    path_manager: State<'_, Arc<PathManager>>,
) -> Result<(), String> {
    let workspace_path = PathBuf::from(&request.workspace_path);

    let manager = ConversationPersistenceManager::new(path_manager.inner().clone(), workspace_path)
        .await
        .map_err(|e| format!("Failed to create persistence manager: {}", e))?;

    manager
        .save_session_metadata(&request.metadata)
        .await
        .map_err(|e| format!("Failed to save session metadata: {}", e))
}

#[tauri::command]
pub async fn delete_conversation_history(
    request: DeleteSessionRequest,
    path_manager: State<'_, Arc<PathManager>>,
) -> Result<(), String> {
    let workspace_path = PathBuf::from(&request.workspace_path);

    let manager = ConversationPersistenceManager::new(path_manager.inner().clone(), workspace_path)
        .await
        .map_err(|e| format!("Failed to create persistence manager: {}", e))?;

    manager
        .delete_session(&request.session_id)
        .await
        .map_err(|e| format!("Failed to delete conversation history: {}", e))
}

#[tauri::command]
pub async fn touch_conversation_session(
    request: TouchSessionRequest,
    path_manager: State<'_, Arc<PathManager>>,
) -> Result<(), String> {
    let workspace_path = PathBuf::from(&request.workspace_path);

    let manager = ConversationPersistenceManager::new(path_manager.inner().clone(), workspace_path)
        .await
        .map_err(|e| format!("Failed to create persistence manager: {}", e))?;

    manager
        .touch_session(&request.session_id)
        .await
        .map_err(|e| format!("Failed to update session active time: {}", e))
}

#[tauri::command]
pub async fn load_session_metadata(
    request: LoadSessionMetadataRequest,
    path_manager: State<'_, Arc<PathManager>>,
) -> Result<Option<SessionMetadata>, String> {
    let workspace_path = PathBuf::from(&request.workspace_path);

    let manager = ConversationPersistenceManager::new(path_manager.inner().clone(), workspace_path)
        .await
        .map_err(|e| format!("Failed to create persistence manager: {}", e))?;

    manager
        .load_session_metadata(&request.session_id)
        .await
        .map_err(|e| format!("Failed to load session metadata: {}", e))
}
