//! System tray integration for BitFun Desktop.
//!
//! Creates a system tray icon with a context menu. On Windows and Linux the tray
//! icon is always visible while the process is running; on macOS the icon appears
//! in the macOS menu bar.
//!
//! Left-click  – toggles the main window (show / hide).
//! Right-click – opens a context menu with:
//!   • up to 5 recent sessions (sorted by last active time)
//!   • "Show BitFun"
//!   • "Quit BitFun"
//!
//! The context menu is rebuilt every time the user right-clicks so that recently
//! opened sessions are always up-to-date.

use std::path::PathBuf;
use std::sync::OnceLock;

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use bitfun_core::agentic::persistence::PersistenceManager;
use bitfun_core::infrastructure::PathManager;
use bitfun_core::service::config::app_language::get_app_language;
use bitfun_core::service::i18n::LocaleId;

use crate::api::app_state::AppState;

// ─── Event emitted to the webview when a tray session item is clicked ─────────

pub const TRAY_OPEN_SESSION_EVENT: &str = "tray://open-session";

// ─── Persistent tray icon reference (needed to update the menu) ───────────────

static TRAY_ICON: OnceLock<tauri::tray::TrayIcon> = OnceLock::new();

// ─── Tray menu i18n strings ───────────────────────────────────────────────────

struct TrayStrings {
    show_app: &'static str,
    quit_app: &'static str,
    no_recent_sessions: &'static str,
    recent_sessions_header: &'static str,
}

const STRINGS_ZH_CN: TrayStrings = TrayStrings {
    show_app: "显示 BitFun",
    quit_app: "退出 BitFun",
    no_recent_sessions: "暂无最近会话",
    recent_sessions_header: "最近会话",
};

const STRINGS_ZH_TW: TrayStrings = TrayStrings {
    show_app: "顯示 BitFun",
    quit_app: "退出 BitFun",
    no_recent_sessions: "暫無最近會話",
    recent_sessions_header: "最近會話",
};

const STRINGS_EN_US: TrayStrings = TrayStrings {
    show_app: "Show BitFun",
    quit_app: "Quit BitFun",
    no_recent_sessions: "No recent sessions",
    recent_sessions_header: "Recent Sessions",
};

fn tray_strings(locale: &LocaleId) -> &'static TrayStrings {
    match locale {
        LocaleId::ZhCN => &STRINGS_ZH_CN,
        LocaleId::ZhTW => &STRINGS_ZH_TW,
        LocaleId::EnUS => &STRINGS_EN_US,
    }
}

// ─── Session info collected from persisted storage ───────────────────────────

struct TraySessionItem {
    session_id: String,
    label: String,
    workspace_path: String,
}

// Build a short label for a session menu item.  Uses the session name if set,
// otherwise falls back to the session ID prefix.
fn session_label(session_name: &str, session_id: &str, workspace_name: &str) -> String {
    let name = if session_name.is_empty() {
        &session_id[..session_id.len().min(8)]
    } else {
        session_name
    };
    // Truncate long names to keep the menu readable.
    let truncated = if name.chars().count() > 40 {
        let mut s: String = name.chars().take(38).collect();
        s.push_str("…");
        s
    } else {
        name.to_string()
    };
    format!("[{}] {}", workspace_name, truncated)
}

// Collect up to `limit` sessions sorted by last_active_at across all recent
// workspaces.  Returns an empty list on any error rather than propagating.
async fn collect_recent_sessions(app: &AppHandle, limit: usize) -> Vec<TraySessionItem> {
    let app_state = match app.try_state::<AppState>() {
        Some(s) => s,
        None => return Vec::new(),
    };
    let path_manager = match app.try_state::<std::sync::Arc<PathManager>>() {
        Some(p) => p,
        None => return Vec::new(),
    };

    let recent_workspaces = app_state.workspace_service.get_recent_workspaces().await;

    // Gather (last_active_at, TraySessionItem) tuples across all workspaces.
    let mut all: Vec<(u64, TraySessionItem)> = Vec::new();

    for workspace in &recent_workspaces {
        // Skip remote workspaces – their session data lives on the remote host.
        let root_path_str = workspace.root_path.to_string_lossy();
        if root_path_str.starts_with("ssh://") || root_path_str.contains('@') {
            continue;
        }

        let manager = match PersistenceManager::new(path_manager.inner().clone()) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let sessions = match manager.list_session_metadata(&workspace.root_path).await {
            Ok(s) => s,
            Err(_) => continue,
        };

        let workspace_name = if workspace.name.is_empty() {
            workspace
                .root_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| workspace.id.clone())
        } else {
            workspace.name.clone()
        };

        for session in sessions {
            // Skip hidden / sub-agent sessions.
            use bitfun_core::agentic::core::session::SessionKind;
            if session.session_kind != SessionKind::Standard {
                continue;
            }
            let label = session_label(&session.session_name, &session.session_id, &workspace_name);
            all.push((
                session.last_active_at,
                TraySessionItem {
                    session_id: session.session_id,
                    label,
                    workspace_path: workspace.root_path.to_string_lossy().to_string(),
                },
            ));
        }
    }

    // Sort by most recent first.
    all.sort_by(|a, b| b.0.cmp(&a.0));
    all.into_iter().take(limit).map(|(_, item)| item).collect()
}

// Rebuild the tray context menu with fresh session data and the current locale.
// Also callable from outside the module (e.g. after a language change).
pub async fn rebuild_tray_menu_public(app: &AppHandle) {
    rebuild_tray_menu(app).await;
}

async fn rebuild_tray_menu(app: &AppHandle) {
    let sessions = collect_recent_sessions(app, 5).await;
    let locale = get_app_language().await;
    let s = tray_strings(&locale);

    let tray = match TRAY_ICON.get() {
        Some(t) => t,
        None => return,
    };

    let mut builder = MenuBuilder::new(app);

    // ── Recent sessions header ────────────────────────────────────────────────
    if !sessions.is_empty() {
        let header = match MenuItemBuilder::with_id("_header", s.recent_sessions_header)
            .enabled(false)
            .build(app)
        {
            Ok(i) => i,
            Err(_) => return,
        };
        builder = builder.item(&header).separator();
    }

    // ── Session items ─────────────────────────────────────────────────────────
    if sessions.is_empty() {
        let no_sessions = match MenuItemBuilder::with_id("no_sessions", s.no_recent_sessions)
            .enabled(false)
            .build(app)
        {
            Ok(i) => i,
            Err(_) => return,
        };
        builder = builder.item(&no_sessions);
    } else {
        for item in &sessions {
            let id = format!("session:{}:{}", item.session_id, item.workspace_path);
            let menu_item = match MenuItemBuilder::with_id(&id, &item.label).build(app) {
                Ok(i) => i,
                Err(_) => continue,
            };
            builder = builder.item(&menu_item);
        }
    }

    // ── Fixed actions ─────────────────────────────────────────────────────────
    let show_item = match MenuItemBuilder::with_id("show_window", s.show_app).build(app) {
        Ok(i) => i,
        Err(_) => return,
    };
    let quit_item = match MenuItemBuilder::with_id("quit", s.quit_app).build(app) {
        Ok(i) => i,
        Err(_) => return,
    };

    let menu = match builder
        .separator()
        .item(&show_item)
        .separator()
        .item(&quit_item)
        .build()
    {
        Ok(m) => m,
        Err(e) => {
            log::warn!("Failed to build tray menu: {}", e);
            return;
        }
    };

    if let Err(e) = tray.set_menu(Some(menu)) {
        log::warn!("Failed to update tray menu: {}", e);
    }
}

// ─── Public entry point ───────────────────────────────────────────────────────

/// Build and attach the system tray icon to the Tauri application.
pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // Build the initial (placeholder) menu; it will be replaced by rebuild_tray_menu
    // shortly after startup once the locale and sessions are known.
    let no_sessions_item =
        MenuItemBuilder::with_id("no_sessions", STRINGS_EN_US.no_recent_sessions)
            .enabled(false)
            .build(app)?;
    let show_item = MenuItemBuilder::with_id("show_window", STRINGS_EN_US.show_app).build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", STRINGS_EN_US.quit_app).build(app)?;

    let initial_menu = MenuBuilder::new(app)
        .item(&no_sessions_item)
        .separator()
        .item(&show_item)
        .separator()
        .item(&quit_item)
        .build()?;

    let icon = app
        .default_window_icon()
        .ok_or("No default window icon")?
        .clone();

    let tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&initial_menu)
        .tooltip("BitFun")
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            if id == "show_window" {
                show_main_window(app);
            } else if id == "quit" {
                log::info!("Quit requested from tray menu");
                crate::perform_process_exit_cleanup();
                app.exit(0);
            } else if let Some(rest) = id.strip_prefix("session:") {
                // Format: "session:{session_id}:{workspace_path}"
                if let Some(colon_pos) = rest.find(':') {
                    let session_id = &rest[..colon_pos];
                    let workspace_path = &rest[colon_pos + 1..];
                    log::info!(
                        "Tray session selected: session_id={}, workspace={}",
                        session_id,
                        workspace_path
                    );
                    show_main_window(app);
                    if let Err(e) = app.emit(
                        TRAY_OPEN_SESSION_EVENT,
                        serde_json::json!({
                            "sessionId": session_id,
                            "workspacePath": workspace_path,
                        }),
                    ) {
                        log::warn!("Failed to emit tray open-session event: {}", e);
                    }
                }
            }
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => {
                let app = tray.app_handle().clone();
                toggle_main_window(&app);
                // Refresh the menu in the background so it's ready for the next
                // right-click. We do it here (after a left-click) rather than on
                // right-click to avoid racing with the OS menu display.
                tauri::async_runtime::spawn(async move {
                    rebuild_tray_menu(&app).await;
                });
            }
            _ => {}
        })
        .build(app)?;

    // Store the handle so rebuild_tray_menu can update it later.
    let _ = TRAY_ICON.set(tray);

    // Eagerly populate the menu and then keep it fresh every 60 seconds.
    let app_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        // Short delay to let the workspace service finish initialising.
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        rebuild_tray_menu(&app_handle).await;

        // Periodic refresh so the menu stays current without any user interaction.
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            interval.tick().await;
            rebuild_tray_menu(&app_handle).await;
        }
    });

    Ok(())
}

// ─── Window helpers ───────────────────────────────────────────────────────────

/// Show the main window and bring it to focus.
pub fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        log::info!("Main window shown via tray");
    } else {
        log::warn!("Tray: show_main_window called but main window not found");
    }
}

/// Toggle the main window visibility.
fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        if visible {
            let _ = window.hide();
            log::info!("Main window hidden via tray toggle");
        } else {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
            log::info!("Main window shown via tray toggle");
        }
    }
}
