//! Workspace manager.

use crate::util::errors::*;
use log::warn;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::fs;

/// Options for opening a workspace.
#[derive(Debug, Clone)]
pub struct OpenWorkspaceOptions {
    /// Whether to add this workspace to the recent-workspaces list.
    pub add_to_recent: bool,
    /// Whether to persist this workspace in workspace history.
    /// Note: The manager does not handle persistence directly; this flag is used by the service layer.
    pub persist: bool,
    /// Arbitrary metadata to attach to the workspace record.
    pub metadata: HashMap<String, serde_json::Value>,
}

impl Default for OpenWorkspaceOptions {
    fn default() -> Self {
        Self {
            add_to_recent: true,
            persist: true,
            metadata: HashMap::new(),
        }
    }
}

/// Workspace type.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum WorkspaceType {
    RustProject,
    NodeProject,
    PythonProject,
    JavaProject,
    CppProject,
    WebProject,
    MobileProject,
    Other,
}

/// Workspace status.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum WorkspaceStatus {
    Active,
    Inactive,
    Loading,
    Error,
    Archived,
}

/// Workspace metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceInfo {
    pub id: String,
    pub name: String,
    #[serde(rename = "rootPath")]
    pub root_path: PathBuf,
    #[serde(rename = "workspaceType")]
    pub workspace_type: WorkspaceType,
    pub status: WorkspaceStatus,
    pub languages: Vec<String>,
    #[serde(rename = "openedAt")]
    pub opened_at: chrono::DateTime<chrono::Utc>,
    #[serde(rename = "lastAccessed")]
    pub last_accessed: chrono::DateTime<chrono::Utc>,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub statistics: Option<WorkspaceStatistics>,
    pub metadata: HashMap<String, serde_json::Value>,
}

/// Workspace statistics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceStatistics {
    pub total_files: usize,
    pub total_directories: usize,
    pub total_size_bytes: u64,
    pub file_extensions: HashMap<String, usize>,
    pub last_modified: Option<chrono::DateTime<chrono::Utc>>,
    pub git_info: Option<GitInfo>,
}

/// Git information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitInfo {
    pub is_git_repo: bool,
    pub current_branch: Option<String>,
    pub remote_url: Option<String>,
    pub has_uncommitted_changes: bool,
    pub total_commits: Option<usize>,
}

/// Options for scanning a workspace.
#[derive(Debug, Clone)]
pub struct ScanOptions {
    pub include_hidden: bool,
    pub max_depth: Option<usize>,
    pub scan_git_info: bool,
    pub calculate_statistics: bool,
    pub ignore_patterns: Vec<String>,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            include_hidden: false,
            max_depth: Some(10),
            scan_git_info: true,
            calculate_statistics: false,
            ignore_patterns: vec![
                "node_modules".to_string(),
                "target".to_string(),
                ".git".to_string(),
                "__pycache__".to_string(),
                "build".to_string(),
                "dist".to_string(),
            ],
        }
    }
}

impl WorkspaceInfo {
    /// Creates a new workspace record.
    pub async fn new(root_path: PathBuf, options: ScanOptions) -> BitFunResult<Self> {
        let name = root_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Unknown")
            .to_string();

        let now = chrono::Utc::now();
        let id = uuid::Uuid::new_v4().to_string();

        let mut workspace = Self {
            id,
            name,
            root_path: root_path.clone(),
            workspace_type: WorkspaceType::Other,
            status: WorkspaceStatus::Loading,
            languages: Vec::new(),
            opened_at: now,
            last_accessed: now,
            description: None,
            tags: Vec::new(),
            statistics: None,
            metadata: HashMap::new(),
        };

        workspace.detect_workspace_type().await;

        if options.calculate_statistics {
            workspace.scan_workspace(options).await?;
        }

        workspace.status = WorkspaceStatus::Active;
        Ok(workspace)
    }

    /// Detects the workspace type.
    async fn detect_workspace_type(&mut self) {
        let root = &self.root_path;

        if root.join("Cargo.toml").exists() {
            self.workspace_type = WorkspaceType::RustProject;
            self.languages.push("Rust".to_string());
        } else if root.join("package.json").exists() {
            self.workspace_type = WorkspaceType::NodeProject;
            self.languages.push("JavaScript".to_string());
            self.languages.push("TypeScript".to_string());
        } else if root.join("requirements.txt").exists()
            || root.join("pyproject.toml").exists()
            || root.join("setup.py").exists()
        {
            self.workspace_type = WorkspaceType::PythonProject;
            self.languages.push("Python".to_string());
        } else if root.join("pom.xml").exists() || root.join("build.gradle").exists() {
            self.workspace_type = WorkspaceType::JavaProject;
            self.languages.push("Java".to_string());
        } else if root.join("CMakeLists.txt").exists() || root.join("Makefile").exists() {
            self.workspace_type = WorkspaceType::CppProject;
            self.languages.push("C++".to_string());
        } else if root.join("index.html").exists() || root.join("webpack.config.js").exists() {
            self.workspace_type = WorkspaceType::WebProject;
            self.languages.push("HTML".to_string());
            self.languages.push("CSS".to_string());
            self.languages.push("JavaScript".to_string());
        }

        self.detect_languages_from_files().await;
    }

    /// Detects languages from file extensions.
    async fn detect_languages_from_files(&mut self) {
        const LANGUAGE_SCAN_LIMIT: usize = 50;

        let mut language_map = HashMap::new();
        language_map.insert("rs", "Rust");
        language_map.insert("js", "JavaScript");
        language_map.insert("ts", "TypeScript");
        language_map.insert("py", "Python");
        language_map.insert("java", "Java");
        language_map.insert("cpp", "C++");
        language_map.insert("c", "C");
        language_map.insert("h", "C/C++");
        language_map.insert("html", "HTML");
        language_map.insert("css", "CSS");
        language_map.insert("go", "Go");
        language_map.insert("php", "PHP");
        language_map.insert("rb", "Ruby");
        language_map.insert("swift", "Swift");
        language_map.insert("kt", "Kotlin");

        if let Ok(mut read_dir) = fs::read_dir(&self.root_path).await {
            let mut found_languages = std::collections::HashSet::new();
            let mut count = 0;

            while let Ok(Some(entry)) = read_dir.next_entry().await {
                if count > LANGUAGE_SCAN_LIMIT {
                    break;
                }
                count += 1;

                if let Some(extension) = entry.path().extension().and_then(|s| s.to_str()) {
                    if let Some(language) = language_map.get(extension) {
                        found_languages.insert(language.to_string());
                    }
                }
            }

            for lang in found_languages {
                if !self.languages.contains(&lang) {
                    self.languages.push(lang);
                }
            }
        }
    }

    /// Scans the workspace.
    async fn scan_workspace(&mut self, options: ScanOptions) -> BitFunResult<()> {
        let mut stats = WorkspaceStatistics {
            total_files: 0,
            total_directories: 0,
            total_size_bytes: 0,
            file_extensions: HashMap::new(),
            last_modified: None,
            git_info: None,
        };

        self.scan_directory(&self.root_path.clone(), &mut stats, &options, 0)
            .await?;

        if options.scan_git_info {
            stats.git_info = self.scan_git_info().await;
        }

        self.statistics = Some(stats);
        Ok(())
    }

    /// Recursively scans a directory.
    fn scan_directory<'a>(
        &'a self,
        dir: &'a Path,
        stats: &'a mut WorkspaceStatistics,
        options: &'a ScanOptions,
        depth: usize,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = BitFunResult<()>> + 'a + Send>> {
        Box::pin(async move {
            if let Some(max_depth) = options.max_depth {
                if depth > max_depth {
                    return Ok(());
                }
            }

            let mut read_dir = fs::read_dir(dir)
                .await
                .map_err(|e| BitFunError::service(format!("Failed to read directory: {}", e)))?;

            while let Some(entry) = read_dir.next_entry().await.map_err(|e| {
                BitFunError::service(format!("Failed to read directory entry: {}", e))
            })? {
                let path = entry.path();
                let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

                if !options.include_hidden && file_name.starts_with('.') {
                    continue;
                }

                if options
                    .ignore_patterns
                    .iter()
                    .any(|pattern| file_name.contains(pattern))
                {
                    continue;
                }

                let metadata = entry
                    .metadata()
                    .await
                    .map_err(|e| BitFunError::service(format!("Failed to read metadata: {}", e)))?;

                if metadata.is_file() {
                    stats.total_files += 1;
                    stats.total_size_bytes += metadata.len();

                    if let Some(extension) = path.extension().and_then(|s| s.to_str()) {
                        *stats
                            .file_extensions
                            .entry(extension.to_string())
                            .or_insert(0) += 1;
                    }

                    if let Ok(modified) = metadata.modified() {
                        let modified_dt = chrono::DateTime::<chrono::Utc>::from(modified);
                        if stats.last_modified.is_none()
                            || stats.last_modified.as_ref().unwrap() < &modified_dt
                        {
                            stats.last_modified = Some(modified_dt);
                        }
                    }
                } else if metadata.is_dir() {
                    stats.total_directories += 1;

                    if let Err(e) = self.scan_directory(&path, stats, options, depth + 1).await {
                        warn!("Failed to scan subdirectory {:?}: {}", path, e);
                    }
                }
            }

            Ok(())
        })
    }

    /// Scans Git information.
    async fn scan_git_info(&self) -> Option<GitInfo> {
        let git_dir = self.root_path.join(".git");
        if !git_dir.exists() {
            return Some(GitInfo {
                is_git_repo: false,
                current_branch: None,
                remote_url: None,
                has_uncommitted_changes: false,
                total_commits: None,
            });
        }

        let mut git_info = GitInfo {
            is_git_repo: true,
            current_branch: None,
            remote_url: None,
            has_uncommitted_changes: false,
            total_commits: None,
        };

        if let Ok(head_content) = fs::read_to_string(git_dir.join("HEAD")).await {
            if let Some(branch) = head_content.strip_prefix("ref: refs/heads/") {
                git_info.current_branch = Some(branch.trim().to_string());
            }
        }

        if let Ok(status_output) = crate::util::process_manager::create_tokio_command("git")
            .arg("status")
            .arg("--porcelain")
            .current_dir(&self.root_path)
            .output()
            .await
        {
            git_info.has_uncommitted_changes = !status_output.stdout.is_empty();
        }

        Some(git_info)
    }

    /// Updates the last-accessed timestamp.
    pub fn touch(&mut self) {
        self.last_accessed = chrono::Utc::now();
    }

    /// Checks whether the workspace is still valid.
    pub async fn is_valid(&self) -> bool {
        self.root_path.exists() && self.root_path.is_dir()
    }

    /// Returns a workspace summary.
    pub fn get_summary(&self) -> WorkspaceSummary {
        WorkspaceSummary {
            id: self.id.clone(),
            name: self.name.clone(),
            root_path: self.root_path.clone(),
            workspace_type: self.workspace_type.clone(),
            status: self.status.clone(),
            languages: self.languages.clone(),
            last_accessed: self.last_accessed,
            file_count: self.statistics.as_ref().map(|s| s.total_files).unwrap_or(0),
            tags: self.tags.clone(),
        }
    }
}

/// Workspace summary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSummary {
    pub id: String,
    pub name: String,
    #[serde(rename = "rootPath")]
    pub root_path: PathBuf,
    #[serde(rename = "workspaceType")]
    pub workspace_type: WorkspaceType,
    pub status: WorkspaceStatus,
    pub languages: Vec<String>,
    #[serde(rename = "lastAccessed")]
    pub last_accessed: chrono::DateTime<chrono::Utc>,
    #[serde(rename = "fileCount")]
    pub file_count: usize,
    pub tags: Vec<String>,
}

/// Workspace manager.
pub struct WorkspaceManager {
    workspaces: HashMap<String, WorkspaceInfo>,
    current_workspace_id: Option<String>,
    recent_workspaces: Vec<String>,
    max_recent_workspaces: usize,
}

/// Workspace manager configuration.
#[derive(Debug, Clone)]
pub struct WorkspaceManagerConfig {
    pub max_recent_workspaces: usize,
    pub auto_cleanup_invalid: bool,
    pub default_scan_options: ScanOptions,
}

impl Default for WorkspaceManagerConfig {
    fn default() -> Self {
        Self {
            max_recent_workspaces: 20,
            auto_cleanup_invalid: true,
            default_scan_options: ScanOptions::default(),
        }
    }
}

impl WorkspaceManager {
    /// Creates a new workspace manager.
    pub fn new(config: WorkspaceManagerConfig) -> Self {
        Self {
            workspaces: HashMap::new(),
            current_workspace_id: None,
            recent_workspaces: Vec::new(),
            max_recent_workspaces: config.max_recent_workspaces,
        }
    }

    /// Opens a workspace.
    pub async fn open_workspace(&mut self, path: PathBuf) -> BitFunResult<WorkspaceInfo> {
        self.open_workspace_with_options(path, OpenWorkspaceOptions::default())
            .await
    }

    /// Opens a workspace with options.
    pub async fn open_workspace_with_options(
        &mut self,
        path: PathBuf,
        options: OpenWorkspaceOptions,
    ) -> BitFunResult<WorkspaceInfo> {
        if !path.exists() {
            return Err(BitFunError::service(format!(
                "Workspace path does not exist: {:?}",
                path
            )));
        }

        if !path.is_dir() {
            return Err(BitFunError::service(format!(
                "Workspace path is not a directory: {:?}",
                path
            )));
        }

        let existing_workspace_id = self
            .workspaces
            .values()
            .find(|w| w.root_path == path)
            .map(|w| w.id.clone());

        if let Some(workspace_id) = existing_workspace_id {
            self.set_current_workspace_with_options(workspace_id.clone(), options.add_to_recent)?;
            if !options.metadata.is_empty() {
                if let Some(workspace) = self.workspaces.get_mut(&workspace_id) {
                    workspace.metadata.extend(options.metadata);
                }
            }
            return Ok(self.workspaces.get(&workspace_id).unwrap().clone());
        }

        let mut workspace = WorkspaceInfo::new(path, ScanOptions::default()).await?;
        if !options.metadata.is_empty() {
            workspace.metadata.extend(options.metadata);
        }
        let workspace_id = workspace.id.clone();

        self.workspaces
            .insert(workspace_id.clone(), workspace.clone());
        self.set_current_workspace_with_options(workspace_id.clone(), options.add_to_recent)?;

        Ok(workspace)
    }

    /// Closes the current workspace.
    pub fn close_current_workspace(&mut self) -> BitFunResult<()> {
        if let Some(workspace_id) = &self.current_workspace_id {
            if let Some(workspace) = self.workspaces.get_mut(workspace_id) {
                workspace.status = WorkspaceStatus::Inactive;
            }
            self.current_workspace_id = None;
        }
        Ok(())
    }

    /// Closes the specified workspace.
    pub fn close_workspace(&mut self, workspace_id: &str) -> BitFunResult<()> {
        if let Some(workspace) = self.workspaces.get_mut(workspace_id) {
            workspace.status = WorkspaceStatus::Inactive;

            if self.current_workspace_id.as_ref() == Some(&workspace_id.to_string()) {
                self.current_workspace_id = None;
            }
        }
        Ok(())
    }

    /// Sets the current workspace.
    pub fn set_current_workspace(&mut self, workspace_id: String) -> BitFunResult<()> {
        self.set_current_workspace_with_options(workspace_id, true)
    }

    /// Sets the current workspace, optionally updating the recent-workspaces list.
    pub fn set_current_workspace_with_options(
        &mut self,
        workspace_id: String,
        add_to_recent: bool,
    ) -> BitFunResult<()> {
        if !self.workspaces.contains_key(&workspace_id) {
            return Err(BitFunError::service(format!(
                "Workspace not found: {}",
                workspace_id
            )));
        }

        if let Some(workspace) = self.workspaces.get_mut(&workspace_id) {
            workspace.status = WorkspaceStatus::Active;
            workspace.touch();
        }

        self.current_workspace_id = Some(workspace_id.clone());

        if add_to_recent {
            self.update_recent_workspaces(workspace_id);
        }

        Ok(())
    }

    /// Gets the current workspace.
    pub fn get_current_workspace(&self) -> Option<&WorkspaceInfo> {
        if let Some(workspace_id) = &self.current_workspace_id {
            self.workspaces.get(workspace_id)
        } else {
            None
        }
    }

    /// Gets a workspace by id.
    pub fn get_workspace(&self, workspace_id: &str) -> Option<&WorkspaceInfo> {
        self.workspaces.get(workspace_id)
    }

    /// Lists all workspaces.
    pub fn list_workspaces(&self) -> Vec<WorkspaceSummary> {
        self.workspaces.values().map(|w| w.get_summary()).collect()
    }

    /// Returns recently accessed workspace records.
    pub fn get_recent_workspace_infos(&self) -> Vec<&WorkspaceInfo> {
        self.recent_workspaces
            .iter()
            .filter_map(|id| self.workspaces.get(id))
            .collect()
    }

    /// Searches workspaces.
    pub fn search_workspaces(&self, query: &str) -> Vec<WorkspaceSummary> {
        let query_lower = query.to_lowercase();

        self.workspaces
            .values()
            .filter(|workspace| {
                workspace.name.to_lowercase().contains(&query_lower)
                    || workspace
                        .root_path
                        .to_string_lossy()
                        .to_lowercase()
                        .contains(&query_lower)
                    || workspace
                        .languages
                        .iter()
                        .any(|lang| lang.to_lowercase().contains(&query_lower))
                    || workspace
                        .tags
                        .iter()
                        .any(|tag| tag.to_lowercase().contains(&query_lower))
            })
            .map(|w| w.get_summary())
            .collect()
    }

    /// Removes a workspace.
    pub fn remove_workspace(&mut self, workspace_id: &str) -> BitFunResult<()> {
        if let Some(_) = self.workspaces.remove(workspace_id) {
            if self.current_workspace_id.as_ref() == Some(&workspace_id.to_string()) {
                self.current_workspace_id = None;
            }

            self.recent_workspaces.retain(|id| id != workspace_id);

            Ok(())
        } else {
            Err(BitFunError::service(format!(
                "Workspace not found: {}",
                workspace_id
            )))
        }
    }

    /// Cleans up invalid workspaces.
    pub async fn cleanup_invalid_workspaces(&mut self) -> BitFunResult<usize> {
        let mut invalid_workspaces = Vec::new();

        for (workspace_id, workspace) in &self.workspaces {
            if !workspace.is_valid().await {
                invalid_workspaces.push(workspace_id.clone());
            }
        }

        let count = invalid_workspaces.len();
        for workspace_id in invalid_workspaces {
            self.remove_workspace(&workspace_id)?;
        }

        Ok(count)
    }

    /// Updates the recent-workspaces list.
    fn update_recent_workspaces(&mut self, workspace_id: String) {
        self.recent_workspaces.retain(|id| id != &workspace_id);

        self.recent_workspaces.insert(0, workspace_id);

        if self.recent_workspaces.len() > self.max_recent_workspaces {
            self.recent_workspaces.truncate(self.max_recent_workspaces);
        }
    }

    /// Returns manager statistics.
    pub fn get_statistics(&self) -> WorkspaceManagerStatistics {
        let mut stats = WorkspaceManagerStatistics::default();

        stats.total_workspaces = self.workspaces.len();

        for workspace in self.workspaces.values() {
            match workspace.status {
                WorkspaceStatus::Active => stats.active_workspaces += 1,
                WorkspaceStatus::Inactive => stats.inactive_workspaces += 1,
                WorkspaceStatus::Archived => stats.archived_workspaces += 1,
                _ => {}
            }

            *stats
                .workspaces_by_type
                .entry(workspace.workspace_type.clone())
                .or_insert(0) += 1;

            if let Some(statistics) = &workspace.statistics {
                stats.total_files += statistics.total_files;
                stats.total_size_bytes += statistics.total_size_bytes;
            }
        }

        stats
    }

    /// Returns the number of workspaces.
    pub fn get_workspace_count(&self) -> usize {
        self.workspaces.len()
    }

    /// Returns an immutable reference to the workspace map (for export).
    pub fn get_workspaces(&self) -> &HashMap<String, WorkspaceInfo> {
        &self.workspaces
    }

    /// Returns a mutable reference to the workspace map (for import).
    pub fn get_workspaces_mut(&mut self) -> &mut HashMap<String, WorkspaceInfo> {
        &mut self.workspaces
    }

    /// Returns a reference to the recent-workspaces list.
    pub fn get_recent_workspaces(&self) -> &Vec<String> {
        &self.recent_workspaces
    }

    /// Sets the recent-workspaces list.
    pub fn set_recent_workspaces(&mut self, recent: Vec<String>) {
        self.recent_workspaces = recent;
    }
}

/// Workspace manager statistics.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct WorkspaceManagerStatistics {
    pub total_workspaces: usize,
    pub active_workspaces: usize,
    pub inactive_workspaces: usize,
    pub archived_workspaces: usize,
    pub total_files: usize,
    pub total_size_bytes: u64,
    pub workspaces_by_type: HashMap<WorkspaceType, usize>,
}
