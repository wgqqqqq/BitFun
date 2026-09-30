//! Unsupported native control commands remain callable on the HarmonyOS host.
use serde_json::Value;

#[tauri::command]
pub async fn computer_use_control_status() -> Result<Value, String> {
    Err("Native computer automation is not implemented on HarmonyOS PC".into())
}

#[tauri::command]
pub async fn computer_use_share_targets() -> Result<Value, String> {
    Err("Native computer automation is not implemented on HarmonyOS PC".into())
}

#[tauri::command]
pub async fn computer_use_share_grants() -> Result<Value, String> {
    Err("Native computer automation is not implemented on HarmonyOS PC".into())
}

#[tauri::command]
pub async fn computer_use_control_stop(request: Value) -> Result<Value, String> {
    let _ = request;
    Err("Native computer automation is not implemented on HarmonyOS PC".into())
}

#[tauri::command]
pub async fn computer_use_control_preview(request: Value) -> Result<Value, String> {
    let _ = request;
    Err("Native computer automation is not implemented on HarmonyOS PC".into())
}

#[tauri::command]
pub async fn computer_use_share_start(request: Value) -> Result<Value, String> {
    let _ = request;
    Err("Native computer automation is not implemented on HarmonyOS PC".into())
}

#[tauri::command]
pub async fn computer_use_share_control(request: Value) -> Result<Value, String> {
    let _ = request;
    Err("Native computer automation is not implemented on HarmonyOS PC".into())
}

#[tauri::command]
pub async fn computer_use_share_request(request: Value) -> Result<Value, String> {
    let _ = request;
    Err("Native computer automation is not implemented on HarmonyOS PC".into())
}

#[tauri::command]
pub async fn computer_use_share_forget_grant(request: Value) -> Result<Value, String> {
    let _ = request;
    Err("Native computer automation is not implemented on HarmonyOS PC".into())
}

#[tauri::command]
pub async fn computer_use_share_observe(request: Value) -> Result<Value, String> {
    let _ = request;
    Err("Native computer automation is not implemented on HarmonyOS PC".into())
}

#[tauri::command]
pub async fn computer_use_share_input(request: Value) -> Result<Value, String> {
    let _ = request;
    Err("Native computer automation is not implemented on HarmonyOS PC".into())
}
