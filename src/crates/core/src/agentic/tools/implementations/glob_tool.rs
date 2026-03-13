use crate::agentic::tools::framework::{Tool, ToolResult, ToolUseContext};
use crate::util::errors::{BitFunError, BitFunResult};
use async_trait::async_trait;
use globset::GlobBuilder;
use ignore::WalkBuilder;
use log::warn;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Search for files matching a glob pattern with optional gitignore and hidden file filtering
///
/// # Arguments
/// * `search_path` - The root directory to search in
/// * `pattern` - Glob pattern relative to search_path (e.g., "*.rs", "**/*.txt")
/// * `ignore` - If true, apply .gitignore rules
/// * `ignore_hidden` - If true, skip hidden files; if false, include them
///
/// # Returns
/// A Result containing a Vec of matched file paths as Strings
///
/// # Behavior
/// - Symlinks are not followed;
pub fn glob_with_ignore(
    search_path: &str,
    pattern: &str,
    ignore: bool,
    ignore_hidden: bool,
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    // Validate search path
    let path = std::path::Path::new(search_path);
    if !path.exists() {
        return Err(format!("Search path '{}' does not exist", search_path).into());
    }
    if !path.is_dir() {
        return Err(format!("Search path '{}' is not a directory", search_path).into());
    }

    // Convert search_path to absolute path at the beginning
    // Use dunce::canonicalize to avoid Windows UNC path format (\\?\)
    let search_path_abs = dunce::canonicalize(Path::new(search_path))?;
    let search_path_str = search_path_abs.to_string_lossy();

    // Convert pattern to absolute form by joining with search_path
    // This ensures pattern matching works with absolute paths
    let absolute_pattern = format!("{}/{}", search_path_str, pattern);

    // Compile the glob pattern
    let glob = GlobBuilder::new(&absolute_pattern)
        .literal_separator(true)
        .build()?
        .compile_matcher();

    // Build the directory walker with specified options using absolute path
    let walker = WalkBuilder::new(&search_path_abs)
        .git_ignore(ignore) // Apply gitignore rules if ignore is true
        .hidden(ignore_hidden) // Skip hidden files if ignore_hidden is true
        .build();

    let mut results = Vec::new();

    // Walk the directory tree
    for entry in walker {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                // The filesystem can change during a walk (e.g. files deleted), or there may be
                // broken/permission-denied entries. A single unreadable entry should not fail the
                // entire glob.
                warn!("Glob walker entry error (skipped): {}", err);
                continue;
            }
        };
        let path = entry.path().to_path_buf();

        // Match against the glob pattern using absolute path
        // Since pattern is now absolute, match directly against the path
        if glob.is_match(&path) {
            // Use dunce::simplified to convert UNC paths to standard Windows paths
            let simplified_path = dunce::simplified(&path);
            results.push(simplified_path.to_string_lossy().to_string());
        }
    }

    Ok(results)
}

fn limit_paths(paths: &[String], limit: usize) -> Vec<String> {
    let mut depth_and_paths = paths
        .iter()
        .map(|path| {
            let normalized_path = path.replace('\\', "/");
            let n = normalized_path.split('/').count();
            (n, normalized_path)
        })
        .collect::<Vec<_>>();
    depth_and_paths.sort_by_key(|(depth, _)| *depth);
    let mut result = depth_and_paths
        .into_iter()
        .take(limit)
        .map(|(_, path)| path)
        .collect::<Vec<_>>();
    result.sort();
    result
}

fn call_glob(search_path: &str, pattern: &str, limit: usize) -> Result<Vec<String>, String> {
    // Check if pattern targets whitelisted directories
    let is_whitelisted = pattern.starts_with(".bitfun")
        || pattern.contains("/.bitfun")
        || pattern.contains("\\.bitfun");

    // Disable gitignore for whitelisted directories to allow searching
    let apply_gitignore = !is_whitelisted;

    // Disable hidden file filtering for whitelisted directories
    let ignore_hidden_files = !is_whitelisted;

    let all_paths = glob_with_ignore(search_path, pattern, apply_gitignore, ignore_hidden_files)
        .map_err(|e| e.to_string())?;
    let limited_paths = limit_paths(&all_paths, limit);
    Ok(limited_paths)
}

pub struct GlobTool;

impl GlobTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Tool for GlobTool {
    fn name(&self) -> &str {
        "Glob"
    }

    async fn description(&self) -> BitFunResult<String> {
        Ok(r#"Fast file pattern matching tool support Standard Unix-style glob syntax
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths
- Use this tool when you need to find files by name patterns
- You can call multiple tools in a single response. It is always better to speculatively perform multiple searches in parallel if they are potentially useful.
<example>
- List files and directories in path: path = "/path/to/search", pattern = "*"
- Search all markdown files in path recursively: path = "/path/to/search", pattern = "**/*.md"
</example>
"#.to_string())
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "The glob pattern to match files against (relative to `path`)"
                },
                "path": {
                    "type": "string",
                    "description": "The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter \"undefined\" or \"null\" - simply omit it for the default behavior. Must be a valid absolute path if provided."
                },
                "limit": {
                    "type": "number",
                    "description": "The maximum number of entries to return. Defaults to 100."
                }
            },
            "required": ["pattern"]
        })
    }

    fn is_readonly(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }

    fn needs_permissions(&self, _input: Option<&Value>) -> bool {
        false
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> BitFunResult<Vec<ToolResult>> {
        let pattern = input
            .get("pattern")
            .and_then(|v| v.as_str())
            .ok_or_else(|| BitFunError::tool("pattern is required".to_string()))?;

        let resolved_path = match input.get("path").and_then(|v| v.as_str()) {
            Some(user_path) if Path::new(user_path).is_absolute() => PathBuf::from(user_path),
            Some(user_path) => {
                let workspace_root = context.workspace_root().ok_or_else(|| {
                    BitFunError::tool(format!(
                        "workspace_path is required to resolve relative search path: {}",
                        user_path
                    ))
                })?;
                workspace_root.join(user_path)
            }
            None => context.workspace_root().map(PathBuf::from).ok_or_else(|| {
                BitFunError::tool(
                    "workspace_path is required when Glob path is omitted".to_string(),
                )
            })?,
        };

        let limit = input
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(100);

        let matches = call_glob(&resolved_path.display().to_string(), pattern, limit)
            .map_err(|e| BitFunError::tool(e))?;

        let result_text = if matches.is_empty() {
            format!("No files found matching pattern '{}'", pattern)
        } else {
            matches.join("\n")
        };

        let result = ToolResult::Result {
            data: json!({
                "pattern": pattern,
                "path": resolved_path.display().to_string(),
                "matches": matches,
                "match_count": matches.len()
            }),
            result_for_assistant: Some(result_text),
        };

        Ok(vec![result])
    }
}
