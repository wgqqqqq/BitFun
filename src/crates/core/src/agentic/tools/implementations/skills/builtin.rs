//! Built-in skills shipped with BitFun.
//!
//! These skills are embedded into the `bitfun-core` binary and installed into a
//! managed `.system` directory under the user skills root on demand.

use crate::infrastructure::get_path_manager_arc;
use crate::util::errors::BitFunResult;
use include_dir::{include_dir, Dir};
use log::{debug, error, warn};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tokio::fs;

static BUILTIN_SKILLS_DIR: Dir = include_dir!("$CARGO_MANIFEST_DIR/builtin_skills");
static BUILTIN_SKILL_DIR_NAMES: OnceLock<HashSet<String>> = OnceLock::new();
include!(concat!(env!("OUT_DIR"), "/embedded_builtin_skills.rs"));

const BUILTIN_SKILLS_MANIFEST_FILE_NAME: &str = ".manifest.json";
const LEGACY_BUILTIN_SKILL_DIR_NAMES: &[&str] = &[
    // Historical bundled "Superpowers" skills removed in 2026-04.
    "brainstorming",
    "dispatching-parallel-agents",
    "executing-plans",
    "finishing-a-development-branch",
    "receiving-code-review",
    "requesting-code-review",
    "subagent-driven-development",
    "systematic-debugging",
    "test-driven-development",
    "using-git-worktrees",
    "using-superpowers",
    "verification-before-completion",
    "writing-plans",
    // Earlier built-in skill bundled before the Superpowers set.
    "skill-creator",
];
const LEGACY_BUILTIN_ROOT_FILES: &[&str] = &["SUPERPOWERS_LICENSE.txt"];

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BuiltinSkillsManifest {
    bundle_hash: String,
}

fn collect_builtin_skill_dir_names() -> HashSet<String> {
    BUILTIN_SKILLS_DIR
        .dirs()
        .filter_map(|dir| {
            let rel = dir.path();
            if rel.components().count() != 1 {
                return None;
            }

            rel.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.to_string())
        })
        .collect()
}

pub fn builtin_skill_dir_names() -> &'static HashSet<String> {
    BUILTIN_SKILL_DIR_NAMES.get_or_init(collect_builtin_skill_dir_names)
}

pub fn builtin_skills_bundle_hash() -> &'static str {
    BUILTIN_SKILLS_BUNDLE_HASH
}

pub fn is_builtin_skill_dir_name(dir_name: &str) -> bool {
    builtin_skill_dir_names().contains(dir_name)
}

pub fn builtin_skill_group_key(dir_name: &str) -> Option<&'static str> {
    match dir_name {
        "docx" | "pdf" | "pptx" | "xlsx" => Some("office"),
        "find-skills" | "writing-skills" => Some("meta"),
        "agent-browser" => Some("computer-use"),
        _ if dir_name.starts_with("gstack-") => Some("team"),
        _ => None,
    }
}

pub fn is_team_skill(dir_name: &str) -> bool {
    builtin_skill_group_key(dir_name) == Some("team")
}

fn builtin_skills_manifest_path(root: &Path) -> PathBuf {
    root.join(BUILTIN_SKILLS_MANIFEST_FILE_NAME)
}

async fn read_installed_manifest(root: &Path) -> BitFunResult<Option<BuiltinSkillsManifest>> {
    let path = builtin_skills_manifest_path(root);
    match fs::read_to_string(&path).await {
        Ok(content) => match serde_json::from_str::<BuiltinSkillsManifest>(&content) {
            Ok(manifest) => Ok(Some(manifest)),
            Err(error) => {
                warn!(
                    "Invalid built-in skills manifest at {}: {}",
                    path.display(),
                    error
                );
                Ok(None)
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

async fn write_installed_manifest(root: &Path) -> BitFunResult<()> {
    let path = builtin_skills_manifest_path(root);
    let manifest = BuiltinSkillsManifest {
        bundle_hash: builtin_skills_bundle_hash().to_string(),
    };
    let content = serde_json::to_vec_pretty(&manifest)?;
    fs::write(path, content).await?;
    Ok(())
}

async fn remove_existing_path(path: &Path) -> BitFunResult<()> {
    let Ok(metadata) = fs::symlink_metadata(path).await else {
        return Ok(());
    };

    if metadata.is_dir() {
        fs::remove_dir_all(path).await?;
    } else {
        fs::remove_file(path).await?;
    }

    Ok(())
}

async fn cleanup_legacy_builtin_dirs(legacy_root: &Path) -> BitFunResult<()> {
    for dir_name in builtin_skill_dir_names() {
        let path = legacy_root.join(dir_name);
        remove_existing_path(&path).await?;
    }

    for dir_name in LEGACY_BUILTIN_SKILL_DIR_NAMES {
        let path = legacy_root.join(dir_name);
        remove_existing_path(&path).await?;
    }

    for file_name in LEGACY_BUILTIN_ROOT_FILES {
        let path = legacy_root.join(file_name);
        remove_existing_path(&path).await?;
    }

    Ok(())
}

pub async fn ensure_builtin_skills_installed() -> BitFunResult<()> {
    let pm = get_path_manager_arc();
    let legacy_root = pm.user_skills_dir();
    let dest_root = pm.builtin_skills_dir();
    let system_dir_preexisting = fs::symlink_metadata(&dest_root).await.is_ok();

    // Create the parent user skills directory and managed builtin directory if needed.
    if let Err(e) = fs::create_dir_all(&legacy_root).await {
        error!(
            "Failed to create user skills directory: path={}, error={}",
            legacy_root.display(),
            e
        );
        return Err(e.into());
    }

    if !system_dir_preexisting {
        cleanup_legacy_builtin_dirs(&legacy_root).await?;

        if let Err(e) = fs::create_dir_all(&dest_root).await {
            error!(
                "Failed to create built-in skills directory: path={}, error={}",
                dest_root.display(),
                e
            );
            return Err(e.into());
        }
    }

    if let Some(manifest) = read_installed_manifest(&dest_root).await? {
        if manifest.bundle_hash == builtin_skills_bundle_hash() {
            return Ok(());
        }
    }

    if let Err(error) = fs::remove_dir_all(&dest_root).await {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(error.into());
        }
    }
    fs::create_dir_all(&dest_root).await?;

    let mut installed = 0usize;
    let mut updated = 0usize;
    for skill_dir in BUILTIN_SKILLS_DIR.dirs() {
        let rel = skill_dir.path();
        if rel.components().count() != 1 {
            continue;
        }

        let stats = sync_dir(skill_dir, &dest_root).await?;
        installed += stats.installed;
        updated += stats.updated;
    }

    write_installed_manifest(&dest_root).await?;

    if installed > 0 || updated > 0 {
        debug!(
            "Built-in skills synchronized: installed={}, updated={}, dest_root={}",
            installed,
            updated,
            dest_root.display()
        );
    }

    Ok(())
}

#[derive(Default)]
struct SyncStats {
    installed: usize,
    updated: usize,
}

async fn sync_dir(dir: &Dir<'_>, dest_root: &Path) -> BitFunResult<SyncStats> {
    let mut files: Vec<&include_dir::File<'_>> = Vec::new();
    collect_files(dir, &mut files);

    let mut stats = SyncStats::default();
    for file in files.into_iter() {
        let dest_path = safe_join(dest_root, file.path())?;
        let desired = desired_file_content(file, &dest_path).await?;

        if let Ok(current) = fs::read(&dest_path).await {
            if current == desired {
                continue;
            }
        }

        if let Some(parent) = dest_path.parent() {
            fs::create_dir_all(parent).await?;
        }
        let existed = dest_path.exists();
        fs::write(&dest_path, desired).await?;
        if existed {
            stats.updated += 1;
        } else {
            stats.installed += 1;
        }
    }

    Ok(stats)
}

fn collect_files<'a>(dir: &'a Dir<'a>, out: &mut Vec<&'a include_dir::File<'a>>) {
    for file in dir.files() {
        out.push(file);
    }

    for sub in dir.dirs() {
        collect_files(sub, out);
    }
}

fn safe_join(root: &Path, relative: &Path) -> BitFunResult<PathBuf> {
    if relative.is_absolute() {
        return Err(crate::util::errors::BitFunError::validation(format!(
            "Unexpected absolute path in built-in skills: {}",
            relative.display()
        )));
    }

    // Prevent `..` traversal even though include_dir should only contain clean relative paths.
    for c in relative.components() {
        if matches!(c, std::path::Component::ParentDir) {
            return Err(crate::util::errors::BitFunError::validation(format!(
                "Unexpected parent dir component in built-in skills path: {}",
                relative.display()
            )));
        }
    }

    Ok(root.join(relative))
}

async fn desired_file_content(
    file: &include_dir::File<'_>,
    _dest_path: &Path,
) -> BitFunResult<Vec<u8>> {
    Ok(file.contents().to_vec())
}

#[cfg(test)]
mod tests {
    use super::builtin_skill_group_key;

    #[test]
    fn builtin_skill_groups_match_expected_sets() {
        assert_eq!(builtin_skill_group_key("docx"), Some("office"));
        assert_eq!(builtin_skill_group_key("pdf"), Some("office"));
        assert_eq!(builtin_skill_group_key("pptx"), Some("office"));
        assert_eq!(builtin_skill_group_key("xlsx"), Some("office"));
        assert_eq!(builtin_skill_group_key("find-skills"), Some("meta"));
        assert_eq!(builtin_skill_group_key("writing-skills"), Some("meta"));
        assert_eq!(
            builtin_skill_group_key("agent-browser"),
            Some("computer-use")
        );
        assert_eq!(builtin_skill_group_key("unknown-skill"), None);
        assert_eq!(builtin_skill_group_key("gstack-review"), Some("team"));
        assert_eq!(builtin_skill_group_key("gstack-ship"), Some("team"));
        assert_eq!(builtin_skill_group_key("gstack-qa"), Some("team"));
        assert_eq!(builtin_skill_group_key("gstack-cso"), Some("team"));
    }
}
