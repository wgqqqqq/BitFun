//! HarmonyOS Ability entry for the current Desktop product.
//!
//! Keep the custom workbench protocol registered before ArkWeb initializes.
//! The generic Tauri mobile entry only registers Tauri's built-in schemes.

use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::ohos::{openharmony_ability, openharmony_ability_derive};

static DARK_MODE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[napi_derive_ohos::napi]
pub fn configure_system_dark_mode(dark: bool) {
    DARK_MODE.store(dark, std::sync::atomic::Ordering::Release);
}

pub fn system_dark_mode() -> bool {
    DARK_MODE.load(std::sync::atomic::Ordering::Acquire)
}

/// The Ability reads the Settings device name before starting the Rust host.
#[napi_derive_ohos::napi]
pub fn configure_device_display_name(name: String) -> napi_ohos::Result<()> {
    openbitfun_services_integrations::remote_connect::device::configure_host_device_name(&name)
        .map_err(|error| napi_ohos::Error::from_reason(error.to_string()))
}

#[napi_derive_ohos::napi]
pub fn configure_terminal_diagnostics(enabled: bool) -> napi_ohos::Result<()> {
    #[cfg(debug_assertions)]
    terminal_diagnostics::request(enabled);
    #[cfg(not(debug_assertions))]
    if enabled {
        return Err(napi_ohos::Error::from_reason(
            "Terminal diagnostics require a debug build",
        ));
    }
    Ok(())
}

#[napi_derive_ohos::napi]
pub fn configure_workspace_access_diagnostics(enabled: bool) -> napi_ohos::Result<()> {
    #[cfg(debug_assertions)]
    workspace_access_diagnostics::request(enabled);
    #[cfg(not(debug_assertions))]
    if enabled {
        return Err(napi_ohos::Error::from_reason(
            "Workspace access diagnostics require a debug build",
        ));
    }
    Ok(())
}

static RESOURCE_DIRECTORY: OnceLock<PathBuf> = OnceLock::new();

/// Called by the trusted Ability before starting the native lifecycle.
#[napi_derive_ohos::napi]
pub fn configure_resource_directory(directory: String) -> napi_ohos::Result<()> {
    let directory = PathBuf::from(directory);
    if !directory.is_absolute() || !directory.is_dir() {
        return Err(napi_ohos::Error::from_reason(
            "HarmonyOS resource directory is unavailable",
        ));
    }
    if let Some(existing) = RESOURCE_DIRECTORY.get() {
        if existing == &directory {
            return Ok(());
        }
        return Err(napi_ohos::Error::from_reason(
            "HarmonyOS resource directory cannot change during a process lifetime",
        ));
    }
    RESOURCE_DIRECTORY.set(directory).map_err(|_| {
        napi_ohos::Error::from_reason("HarmonyOS resource directory was already initialized")
    })
}

/// Set product storage before NativeAbility starts any Rust product workers.
/// This also rehomes the process: the system HOME points outside the sandbox.
#[napi_derive_ohos::napi]
pub fn configure_data_directory(directory: String) -> napi_ohos::Result<()> {
    let directory = PathBuf::from(directory);
    if !directory.is_absolute() || !directory.is_dir() {
        return Err(napi_ohos::Error::from_reason(
            "HarmonyOS data directory is unavailable",
        ));
    }
    static DATA_DIRECTORY: OnceLock<PathBuf> = OnceLock::new();
    if let Some(existing) = DATA_DIRECTORY.get() {
        return if existing == &directory {
            Ok(())
        } else {
            Err(napi_ohos::Error::from_reason(
                "HarmonyOS data directory cannot change during a process lifetime",
            ))
        };
    }
    DATA_DIRECTORY.set(directory.clone()).map_err(|_| {
        napi_ohos::Error::from_reason("HarmonyOS data directory was already initialized")
    })?;
    std::env::set_var("OPENBITFUN_USER_ROOT", directory.join("config"));
    // The system hands this process HOME=/storage/Users/currentUser, which is the
    // device user's directory: outside the sandbox, and not something the folder
    // picker can ever grant. Every `~/...` path therefore fails with EPERM - the
    // Skill watcher cannot start, and git, ssh and node find no configuration.
    // A home inside private storage is the only one that is actually readable.
    // Children inherit it, so the agent's shell sees the same home this does.
    let home = directory.join("home");
    std::fs::create_dir_all(&home).map_err(|error| {
        napi_ohos::Error::from_reason(format!(
            "HarmonyOS application home could not be created: {error}"
        ))
    })?;
    std::env::set_var("HOME", home);
    std::env::set_var("OPENBITFUN_HOME", directory);
    Ok(())
}

pub fn bundled_frontend_directory() -> Option<PathBuf> {
    let directory = RESOURCE_DIRECTORY.get()?.join("frontend/dist");
    directory.join("index.html").is_file().then_some(directory)
}

pub fn bundled_mobile_web_directory() -> Option<PathBuf> {
    let directory = RESOURCE_DIRECTORY.get()?.join("mobile-web/dist");
    (directory.join("index.html").is_file() && directory.join("assets").is_dir())
        .then_some(directory)
}

#[openharmony_ability_derive::ability(
    webview,
    protocol = "tauri,ipc,asset,isolation,openbitfun-ui"
)]
pub fn openharmony(app: openharmony_ability::OpenHarmonyApp) {
    // Never unwind across the platform callback boundary.
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        tauri::ohos::APP
            .lock()
            .expect("HarmonyOS application state lock poisoned")
            .replace(app);
        tauri::async_runtime::block_on(crate::run());
    }))
    .is_err()
    {
        eprintln!("OpenBitFun HarmonyOS startup panicked");
        std::process::abort();
    }
}

#[path = "ohos/window.rs"]
pub mod window;

#[cfg(debug_assertions)]
#[path = "ohos/terminal_diagnostics.rs"]
pub mod terminal_diagnostics;

#[path = "ohos/workspace_access.rs"]
pub mod workspace_access;

#[path = "ohos/workspace_grants.rs"]
pub mod workspace_grants;

#[path = "ohos/dialog.rs"]
pub mod dialog;

#[cfg(debug_assertions)]
#[path = "ohos/workspace_access_diagnostics.rs"]
pub mod workspace_access_diagnostics;

#[path = "ohos/opener.rs"]
pub mod opener;

#[path = "ohos/companion.rs"]
pub mod companion;
