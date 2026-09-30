//! HarmonyOS user-directory authorization bridge.
//!
//! HarmonyOS confines the application to its sandbox. A workspace outside the
//! sandbox is reachable only after the user picks it and the directory URI is
//! persisted, and the persisted grant must be reactivated in every process.
//! Never report an unactivated grant as usable access.
use napi_ohos::{bindgen_prelude::Promise, threadsafe_function::ThreadsafeFunction};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

type AccessCallback = ThreadsafeFunction<String, Promise<String>>;
static CALLBACK: OnceLock<Arc<AccessCallback>> = OnceLock::new();

#[napi_derive_ohos::napi]
pub fn register_workspace_access(callback: AccessCallback) -> napi_ohos::Result<()> {
    CALLBACK
        .set(Arc::new(callback))
        .map_err(|_| napi_ohos::Error::from_reason("Workspace access bridge already initialized"))
}

/// A directory the user authorized, as both its URI and its sandbox-visible path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorizedDirectory {
    /// Persisted authorization handle; the URI is what survives a restart.
    pub uri: String,
    /// Path the product uses once the grant is active for this process.
    pub path: String,
}

#[derive(Debug, Serialize)]
struct AccessRequest {
    action: &'static str,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    uris: Vec<String>,
    write: bool,
}

#[derive(Debug, Deserialize)]
struct AccessResponse {
    ok: bool,
    #[serde(default)]
    directories: Vec<AuthorizedDirectory>,
    #[serde(default)]
    granted: Vec<bool>,
    #[serde(default)]
    folder_authorization: bool,
    #[serde(default)]
    folder_selection: bool,
    #[serde(default)]
    error: Option<String>,
}

/// What this device actually supports; folder authorization is 2in1-only.
#[derive(Debug, Clone, Copy)]
pub struct Capability {
    pub folder_authorization: bool,
    pub folder_selection: bool,
}

async fn call(request: AccessRequest, timeout: Duration) -> Result<AccessResponse, String> {
    let payload = serde_json::to_string(&request)
        .map_err(|error| format!("Could not encode workspace access request: {error}"))?;
    let callback = CALLBACK
        .get()
        .cloned()
        .ok_or("HarmonyOS workspace access bridge is unavailable")?;
    let raw = tokio::time::timeout(timeout, async move {
        callback
            .call_async(Ok(payload))
            .await
            .map_err(|error| error.to_string())?
            .await
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| format!("Workspace access request '{}' timed out", request.action))??;
    let response: AccessResponse = serde_json::from_str(&raw)
        .map_err(|error| format!("Could not decode workspace access response: {error}"))?;
    if response.ok {
        Ok(response)
    } else {
        Err(response
            .error
            .unwrap_or_else(|| format!("Workspace access request '{}' failed", request.action)))
    }
}

pub async fn capability() -> Result<Capability, String> {
    let response = call(
        AccessRequest {
            action: "capability",
            uris: Vec::new(),
            write: false,
        },
        Duration::from_secs(10),
    )
    .await?;
    Ok(Capability {
        folder_authorization: response.folder_authorization,
        folder_selection: response.folder_selection,
    })
}

/// Show the system folder picker and persist whatever the user chooses.
/// The wait is long because it is bounded by the user, not by the system.
pub async fn pick_folder(write: bool) -> Result<Vec<AuthorizedDirectory>, String> {
    let response = call(
        AccessRequest {
            action: "pick_folder",
            uris: Vec::new(),
            write,
        },
        Duration::from_secs(300),
    )
    .await?;
    Ok(response.directories)
}

/// Reactivate persisted grants for this process and resolve their paths.
pub async fn activate(uris: Vec<String>, write: bool) -> Result<Vec<AuthorizedDirectory>, String> {
    if uris.is_empty() {
        return Ok(Vec::new());
    }
    let response = call(
        AccessRequest {
            action: "activate",
            uris,
            write,
        },
        Duration::from_secs(30),
    )
    .await?;
    Ok(response.directories)
}

/// Which of these URIs still hold a persisted grant, in the order given.
pub async fn check(uris: Vec<String>, write: bool) -> Result<Vec<bool>, String> {
    if uris.is_empty() {
        return Ok(Vec::new());
    }
    let response = call(
        AccessRequest {
            action: "check",
            uris,
            write,
        },
        Duration::from_secs(30),
    )
    .await?;
    Ok(response.granted)
}
