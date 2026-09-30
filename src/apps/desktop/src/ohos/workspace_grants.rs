//! Directories the user has authorized for work outside the application sandbox.
//!
//! HarmonyOS persists a grant against the directory URI, not the path, and the
//! grant stays inert until a process reactivates it. The Ability reactivates
//! everything recorded here before the product runtime starts, which is what
//! lets the agent's shell, git and tooling - child processes of this one -
//! reach an authorized workspace at all.
//!
//! Only the URI is stored. The path is derived from the URI after activation,
//! so a stale path can never be mistaken for live access.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Read by the Ability at startup; see src/apps/ohos/.../WorkspaceAccess.ets.
const FILE_NAME: &str = "harmony-workspace-grants.json";

#[derive(Debug, Default, Serialize, Deserialize)]
struct Grants {
    #[serde(default)]
    uris: Vec<String>,
}

fn grants_file() -> Option<PathBuf> {
    let home = std::env::var("OPENBITFUN_HOME").ok()?;
    Some(PathBuf::from(home).join(FILE_NAME))
}

fn load(path: &PathBuf) -> Grants {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Grants::default();
    };
    serde_json::from_str(&raw).unwrap_or_else(|error| {
        log::warn!("Discarding unreadable HarmonyOS workspace grants: {error}");
        Grants::default()
    })
}

/// Record newly authorized directories so later runs reactivate them.
///
/// Losing this record does not lose the system grant, but the directory then
/// stays unreachable until the user picks it again, so report a write failure.
pub fn remember(uris: &[String]) {
    if uris.is_empty() {
        return;
    }
    let Some(path) = grants_file() else {
        log::warn!("HarmonyOS workspace grants cannot be recorded: product home is unset");
        return;
    };
    let mut grants = load(&path);
    let added = uris
        .iter()
        .filter(|uri| !grants.uris.iter().any(|known| known == *uri))
        .cloned()
        .collect::<Vec<_>>();
    if added.is_empty() {
        return;
    }
    grants.uris.extend(added);
    let encoded = match serde_json::to_string(&grants) {
        Ok(encoded) => encoded,
        Err(error) => {
            log::warn!("Could not encode HarmonyOS workspace grants: {error}");
            return;
        }
    };
    // Replace atomically: a truncated file would drop every earlier grant.
    let temporary = path.with_extension("json.tmp");
    if let Err(error) =
        std::fs::write(&temporary, encoded).and_then(|_| std::fs::rename(&temporary, &path))
    {
        let _ = std::fs::remove_file(&temporary);
        log::warn!("Could not record HarmonyOS workspace grants: {error}");
        return;
    }
    log::info!(
        "HarmonyOS workspace grants recorded: total={}",
        grants.uris.len()
    );
}
