//! One independent self-hosted desktop connection per application. Account
//! login, chat routing and Peer workspaces never own or retire this connection.
use super::RemoteDesktopState;
use openbitfun_services_integrations::{
    remote_connect::{
        account::{AccountClient, AccountSession},
        relay_client::{RelayClient, RelayEvent},
        remote_desktop_device::{self, RemoteDesktopReply},
        remote_desktop_service,
    },
    remote_persistence::AccountSessionRecord,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use tauri::{AppHandle, Emitter, Manager};

static GENERATION: AtomicU64 = AtomicU64::new(1);
static OPERATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static OWNER: OnceLock<Mutex<Option<Arc<Connection>>>> = OnceLock::new();
fn owner() -> &'static Mutex<Option<Arc<Connection>>> {
    OWNER.get_or_init(|| Mutex::new(None))
}

pub(crate) struct Connection {
    pub generation: u64,
    pub session: AccountSession,
    pub relay: String,
    pub device_id: String,
    pub client: Arc<RelayClient>,
    pub capabilities: Vec<String>,
}

#[derive(Clone, Serialize)]
pub struct ServiceStatus {
    pub generation: String,
    pub connected: bool,
    pub service_url: Option<String>,
    pub device_id: Option<String>,
    pub service_id: Option<String>,
}

pub(crate) fn generation() -> u64 {
    GENERATION.load(Ordering::Acquire)
}
pub(crate) fn is_current(value: u64) -> bool {
    generation() == value
}
pub(crate) fn service_id(url: &str) -> String {
    format!("{:x}", Sha256::digest(url.as_bytes()))
}
pub(crate) fn snapshot() -> Result<Arc<Connection>, String> {
    owner()
        .lock()
        .map_err(|_| "remote_desktop_connection_unavailable")?
        .clone()
        .filter(|c| is_current(c.generation))
        .ok_or_else(|| "remote_desktop_service_not_connected".into())
}
pub(crate) fn status() -> ServiceStatus {
    let current = snapshot().ok();
    ServiceStatus {
        generation: generation().to_string(),
        connected: current.is_some(),
        service_url: current.as_ref().map(|c| c.relay.clone()),
        device_id: current.as_ref().map(|c| c.device_id.clone()),
        service_id: current.as_ref().map(|c| service_id(&c.relay)),
    }
}
pub(crate) fn status_for_app(app: &AppHandle) -> Result<ServiceStatus, String> {
    let mut current = status();
    if current.service_url.is_none() {
        if let Some((url, _)) = read_active_service(&root(app))? {
            current.service_id = Some(service_id(&url));
            current.service_url = Some(url);
        }
    }
    Ok(current)
}
pub(crate) async fn lock_operation(
    expected: u64,
) -> Result<tokio::sync::MutexGuard<'static, ()>, String> {
    let guard = OPERATION.lock().await;
    if !is_current(expected) {
        return Err("remote_desktop_connection_changed".into());
    }
    Ok(guard)
}
pub(crate) async fn read_context_for_generation(
    expected: u64,
) -> Result<(AccountSession, String), String> {
    let current = snapshot()?;
    if current.generation != expected {
        return Err("remote_desktop_connection_changed".into());
    }
    Ok((current.session.clone(), current.relay.clone()))
}

fn root(app: &AppHandle) -> PathBuf {
    app.state::<Arc<openbitfun_core::infrastructure::app_paths::PathManager>>()
        .user_data_dir()
        .join("remote-desktop")
        .join("services")
}

async fn retire(app: &AppHandle) {
    GENERATION.fetch_add(1, Ordering::AcqRel);
    let previous = owner().lock().unwrap().take();
    app.state::<RemoteDesktopState>().retire();
    let _ = app.emit("remote-desktop-service-changed", status());
    #[cfg(all(target_os = "linux", feature = "remote-desktop-media"))]
    if super::linux::revoke().await.is_err() {
        // Native authority is already retired. Retain a failed portal close in
        // its owner; a replacement service cannot reuse that permission.
        log::warn!("Remote desktop portal cleanup remains pending");
    }
    if let Some(previous) = previous {
        previous.client.disconnect().await;
    }
}

pub(crate) async fn disconnect(app: &AppHandle) -> Result<(), String> {
    let _operation = OPERATION.lock().await;
    let endpoint = status_for_app(app)?.service_url;
    retire(app).await;
    if let Some(endpoint) = endpoint {
        write_active_service(&root(app), &endpoint, false)
            .map_err(|_| "remote_desktop_profile_save_failed")?;
    }
    Ok(())
}

pub(crate) async fn connect(
    app: &AppHandle,
    endpoint: &str,
    pairing_key: Option<&str>,
    name: &str,
) -> Result<ServiceStatus, String> {
    let endpoint = remote_desktop_service::service_url(endpoint).map_err(|e| e.to_string())?;
    let _operation = OPERATION.lock().await;
    retire(app).await;
    let directory = root(app).join(service_id(&endpoint));
    let record = match pairing_key.filter(|key| !key.is_empty()) {
        Some(key) => remote_desktop_service::pair(&directory, &endpoint, key, name)
            .await
            .map_err(|e| e.to_string())?,
        None => remote_desktop_service::load(&directory)
            .map_err(|e| e.to_string())?
            .filter(remote_desktop_service::enrolled)
            .ok_or("remote_desktop_pairing_required")?,
    };
    activate(app, &directory, record).await?;
    if write_active_service(&root(app), &endpoint, true).is_err() {
        retire(app).await;
        return Err("remote_desktop_profile_save_failed".into());
    }
    let _ = app.emit("remote-desktop-service-changed", status());
    Ok(status())
}

fn write_active_service(
    root: &Path,
    endpoint: &str,
    connect_on_startup: bool,
) -> std::io::Result<()> {
    std::fs::create_dir_all(root)?;
    let path = root.join("active-service.json");
    let mut document = match std::fs::read(&path) {
        Ok(bytes) => {
            serde_json::from_slice::<serde_json::Value>(&bytes).map_err(std::io::Error::other)?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            serde_json::json!({"version":1})
        }
        Err(error) => return Err(error),
    };
    if !document.is_object() || document["version"] != 1 {
        return Err(std::io::Error::other(
            "Remote desktop profile is unsupported; existing data was retained",
        ));
    }
    document["service_url"] = endpoint.into();
    document["connect_on_startup"] = connect_on_startup.into();
    let mut temporary = tempfile::NamedTempFile::new_in(root)?;
    use std::io::Write;
    temporary.write_all(serde_json::to_string(&document)?.as_bytes())?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|e| e.error)?;
    Ok(())
}

fn read_active_service(root: &Path) -> Result<Option<(String, bool)>, String> {
    let path = root.join("active-service.json");
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("remote_desktop_profile_unreadable".into()),
    };
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "remote_desktop_profile_unreadable")?;
    if value["version"] != 1 {
        return Err("remote_desktop_profile_unsupported".into());
    }
    let endpoint = value["service_url"]
        .as_str()
        .ok_or("remote_desktop_profile_unreadable")?;
    let endpoint = remote_desktop_service::service_url(endpoint)
        .map_err(|_| "remote_desktop_profile_unreadable")?;
    let enabled = match value.get("connect_on_startup") {
        None => true,
        Some(serde_json::Value::Bool(value)) => *value,
        _ => return Err("remote_desktop_profile_unreadable".into()),
    };
    Ok(Some((endpoint, enabled)))
}

pub(crate) async fn restore(app: &AppHandle) -> Result<(), String> {
    let Some((endpoint, true)) = read_active_service(&root(app))? else {
        return Ok(());
    };
    connect(app, &endpoint, None, "OpenBitFun Desktop")
        .await
        .map(|_| ())
}

async fn activate(
    app: &AppHandle,
    directory: &Path,
    record: AccountSessionRecord,
) -> Result<(), String> {
    #[cfg(all(target_os = "linux", feature = "remote-desktop-media"))]
    super::linux::initialize().await;
    let device_id = record
        .device_id
        .clone()
        .ok_or("remote_desktop_device_identity_missing")?;
    let api = AccountClient::new();
    let capabilities = api
        .remote_desktop_capabilities(&record.relay_url)
        .await
        .map_err(|_| "remote_desktop_service_unavailable")?;
    if !capabilities
        .iter()
        .any(|v| v == "remote_desktop_pairing_v1")
    {
        return Err("remote_desktop_service_required".into());
    }
    let (client, mut events) = RelayClient::new_remote_desktop();
    let client = Arc::new(client);
    client
        .connect(&record.relay_url)
        .await
        .map_err(|_| "remote_desktop_service_unavailable")?;
    if client
        .connect_authenticated(&record.token, "OpenBitFun Desktop")
        .await
        .is_err()
    {
        client.disconnect().await;
        return Err("remote_desktop_pairing_expired".into());
    }
    let connection = Arc::new(Connection {
        generation: generation(),
        session: AccountSession::new(record.token, record.user_id, record.master_key),
        relay: record.relay_url,
        device_id,
        client: client.clone(),
        capabilities,
    });
    if let Err(error) = app.state::<RemoteDesktopState>().connect(
        connection.generation,
        &connection.session.user_id,
        directory.join("view-grants.json"),
    ) {
        client.disconnect().await;
        return Err(error);
    }
    #[cfg(feature = "remote-desktop-media")]
    app.state::<RemoteDesktopState>().configure_relay(
        connection.generation,
        super::RelayContext {
            relay_url: connection.relay.clone(),
            session: connection.session.clone(),
            host_device_id: connection.device_id.clone(),
            service_connection_id: connection.generation,
            capabilities: connection.capabilities.clone(),
        },
    );
    *owner().lock().unwrap() = Some(connection.clone());
    if client
        .register_remote_desktop(&connection.capabilities)
        .await
        .is_err()
    {
        retire(app).await;
        return Err("remote_desktop_registration_failed".into());
    }
    let app = app.clone();
    tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            if !is_current(connection.generation) {
                break;
            }
            match event {
                RelayEvent::RemoteDesktopMessageReceived {
                    socket_generation,
                    attach_id,
                    credential_binding,
                    source_device_id,
                    correlation_id,
                    encrypted_data,
                    nonce,
                } => {
                    let key = api
                        .device_public_key(
                            &connection.relay,
                            &connection.session,
                            &source_device_id,
                        )
                        .await;
                    let verified = key.as_ref().ok().and_then(|key| {
                        remote_desktop_device::decrypt_read_only_request(
                            &connection.session.master_key,
                            key,
                            &connection.session.user_id,
                            &source_device_id,
                            &remote_desktop_device::EncryptedSignal {
                                encrypted_data,
                                nonce,
                            },
                        )
                        .ok()
                    });
                    if !is_current(connection.generation)
                        || !client.remote_desktop_socket_is_current(socket_generation)
                    {
                        continue;
                    }
                    let (Ok(key), Some(verified)) = (key, verified) else {
                        let _ = client
                            .reject_remote_desktop(&source_device_id, &correlation_id)
                            .await;
                        continue;
                    };
                    let reply = app
                        .state::<RemoteDesktopState>()
                        .handle(
                            connection.generation,
                            socket_generation,
                            &verified.source,
                            verified.request,
                            attach_id.as_deref(),
                            credential_binding.as_deref(),
                        )
                        .await;
                    if !is_current(connection.generation) {
                        continue;
                    }
                    if let Ok(body) = serde_json::to_string(&reply.body) {
                        if let Ok(encrypted) = remote_desktop_device::encrypt_signal(
                            &connection.session.master_key,
                            &key,
                            &body,
                        ) {
                            let _ = client
                                .reply_remote_desktop(
                                    socket_generation,
                                    &source_device_id,
                                    &correlation_id,
                                    &RemoteDesktopReply {
                                        encrypted,
                                        attachment: reply.attachment,
                                    },
                                )
                                .await;
                        }
                    }
                }
                RelayEvent::RemoteDesktopNoticeReceived {
                    socket_generation,
                    correlation_id,
                    notice,
                } => {
                    if client.remote_desktop_notice_socket_is_current(socket_generation) {
                        let handled = app.state::<RemoteDesktopState>().relay_notice(
                            connection.generation,
                            socket_generation,
                            &notice,
                        );
                        let _ = client
                            .acknowledge_remote_desktop_notice(
                                socket_generation,
                                &correlation_id,
                                &notice.attach_id,
                                handled,
                            )
                            .await;
                    }
                }
                RelayEvent::RemoteDesktopRouteReady {
                    registered: false, ..
                }
                | RelayEvent::Disconnected => {
                    app.state::<RemoteDesktopState>()
                        .relay_lost(connection.generation);
                }
                RelayEvent::AuthError { .. } => {
                    let _operation = OPERATION.lock().await;
                    // Recheck after the await: an old socket must not retire a
                    // replacement service or its media owner.
                    if is_current(connection.generation) {
                        retire(&app).await;
                    }
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

#[cfg(feature = "remote-desktop-media")]
pub(crate) async fn end_media(expected: u64, connection_id: u64, socket: u64, attachment: &str) {
    if let Ok(current) = snapshot() {
        if current.generation == expected && current.generation == connection_id {
            let _ = current.client.end_remote_desktop(socket, attachment).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn independent_desktop_profile_keeps_legacy_defaults_and_explicit_disconnect() {
        let root = tempfile::tempdir().unwrap();
        assert!(read_active_service(root.path()).unwrap().is_none());
        std::fs::write(
            root.path().join("active-service.json"),
            r#"{"version":1,"service_url":"https://desktop.example","future_field":true}"#,
        )
        .unwrap();
        assert_eq!(
            read_active_service(root.path()).unwrap(),
            Some(("https://desktop.example".into(), true))
        );
        write_active_service(root.path(), "https://desktop.example", false).unwrap();
        assert_eq!(
            read_active_service(root.path()).unwrap(),
            Some(("https://desktop.example".into(), false))
        );
        let value: serde_json::Value = serde_json::from_slice(
            &std::fs::read(root.path().join("active-service.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(value["future_field"], true);
    }
    #[test]
    fn independent_desktop_profile_preserves_unreadable_and_future_records() {
        let root = tempfile::tempdir().unwrap();
        for data in [
            "unreadable",
            r#"{"version":2,"service_url":"https://desktop.example"}"#,
            r#"{"version":1,"service_url":"http://public.example"}"#,
        ] {
            let path = root.path().join("active-service.json");
            std::fs::write(&path, data).unwrap();
            assert!(read_active_service(root.path()).is_err());
            if data != r#"{"version":1,"service_url":"http://public.example"}"# {
                assert!(write_active_service(root.path(), "https://new.example", false).is_err());
            }
            assert_eq!(std::fs::read_to_string(path).unwrap(), data);
        }
    }
}
