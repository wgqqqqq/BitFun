//! Skill Management API

use log::info;
use serde_json::Value;
use tauri::State;

use crate::api::app_state::AppState;
use bitfun_core::agentic::tools::implementations::skills::{
    SkillData, SkillLocation, SkillRegistry,
};
use bitfun_core::infrastructure::{get_path_manager_arc, get_workspace_path};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SkillValidationResult {
    pub valid: bool,
    pub name: Option<String>,
    pub description: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn get_skill_configs(
    _state: State<'_, AppState>,
    force_refresh: Option<bool>,
) -> Result<Value, String> {
    let registry = SkillRegistry::global();

    if force_refresh.unwrap_or(false) {
        registry.refresh().await;
    }

    let all_skills = registry.get_all_skills().await;

    serde_json::to_value(all_skills)
        .map_err(|e| format!("Failed to serialize skill configs: {}", e))
}

#[tauri::command]
pub async fn set_skill_enabled(
    _state: State<'_, AppState>,
    skill_name: String,
    enabled: bool,
) -> Result<String, String> {
    let registry = SkillRegistry::global();

    let skill_md_path = registry
        .find_skill_path(&skill_name)
        .await
        .ok_or_else(|| format!("Skill '{}' not found", skill_name))?;

    SkillData::set_enabled_and_save(
        skill_md_path
            .to_str()
            .ok_or_else(|| "Invalid path".to_string())?,
        enabled,
    )
    .map_err(|e| format!("Failed to save skill config: {}", e))?;

    registry.update_skill_enabled(&skill_name, enabled).await;

    Ok(format!(
        "Skill '{}' configuration saved successfully",
        skill_name
    ))
}

#[tauri::command]
pub async fn validate_skill_path(path: String) -> Result<SkillValidationResult, String> {
    use std::path::Path;

    let skill_path = Path::new(&path);

    if !skill_path.exists() {
        return Ok(SkillValidationResult {
            valid: false,
            name: None,
            description: None,
            error: Some("Path does not exist".to_string()),
        });
    }

    if !skill_path.is_dir() {
        return Ok(SkillValidationResult {
            valid: false,
            name: None,
            description: None,
            error: Some("Path is not a directory".to_string()),
        });
    }

    let skill_md_path = skill_path.join("SKILL.md");
    if !skill_md_path.exists() {
        return Ok(SkillValidationResult {
            valid: false,
            name: None,
            description: None,
            error: Some("Directory is missing SKILL.md file".to_string()),
        });
    }

    match tokio::fs::read_to_string(&skill_md_path).await {
        Ok(content) => {
            match SkillData::from_markdown(path.clone(), &content, SkillLocation::User, false) {
                Ok(data) => Ok(SkillValidationResult {
                    valid: true,
                    name: Some(data.name),
                    description: Some(data.description),
                    error: None,
                }),
                Err(e) => Ok(SkillValidationResult {
                    valid: false,
                    name: None,
                    description: None,
                    error: Some(e.to_string()),
                }),
            }
        }
        Err(e) => Ok(SkillValidationResult {
            valid: false,
            name: None,
            description: None,
            error: Some(format!("Failed to read SKILL.md: {}", e)),
        }),
    }
}

#[tauri::command]
pub async fn add_skill(
    _state: State<'_, AppState>,
    source_path: String,
    level: String,
) -> Result<String, String> {
    use std::path::Path;

    let validation = validate_skill_path(source_path.clone()).await?;
    if !validation.valid {
        return Err(validation.error.unwrap_or("Invalid skill path".to_string()));
    }

    let skill_name = validation
        .name
        .as_ref()
        .ok_or_else(|| "Skill name missing after validation".to_string())?;
    let source = Path::new(&source_path);

    let target_dir = if level == "project" {
        if let Some(workspace_path) = get_workspace_path() {
            workspace_path.join(".bitfun").join("skills")
        } else {
            return Err("No workspace open, cannot add project-level Skill".to_string());
        }
    } else {
        get_path_manager_arc().user_skills_dir()
    };

    if let Err(e) = tokio::fs::create_dir_all(&target_dir).await {
        return Err(format!("Failed to create skills directory: {}", e));
    }

    let folder_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Unable to get folder name")?;

    let target_path = target_dir.join(folder_name);

    if target_path.exists() {
        return Err(format!(
            "Skill '{}' already exists in {} level directory",
            folder_name,
            if level == "project" {
                "project"
            } else {
                "user"
            }
        ));
    }

    if let Err(e) = copy_dir_all(source, &target_path).await {
        return Err(format!("Failed to copy skill folder: {}", e));
    }

    SkillRegistry::global().refresh().await;

    info!(
        "Skill added: name={}, level={}, path={}",
        skill_name,
        level,
        target_path.display()
    );
    Ok(format!("Skill '{}' added successfully", skill_name))
}

async fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    tokio::fs::create_dir_all(dst).await?;

    let mut entries = tokio::fs::read_dir(src).await?;
    while let Some(entry) = entries.next_entry().await? {
        let ty = entry.file_type().await?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        if ty.is_dir() {
            Box::pin(copy_dir_all(&src_path, &dst_path)).await?;
        } else {
            tokio::fs::copy(&src_path, &dst_path).await?;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn delete_skill(
    _state: State<'_, AppState>,
    skill_name: String,
) -> Result<String, String> {
    let registry = SkillRegistry::global();

    let skill_info = registry
        .find_skill(&skill_name)
        .await
        .ok_or_else(|| format!("Skill '{}' not found", skill_name))?;

    let skill_path = std::path::PathBuf::from(&skill_info.path);

    if skill_path.exists() {
        if let Err(e) = tokio::fs::remove_dir_all(&skill_path).await {
            return Err(format!("Failed to delete skill folder: {}", e));
        }
    }

    registry.remove_skill(&skill_name).await;

    info!(
        "Skill deleted: name={}, path={}",
        skill_name,
        skill_path.display()
    );
    Ok(format!("Skill '{}' deleted successfully", skill_name))
}
