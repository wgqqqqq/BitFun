//! Same-bundle HarmonyOS windows share this host's instance/permission authority.
//! Only trusted shell WebViews receive a native connection; content stays opaque.
use super::*;
use napi_ohos::{bindgen_prelude::Promise, threadsafe_function::ThreadsafeFunction};
use std::sync::{OnceLock, RwLock};

type Callback = ThreadsafeFunction<String, Promise<String>>;
static CALLBACK: OnceLock<RwLock<Option<Arc<Callback>>>> = OnceLock::new();
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static WINDOWS: OnceLock<Mutex<HashMap<String, Connection>>> = OnceLock::new();

#[derive(Clone)]
struct Connection {
    launch_id: String,
    nonce: String,
    instance_id: String,
    view_id: String,
}
fn windows() -> &'static Mutex<HashMap<String, Connection>> {
    WINDOWS.get_or_init(Default::default)
}

#[napi_derive_ohos::napi]
pub fn register_miniapp_operation(callback: Callback) -> napi_ohos::Result<()> {
    *CALLBACK
        .get_or_init(Default::default)
        .write()
        .map_err(|_| napi_ohos::Error::from_reason("MiniApp bridge lock poisoned"))? =
        Some(Arc::new(callback));
    Ok(())
}

async fn perform(request: Value) -> Result<Value, String> {
    let callback = CALLBACK
        .get_or_init(Default::default)
        .read()
        .map_err(|_| "MiniApp bridge lock poisoned")?
        .clone()
        .ok_or("HarmonyOS MiniApp host is unavailable")?;
    // OS confirmation can remain open while the user reads it. Do not time out
    // a mutation and subsequently report failure while the OS completes it.
    let result = callback
        .call_async(Ok(request.to_string()))
        .await
        .map_err(|e| e.to_string())?
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&result).map_err(|e| e.to_string())
}

pub(super) fn ready(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());
}

#[napi_derive_ohos::napi]
pub fn launch_mini_app(launch_id: String, complete: ThreadsafeFunction<(), ()>) {
    tauri::async_runtime::spawn(async move {
        let result = launch(launch_id).await;
        let _ = complete.call(
            result,
            napi_ohos::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
        );
    });
}

async fn launch(launch_id: String) -> napi_ohos::Result<()> {
    uuid::Uuid::parse_str(&launch_id)
        .map_err(|_| napi_ohos::Error::from_reason("Invalid MiniApp launch identity"))?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(70);
    let app = loop {
        if let Some(app) = APP.get() {
            break app;
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(napi_ohos::Error::from_reason(
                "OpenBitFun did not become ready",
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    };
    let result = async {
        let data = app
            .state::<AppState>()
            .miniapp_manager
            .path_manager()
            .user_data_dir();
        let record = launcher::read_record(
            &data
                .join("miniapp-desktop/launchers")
                .join(&launch_id)
                .join("launch.json"),
        )?;
        if record.launch_id != launch_id || record.data_dir != data {
            return Err("MiniApp launch identity mismatch".into());
        }
        local_workspace(app, record.workspace_path.clone()).await?;
        let host = app.state::<DesktopMiniApps>();
        let _guard = host.launches.lock().await;
        open_window(app, record, None).await.map(|_| ())
    }
    .await;
    result.map_err(napi_ohos::Error::from_reason)
}

pub(super) async fn open(
    app: &tauri::AppHandle,
    record: &launcher::LaunchRecord,
    instance: &MiniAppInstance,
    view: &MiniAppView,
) -> Result<(), String> {
    let label = format!("miniapp-shell-{}", record.launch_id);
    if app.get_webview(&label).is_some() {
        perform(json!({"action":"focus","label":label})).await?;
        return Ok(());
    }
    let connection = Connection {
        launch_id: record.launch_id.clone(),
        nonce: uuid::Uuid::new_v4().to_string(),
        instance_id: instance.instance_id.clone(),
        view_id: view.view_id.clone(),
    };
    windows()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(label.clone(), connection);
    let result = async {
        perform(json!({"action":"prepare","label":label,"launchId":record.launch_id,"title":record.name,"icon":icon_path(record)?})).await?;
        let main = app.get_window("main").ok_or("Main native host is unavailable")?;
        main.add_child(
            tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::External("openbitfun-miniapp://localhost/".parse().unwrap()))
                .initialization_script("Object.defineProperty(window, '__MINIAPP_PLATFORM__', {value:'ohos'});"),
            tauri::LogicalPosition::new(0.0,0.0), tauri::LogicalSize::new(1050.0,760.0)
        ).map_err(|e| e.to_string())?;
        Ok(())
    }.await;
    if result.is_err() {
        windows()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&label);
        let _ = perform(json!({"action":"destroy","label":label})).await;
    }
    result
}

fn icon_path(record: &launcher::LaunchRecord) -> Result<String, String> {
    let directory = openbitfun_miniapp_ipc::launcher::launch_path(record)
        .parent()
        .ok_or("Missing launch directory")?
        .to_path_buf();
    for size in [256, 128, 64] {
        let path = directory.join(format!("icon-{size}.png"));
        if std::fs::metadata(&path).is_ok_and(|meta| meta.len() <= 100 * 1024) {
            return Ok(path.to_string_lossy().into_owned());
        }
    }
    Err("MiniApp shortcut icon exceeds the HarmonyOS limit".into())
}

pub(super) async fn install_shortcut(
    record: &launcher::LaunchRecord,
    svg: Option<String>,
) -> Result<String, String> {
    let icon_record = record.clone();
    tokio::task::spawn_blocking(move || launcher::prepare_icons(&icon_record, svg.as_deref()))
        .await
        .map_err(|e| e.to_string())??;
    let result = perform(json!({"action":"pin","launchId":record.launch_id,"title":record.name,"icon":icon_path(record)?})).await?;
    string(&result, "path")
}

pub(super) async fn shortcuts(
    data: &std::path::Path,
    app_id: &str,
    remove: bool,
) -> Result<Vec<String>, String> {
    let records = system_install::records(data, app_id)?;
    let ids: Vec<_> = records.iter().map(|r| r.launch_id.clone()).collect();
    let result =
        perform(json!({"action":if remove {"unpin"} else {"shortcuts"},"launchIds":ids})).await?;
    serde_json::from_value(result["paths"].clone()).map_err(|e| e.to_string())
}

fn connection(label: &str) -> Result<Connection, String> {
    windows()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(label)
        .cloned()
        .ok_or("MiniApp Shell command is unavailable on this surface".into())
}

async fn host_call(
    app: &tauri::AppHandle,
    connection: &Connection,
    method: &str,
    mut params: Value,
) -> Result<Value, String> {
    if !params.is_object() {
        params = json!({});
    }
    params["instanceId"] = json!(connection.instance_id);
    params["viewId"] = json!(connection.view_id);
    params["nonce"] = json!(connection.nonce);
    dispatch(app, method, params).await
}

async fn close(app: &tauri::AppHandle, label: &str, destroy: bool) -> Result<(), String> {
    let existing = windows()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(label);
    if let Some(connection) = existing {
        // Closing before bootstrap must release a prepared target too.
        if host_call(app, &connection, "close", json!({}))
            .await
            .is_err()
        {
            close_view(app, &connection.instance_id, &connection.view_id).await?;
        }
        if let Some(view) = app.get_webview(label) {
            let _ = view.close();
        }
        if destroy {
            perform(json!({"action":"destroy","label":label})).await?;
        }
    }
    Ok(())
}

#[napi_derive_ohos::napi]
pub fn mini_app_window_closed(label: String) {
    if let Some(app) = APP.get() {
        tauri::async_runtime::spawn(async move {
            if let Err(error) = close(app, &label, false).await {
                log::warn!("MiniApp detach failed: {error}");
            }
        });
    }
}

pub(super) fn renew(app: &tauri::AppHandle) {
    // The Ability owns destruction; native leases survive ArkWeb timer suspension.
    app.state::<DesktopMiniApps>()
        .instances
        .renew_committed_views(MiniAppViewKind::Window);
}

pub(crate) async fn shell_call(
    app: &tauri::AppHandle,
    label: &str,
    request: Value,
) -> Result<Value, String> {
    let conn = connection(label)?;
    let operation = string(&request, "operation")?;
    let params = request.get("params").cloned().unwrap_or(json!({}));
    match operation.as_str() {
        "bootstrap" => {
            let result = dispatch(
                app,
                "open",
                json!({"launchId":conn.launch_id,"nonce":conn.nonce}),
            )
            .await?;
            if result["reused"] == true {
                return Err("MiniApp window is already open".into());
            }
            perform(json!({"action":"show","label":label,"title":result["app"]["name"]})).await?;
            Ok(result)
        }
        "ready" | "tab" | "poll" | "permissions" | "chatSnapshot" => {
            host_call(app, &conn, &operation, params).await
        }
        "close" => {
            close(app, label, true).await?;
            Ok(Value::Null)
        }
        "windowState" | "focus" | "minimize" | "maximize" | "fullscreen" | "drag" => {
            perform(json!({"action":operation,"label":label})).await
        }
        "rpc" => {
            let method = string(&params, "method")?;
            if matches!(method.as_str(), "authorizeLocal" | "grantSelectedPath") {
                return Err("Private MiniApp host operation".into());
            }
            host_call(app, &conn, "rpc", params).await
        }
        "local" => {
            let method = string(&params, "method")?;
            let args = params.get("params").cloned().unwrap_or(json!({}));
            host_call(app, &conn, "rpc", json!({"method":"authorizeLocal","params":{"action":method,"sessionId":args.get("sessionId")}})).await?;
            match method.as_str() {
                "clipboard.readText"
                | "clipboard.writeText"
                | "chat.claimComposer"
                | "chat.focusSession" => Ok(Value::Null),
                "system.openExternal" => {
                    crate::ohos::opener::open_url(string(&args, "url")?, None).await?;
                    Ok(Value::Null)
                }
                _ => Err(format!(
                    "MiniApp local operation {method} is not supported on HarmonyOS PC"
                )),
            }
        }
        _ => Err("Unsupported MiniApp Shell operation".into()),
    }
}

pub(crate) fn asset(path: &str) -> tauri::http::Response<Vec<u8>> {
    let (mime, body): (&str, &[u8]) = match path {
        "/" => (
            "text/html; charset=utf-8",
            include_bytes!("../../../miniapp-shell/src/shell.html"),
        ),
        "/titlebar.js" => (
            "text/javascript",
            include_bytes!("../../../../shared/miniapp-chrome/titlebar.js"),
        ),
        "/miniapp-chat.js" => (
            "text/javascript",
            include_bytes!("../../../miniapp-shell/src/miniapp-chat.js"),
        ),
        "/generated/chat-style-classes.js" => (
            "text/javascript",
            include_bytes!("../../../miniapp-shell/src/generated/chat-style-classes.js"),
        ),
        "/chat-styles.css" => (
            "text/css",
            include_bytes!("../../../miniapp-shell/src/generated/chat-styles.css"),
        ),
        "/chat-labels.json" => (
            "application/json",
            include_bytes!("../../../miniapp-shell/src/chat-labels.json"),
        ),
        "/titlebar.css" => (
            "text/css",
            include_bytes!("../../../../shared/miniapp-chrome/titlebar.css"),
        ),
        "/window-controls.css" => (
            "text/css",
            include_bytes!("../../../../shared/miniapp-chrome/window-controls.css"),
        ),
        "/labels.json" => (
            "application/json",
            include_bytes!("../../../../shared/miniapp-chrome/labels.generated.json"),
        ),
        "/icons.json" => (
            "application/json",
            include_bytes!("../../../../shared/miniapp-chrome/icons.generated.json"),
        ),
        "/appearance.css" => (
            "text/css",
            include_bytes!("../../../../shared/miniapp-chrome/generated/theme.css"),
        ),
        _ => {
            return tauri::http::Response::builder()
                .status(404)
                .body(Vec::new())
                .unwrap()
        }
    };
    tauri::http::Response::builder()
        .header("Content-Type", mime)
        .body(body.to_vec())
        .unwrap()
}
