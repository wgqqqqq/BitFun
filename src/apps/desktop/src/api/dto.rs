//! DTO Module

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceTypeDto {
    SingleProject,
    MultiProject,
    Documentation,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatisticsDto {
    pub total_files: usize,
    pub total_lines: usize,
    pub total_size: usize,
    pub files_by_language: HashMap<String, usize>,
    pub files_by_extension: HashMap<String, usize>,
    pub last_updated: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfoDto {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub workspace_type: WorkspaceTypeDto,
    pub languages: Vec<String>,
    pub opened_at: String,
    pub last_accessed: String,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub statistics: Option<ProjectStatisticsDto>,
}

impl WorkspaceInfoDto {
    pub fn from_workspace_info(
        info: &bitfun_core::service::workspace::manager::WorkspaceInfo,
    ) -> Self {
        Self {
            id: info.id.clone(),
            name: info.name.clone(),
            root_path: info.root_path.to_string_lossy().to_string(),
            workspace_type: WorkspaceTypeDto::from_workspace_type(&info.workspace_type),
            languages: info.languages.clone(),
            opened_at: info.opened_at.to_rfc3339(),
            last_accessed: info.last_accessed.to_rfc3339(),
            description: info.description.clone(),
            tags: info.tags.clone(),
            statistics: info
                .statistics
                .as_ref()
                .map(ProjectStatisticsDto::from_workspace_statistics),
        }
    }
}

impl WorkspaceTypeDto {
    pub fn from_workspace_type(
        workspace_type: &bitfun_core::service::workspace::manager::WorkspaceType,
    ) -> Self {
        use bitfun_core::service::workspace::manager::WorkspaceType;
        match workspace_type {
            WorkspaceType::RustProject
            | WorkspaceType::NodeProject
            | WorkspaceType::PythonProject
            | WorkspaceType::JavaProject
            | WorkspaceType::CppProject
            | WorkspaceType::WebProject
            | WorkspaceType::MobileProject => WorkspaceTypeDto::SingleProject,
            WorkspaceType::Other => WorkspaceTypeDto::Other,
        }
    }
}

impl ProjectStatisticsDto {
    pub fn from_workspace_statistics(
        stats: &bitfun_core::service::workspace::manager::WorkspaceStatistics,
    ) -> Self {
        Self {
            total_files: stats.total_files,
            total_lines: 0, // Temporarily set to 0 as the internal structure lacks this field
            total_size: stats.total_size_bytes as usize,
            files_by_language: HashMap::new(), // Temporarily empty, requires future implementation
            files_by_extension: stats.file_extensions.clone(),
            last_updated: stats
                .last_modified
                .map_or_else(|| chrono::Utc::now().to_rfc3339(), |dt| dt.to_rfc3339()),
        }
    }
}
