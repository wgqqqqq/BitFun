//! Controller-local native container for the existing companion WebView.
use napi_ohos::{bindgen_prelude::Promise, threadsafe_function::ThreadsafeFunction};
use std::sync::{Arc, OnceLock, RwLock};
use tauri::Manager;

type Callback = ThreadsafeFunction<String, Promise<String>>;
static CALLBACK: OnceLock<RwLock<Option<Arc<Callback>>>> = OnceLock::new();
pub const LABEL: &str = "agent-companion-pet";

#[napi_derive_ohos::napi]
pub fn register_companion_operation(callback: Callback) -> napi_ohos::Result<()> {
    *CALLBACK
        .get_or_init(Default::default)
        .write()
        .map_err(|_| napi_ohos::Error::from_reason("Companion bridge lock poisoned"))? =
        Some(Arc::new(callback));
    Ok(())
}

pub async fn perform(request: serde_json::Value) -> Result<serde_json::Value, String> {
    let callback = CALLBACK
        .get_or_init(Default::default)
        .read()
        .map_err(|_| "Companion bridge lock poisoned")?
        .clone()
        .ok_or("HarmonyOS companion host is not ready")?;
    let response = tokio::time::timeout(std::time::Duration::from_secs(15), async move {
        callback
            .call_async(Ok(request.to_string()))
            .await
            .map_err(|e| e.to_string())?
            .await
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|_| "Companion window operation timed out")??;
    serde_json::from_str(&response).map_err(|e| e.to_string())
}

#[tauri::command]
async fn operation(
    webview: tauri::Webview,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if webview.label() != LABEL {
        return Err("Only the companion surface can control its window".into());
    }
    match request.get("action").and_then(|v| v.as_str()) {
        Some("hide") => hide(webview.app_handle())
            .await
            .map(|_| serde_json::json!({})),
        Some("position" | "move" | "scale" | "focus") => perform(request).await,
        _ => Err("Unsupported companion window operation".into()),
    }
}

pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("companion")
        .invoke_handler(tauri::generate_handler![operation])
        .build()
}

pub async fn show(app: &tauri::AppHandle, url: tauri::WebviewUrl) -> Result<(), String> {
    if app.get_webview(LABEL).is_none() {
        perform(serde_json::json!({"action":"prepare"})).await?;
        let main = app.get_window("main").ok_or("Main window is unavailable")?;
        let builder = tauri::webview::WebviewBuilder::new(LABEL, url)
            .transparent(true)
            .initialization_script(
                "Object.defineProperty(window, '__OPENBITFUN_COMPANION_HOST__', {value: 'ohos'});",
            );
        if let Err(error) = main.add_child(
            builder,
            tauri::LogicalPosition::new(0.0, 0.0),
            tauri::LogicalSize::new(240.0, 240.0),
        ) {
            let _ = perform(serde_json::json!({"action":"destroy"})).await;
            return Err(error.to_string());
        }
    }
    if let Err(error) = perform(serde_json::json!({"action":"show"})).await {
        let _ = hide(app).await;
        return Err(error);
    }
    Ok(())
}

pub async fn hide(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview(LABEL) {
        webview.close().map_err(|e| e.to_string())?;
    }
    perform(serde_json::json!({"action":"destroy"}))
        .await
        .map(|_| ())
}
