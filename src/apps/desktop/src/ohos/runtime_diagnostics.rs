//! Explicit, read-only validation of the native worker stack and Skill path.
use std::sync::atomic::{AtomicBool, Ordering};

static REQUESTED: AtomicBool = AtomicBool::new(false);

pub fn request(enabled: bool) {
    REQUESTED.store(enabled, Ordering::Release);
}

// This deliberately exceeds the old 2 MiB stack. Keeping it synchronous and
// non-inlined measures the worker's native stack rather than a heap Future.
#[inline(never)]
fn stack_probe() -> u8 {
    let mut bytes = [0_u8; 3 * 1024 * 1024];
    std::hint::black_box(&mut bytes);
    bytes[0] = 1;
    bytes[bytes.len() - 1] = 2;
    std::hint::black_box(bytes[0] + bytes[bytes.len() - 1])
}

pub fn run_if_requested() {
    if !REQUESTED.swap(false, Ordering::AcqRel) {
        return;
    }
    tauri::async_runtime::spawn(async {
        let async_stack = stack_probe();
        let blocking_stack = match tauri::async_runtime::spawn_blocking(stack_probe).await {
            Ok(value) => value,
            Err(error) => {
                log::error!("HarmonyOS runtime diagnostic blocking task failed: {error}");
                return;
            }
        };
        let result =
            crate::api::tool_api::execute_tool(crate::api::tool_api::ToolExecutionRequest {
                tool_name: "Skill".into(),
                input: serde_json::json!({"command":"miniapp-dev"}),
                workspace_id: None,
                workspace_path: None,
                context: None,
                safe_mode: Some(true),
            })
            .await;
        match result {
            Ok(response) if response.success => log::info!(
                "HarmonyOS runtime diagnostic completed: async_stack_probe={} blocking_stack_probe={} miniapp_skill_loaded=true",
                async_stack == 3, blocking_stack == 3
            ),
            Ok(response) => log::error!(
                "HarmonyOS runtime diagnostic Skill load failed: error={:?} validation_error={:?}",
                response.error, response.validation_error
            ),
            Err(error) => log::error!("HarmonyOS runtime diagnostic failed: {error}"),
        }
    });
}
