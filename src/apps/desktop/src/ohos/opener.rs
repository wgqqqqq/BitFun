//! Controller-local system browser bridge; never forward OAuth links to a peer.
use napi_ohos::{bindgen_prelude::Promise, threadsafe_function::ThreadsafeFunction};
use std::sync::{Arc, OnceLock};

type OpenCallback = ThreadsafeFunction<String, Promise<bool>>;
static CALLBACK: OnceLock<Arc<OpenCallback>> = OnceLock::new();

#[napi_derive_ohos::napi]
pub fn register_external_url_opener(callback: OpenCallback) -> napi_ohos::Result<()> {
    CALLBACK
        .set(Arc::new(callback))
        .map_err(|_| napi_ohos::Error::from_reason("System browser bridge already initialized"))
}

#[tauri::command]
async fn open_url(url: String, with: Option<String>) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "Invalid external URL")?;
    if !matches!(parsed.scheme(), "https" | "http")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || with.is_some()
    {
        return Err(
            "HarmonyOS system browser supports HTTP(S) URLs without an explicit application".into(),
        );
    }
    let callback = CALLBACK
        .get()
        .cloned()
        .ok_or("System browser bridge is unavailable")?;
    let opened = tokio::time::timeout(std::time::Duration::from_secs(15), async move {
        callback
            .call_async(Ok(url))
            .await
            .map_err(|_| "System browser request failed")?
            .await
            .map_err(|_| "System browser could not open the link")
    })
    .await
    .map_err(|_| "System browser request timed out")??;
    if opened {
        Ok(())
    } else {
        Err("System browser did not accept the link".into())
    }
}

pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("opener")
        .invoke_handler(tauri::generate_handler![open_url])
        .build()
}
