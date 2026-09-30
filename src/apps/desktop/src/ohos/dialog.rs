//! HarmonyOS stands in for `tauri-plugin-dialog`'s directory picker.
//!
//! The system folder picker is the only way out of the application sandbox, and
//! what it returns is an authorization rather than just a path: the grant is
//! persisted against the directory URI so the workspace is still reachable
//! after a restart. Everything else about the command matches the plugin's
//! existing contract, so the product's open/new-project flows are unchanged.
use super::{workspace_access, workspace_grants};
use serde::Deserialize;

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct OpenOptions {
    directory: bool,
    multiple: bool,
}

#[tauri::command]
async fn open(options: OpenOptions) -> Result<serde_json::Value, String> {
    if !options.directory {
        return Err(
            "HarmonyOS workspace access covers directories; file selection is not available yet"
                .into(),
        );
    }
    // Workspaces are written to, so ask for the grant the product actually needs.
    let directories = workspace_access::pick_folder(true).await?;
    workspace_grants::remember(
        &directories
            .iter()
            .map(|directory| directory.uri.clone())
            .collect::<Vec<_>>(),
    );
    let paths = directories
        .into_iter()
        .map(|directory| directory.path)
        .collect::<Vec<_>>();
    // The plugin contract reports a cancelled picker as null, not as an error.
    if paths.is_empty() {
        return Ok(serde_json::Value::Null);
    }
    Ok(if options.multiple {
        serde_json::json!(paths)
    } else {
        serde_json::json!(paths[0])
    })
}

pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("dialog")
        .invoke_handler(tauri::generate_handler![open])
        .build()
}
