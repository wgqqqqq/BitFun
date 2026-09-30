//! Await native window operations; never report a queued callback as success.
use napi_ohos::{bindgen_prelude::Promise, threadsafe_function::ThreadsafeFunction};
use std::sync::{Arc, OnceLock, RwLock};
type WindowCallback = ThreadsafeFunction<String, Promise<bool>>;
static CALLBACK: OnceLock<RwLock<Option<Arc<WindowCallback>>>> = OnceLock::new();

#[napi_derive_ohos::napi]
pub fn register_window_operation(callback: WindowCallback) -> napi_ohos::Result<()> {
    let mut slot = CALLBACK
        .get_or_init(Default::default)
        .write()
        .map_err(|_| napi_ohos::Error::from_reason("HarmonyOS window bridge lock poisoned"))?;
    *slot = Some(Arc::new(callback));
    Ok(())
}

pub enum WindowAction {
    GetState,
    ToggleMaximize,
    Minimize,
    Maximize,
    Show,
}

pub async fn perform(action: WindowAction) -> Result<bool, String> {
    let name = match action {
        WindowAction::GetState => "get_state",
        WindowAction::ToggleMaximize => "toggle_maximize",
        WindowAction::Minimize => "minimize",
        WindowAction::Maximize => "maximize",
        WindowAction::Show => "show",
    };
    let callback = CALLBACK
        .get_or_init(Default::default)
        .read()
        .map_err(|_| "HarmonyOS window bridge lock poisoned".to_string())?
        .clone()
        .ok_or_else(|| "HarmonyOS window host is not initialized".to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(10), async move {
        callback
            .call_async(Ok(name.to_string()))
            .await
            .map_err(|e| e.to_string())?
            .await
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|_| "HarmonyOS window operation timed out".to_string())?
}
