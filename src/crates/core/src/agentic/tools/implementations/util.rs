use crate::util::errors::{BitFunError, BitFunResult};
use std::path::Path;
use std::path::{Component, PathBuf};

pub fn normalize_path(path: &str) -> String {
    let path = Path::new(path);
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {} // Ignore "."
            Component::ParentDir => {
                // Handle ".."
                if !components.is_empty() {
                    components.pop();
                }
            }
            c => components.push(c),
        }
    }
    components
        .iter()
        .collect::<PathBuf>()
        .to_string_lossy()
        .to_string()
}

pub fn resolve_path_with_workspace(
    path: &str,
    workspace_root: Option<&Path>,
) -> BitFunResult<String> {
    if Path::new(path).is_absolute() {
        Ok(normalize_path(path))
    } else {
        let workspace_path = workspace_root.ok_or_else(|| {
            BitFunError::tool(format!(
                "workspace_path is required to resolve relative path: {}",
                path
            ))
        })?;

        Ok(normalize_path(
            &workspace_path.join(path).to_string_lossy().to_string(),
        ))
    }
}

pub fn resolve_path(path: &str) -> BitFunResult<String> {
    resolve_path_with_workspace(path, None)
}
