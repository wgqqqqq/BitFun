//! Native HarmonyOS status-bar integration through DesktopExtensionKit.
use crate::startup_trace::DesktopStartupTrace;
use napi_ohos::{bindgen_prelude::Promise, threadsafe_function::ThreadsafeFunction};
use std::sync::{Arc, OnceLock};
use tauri::AppHandle;
type TrayCallback = ThreadsafeFunction<String, Promise<bool>>;
static CALLBACK: OnceLock<Arc<TrayCallback>> = OnceLock::new();

#[napi_derive_ohos::napi]
pub fn register_tray_operation(callback: TrayCallback) -> napi_ohos::Result<()> {
    CALLBACK
        .set(Arc::new(callback))
        .map_err(|_| napi_ohos::Error::from_reason("Tray bridge already initialized"))
}

pub async fn perform(action: String) -> Result<(), String> {
    let callback = CALLBACK
        .get()
        .cloned()
        .ok_or("Native tray bridge is unavailable")?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(15), async move {
        callback
            .call_async(Ok(action))
            .await
            .map_err(|error| error.to_string())?
            .await
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| "Native tray operation timed out")??;
    if result {
        Ok(())
    } else {
        Err("Native tray operation was rejected".into())
    }
}

pub async fn rebuild_tray_menu_public(_app: &AppHandle) {
    // The native menu restores the local Ability and is independent of sessions.
}
pub fn setup_tray(
    _app: &AppHandle,
    _trace: &DesktopStartupTrace,
) -> Result<(), Box<dyn std::error::Error>> {
    Err("Use the asynchronous HarmonyOS tray initializer".into())
}
pub async fn set_unread_count(count: u32) -> Result<(), String> {
    perform(format!("unread:{count}")).await
}
