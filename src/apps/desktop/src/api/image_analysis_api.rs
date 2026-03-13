//! Image Analysis API

use crate::api::app_state::AppState;
use bitfun_core::agentic::coordination::{DialogScheduler, DialogTriggerSource};
use bitfun_core::agentic::image_analysis::{
    resolve_vision_model_from_ai_config, AnalyzeImagesRequest, ImageAnalysisResult, ImageAnalyzer,
    MessageEnhancer, SendEnhancedMessageRequest,
};
use log::error;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

fn resolve_session_workspace_path(
    request: &AnalyzeImagesRequest,
) -> Result<Option<PathBuf>, String> {
    if let Some(workspace_path) = request.workspace_path.as_deref() {
        if !workspace_path.trim().is_empty() {
            return Ok(Some(PathBuf::from(workspace_path)));
        }
    }

    let coordinator = bitfun_core::agentic::coordination::get_global_coordinator()
        .ok_or_else(|| "Coordinator not initialized".to_string())?;

    Ok(coordinator
        .get_session_manager()
        .get_session(&request.session_id)
        .and_then(|session| session.config.workspace_path.clone())
        .filter(|workspace_path| !workspace_path.is_empty())
        .map(PathBuf::from))
}

#[tauri::command]
pub async fn analyze_images(
    request: AnalyzeImagesRequest,
    state: State<'_, AppState>,
) -> Result<Vec<ImageAnalysisResult>, String> {
    let ai_config: bitfun_core::service::config::types::AIConfig = state
        .config_service
        .get_config(Some("ai"))
        .await
        .map_err(|e| {
            error!("Failed to get AI config: error={}", e);
            format!("Failed to get AI config: {}", e)
        })?;

    let image_model = resolve_vision_model_from_ai_config(&ai_config).map_err(|e| {
        error!(
            "Image understanding model resolution failed: available_models={:?}, error={}",
            ai_config.models.iter().map(|m| &m.id).collect::<Vec<_>>(),
            e
        );
        format!(
            "Image understanding model is not configured.\n\n\
             Please select a model for [Settings → Default Model Config → Image Understanding Model].\n\n\
             Details: {}",
            e
        )
    })?;

    let workspace_path = resolve_session_workspace_path(&request)?;

    let ai_client = state
        .ai_client_factory
        .get_client_by_id(&image_model.id)
        .await
        .map_err(|e| format!("Failed to create AI client: {}", e))?;

    let analyzer = ImageAnalyzer::new(workspace_path, ai_client);

    let results = analyzer
        .analyze_images(request, &image_model)
        .await
        .map_err(|e| format!("Image analysis failed: {}", e))?;

    Ok(results)
}

#[tauri::command]
pub async fn send_enhanced_message(
    request: SendEnhancedMessageRequest,
    scheduler: State<'_, Arc<DialogScheduler>>,
    _state: State<'_, AppState>,
) -> Result<(), String> {
    let enhanced_message = MessageEnhancer::enhance_with_image_analysis(
        &request.original_message,
        &request.image_analyses,
        &request.other_contexts,
    );

    scheduler
        .submit(
            request.session_id.clone(),
            enhanced_message,
            Some(request.original_message.clone()),
            Some(request.dialog_turn_id.clone()),
            request.agent_type.clone(),
            None,
            DialogTriggerSource::DesktopApi,
        )
        .await
        .map_err(|e| format!("Failed to send enhanced message: {}", e))?;

    Ok(())
}
