//! Explicit local Portal consent. Only MONITOR sources are requested; no
//! window/root/default-PipeWire fallback and no shared Computer Use ownership.
use atspi::zbus::{
    self,
    zvariant::{OwnedFd, OwnedObjectPath, OwnedValue, Value},
};
use futures::StreamExt;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
type Options<'a> = HashMap<&'a str, Value<'a>>;
type Results = HashMap<String, OwnedValue>;
const DEST: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
const REMOTE: &str = "org.freedesktop.portal.RemoteDesktop";
const SCREEN: &str = "org.freedesktop.portal.ScreenCast";
static OWNER: OnceLock<Mutex<Option<Arc<Session>>>> = OnceLock::new();
static CANCELLATIONS: OnceLock<tokio::sync::watch::Sender<u64>> = OnceLock::new();
fn cancellations() -> &'static tokio::sync::watch::Sender<u64> {
    CANCELLATIONS.get_or_init(|| tokio::sync::watch::channel(0).0)
}
static OPERATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
fn owner() -> &'static Mutex<Option<Arc<Session>>> {
    OWNER.get_or_init(|| Mutex::new(None))
}
pub(super) struct Session {
    pub id: String,
    pub size: (i32, i32),
    pub stream: u32,
    pub serial: Option<u64>,
    pub fd: OwnedFd,
    pub active: AtomicBool,
    pub connection: zbus::Connection,
    pub path: OwnedObjectPath,
    pub runtime: tokio::runtime::Handle,
    pub devices: u32,
    pub closed: AtomicBool,
}
pub(super) fn current() -> Option<Arc<Session>> {
    owner()
        .lock()
        .unwrap()
        .clone()
        .filter(|s| s.active.load(Ordering::Acquire))
}
fn token() -> String {
    format!("openbitfun_rd_{}", uuid::Uuid::new_v4().simple())
}
async fn proxy<'a>(
    connection: &'a zbus::Connection,
    interface: &str,
) -> Result<zbus::Proxy<'a>, String> {
    zbus::Proxy::new(connection, DEST, PATH, interface.to_owned())
        .await
        .map_err(|_| "portal_unavailable".into())
}
async fn request<B: serde::Serialize + zbus::zvariant::DynamicType>(
    connection: &zbus::Connection,
    interface: &str,
    method: &str,
    handle: &str,
    body: &B,
    epoch: u64,
) -> Result<Results, String> {
    let mut canceled = cancellations().subscribe();
    if *canceled.borrow() != epoch {
        return Err("permission_required".into());
    }
    let sender = connection
        .unique_name()
        .ok_or("portal_unavailable")?
        .as_str()
        .trim_start_matches(':')
        .replace('.', "_");
    let expected = format!("{PATH}/request/{sender}/{handle}");
    let request = zbus::Proxy::new(
        connection,
        DEST,
        expected.as_str(),
        "org.freedesktop.portal.Request",
    )
    .await
    .map_err(|_| "portal_unavailable")?;
    let mut replies = request
        .receive_signal("Response")
        .await
        .map_err(|_| "portal_unavailable")?;
    let path: OwnedObjectPath = proxy(connection, interface)
        .await?
        .call(method, body)
        .await
        .map_err(|_| "portal_unavailable")?;
    if path.as_str() != expected {
        return Err("portal_incompatible".into());
    }
    let response = if *canceled.borrow() != epoch {
        Err(())
    } else {
        tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(120), replies.next()) => result.map_err(|_|()),
            _ = canceled.changed() => Err(()),
        }
    };
    let signal = match response {
        Ok(Some(signal)) => signal,
        _ => {
            let _: Result<(), _> = request.call("Close", &()).await;
            return Err("permission_required".into());
        }
    };
    let (code, result): (u32, Results) = signal
        .body()
        .deserialize()
        .map_err(|_| "invalid_portal_response")?;
    if code != 0 {
        return Err("permission_required".into());
    }
    Ok(result)
}
pub(super) async fn authorize() -> Result<(), String> {
    let epoch = *cancellations().borrow();
    let _operation = OPERATION.lock().await;
    if *cancellations().borrow() != epoch {
        return Err("permission_required".into());
    }
    if current().is_some() {
        return Ok(());
    }
    let previous = owner().lock().unwrap().clone();
    if let Some(previous) = previous {
        close(&previous.connection, &previous.path).await?;
        previous.closed.store(true, Ordering::Release);
        owner().lock().unwrap().take();
    }
    let connection = zbus::Connection::session()
        .await
        .map_err(|_| "portal_unavailable")?;
    let handle = token();
    let session_token = token();
    let mut result = request(
        &connection,
        REMOTE,
        "CreateSession",
        &handle,
        &(Options::from([
            ("handle_token", Value::from(handle.as_str())),
            ("session_handle_token", Value::from(session_token.as_str())),
        ]),),
        epoch,
    )
    .await?;
    let path: OwnedObjectPath = result
        .remove("session_handle")
        .ok_or("invalid_portal_response")?
        .try_into()
        .map_err(|_| "invalid_portal_response")?;
    let subscription = zbus::Proxy::new_owned(
        connection.clone(),
        DEST,
        path.clone(),
        "org.freedesktop.portal.Session",
    )
    .await
    .map_err(|_| "portal_unavailable")?;
    let mut closed = subscription
        .receive_signal("Closed")
        .await
        .map_err(|_| "portal_unavailable")?;
    let result = create(&connection, &path, epoch).await;
    let (stream, size, serial, devices, fd) = match result {
        Ok(result) => result,
        Err(error) => {
            close(&connection, &path).await?;
            return Err(error);
        }
    };
    let session = Arc::new(Session {
        id: format!("portal:{}", uuid::Uuid::new_v4()),
        size,
        stream,
        serial,
        fd,
        active: AtomicBool::new(true),
        connection: connection.clone(),
        path: path.clone(),
        runtime: tokio::runtime::Handle::current(),
        devices,
        closed: AtomicBool::new(false),
    });
    // Subscribe before exposing authority, so a fast compositor revocation
    // cannot disappear between Start and watcher registration.
    let weak = Arc::downgrade(&session);
    tokio::spawn(async move {
        let confirmed = closed.next().await.is_some();
        if let Some(session) = weak.upgrade() {
            session.closed.store(confirmed, Ordering::Release);
            session.active.store(false, Ordering::Release);
        }
    });
    if *cancellations().borrow() != epoch {
        session.active.store(false, Ordering::Release);
        close(&session.connection, &session.path).await?;
        session.closed.store(true, Ordering::Release);
        return Err("permission_required".into());
    }
    *owner().lock().unwrap() = Some(session);
    Ok(())
}
async fn create(
    connection: &zbus::Connection,
    path: &OwnedObjectPath,
    epoch: u64,
) -> Result<(u32, (i32, i32), Option<u64>, u32, OwnedFd), String> {
    let handle = token();
    request(
        connection,
        REMOTE,
        "SelectDevices",
        &handle,
        &(
            path,
            Options::from([
                ("handle_token", Value::from(handle.as_str())),
                ("types", Value::from(3u32)),
            ]),
        ),
        epoch,
    )
    .await?;
    let screen = proxy(connection, SCREEN).await?;
    let types: u32 = screen
        .get_property("AvailableSourceTypes")
        .await
        .map_err(|_| "portal_unavailable")?;
    if types & 1 == 0 {
        return Err("monitor_capture_unsupported".into());
    }
    let modes: u32 = screen
        .get_property("AvailableCursorModes")
        .await
        .map_err(|_| "portal_unavailable")?;
    if modes & 2 == 0 {
        return Err("media_backend_unavailable".into());
    }
    let handle = token();
    request(
        connection,
        SCREEN,
        "SelectSources",
        &handle,
        &(
            path,
            Options::from([
                ("handle_token", Value::from(handle.as_str())),
                ("types", Value::from(1u32)),
                ("multiple", Value::from(false)),
                ("cursor_mode", Value::from(2u32)),
            ]),
        ),
        epoch,
    )
    .await?;
    let handle = token();
    let mut result = request(
        connection,
        REMOTE,
        "Start",
        &handle,
        &(
            path,
            "",
            Options::from([("handle_token", Value::from(handle.as_str()))]),
        ),
        epoch,
    )
    .await?;
    let devices = result
        .remove("devices")
        .and_then(|v| u32::try_from(v).ok())
        .unwrap_or(0);
    let streams: Vec<(u32, Results)> = result
        .remove("streams")
        .ok_or("invalid_portal_response")?
        .try_into()
        .map_err(|_| "invalid_portal_response")?;
    if streams.len() != 1 {
        return Err("invalid_portal_response".into());
    }
    let (stream, mut properties) = streams
        .into_iter()
        .next()
        .ok_or("invalid_portal_response")?;
    let source = properties
        .remove("source_type")
        .and_then(|v| u32::try_from(v).ok());
    if source != Some(1) {
        return Err("monitor_capture_unsupported".into());
    }
    let size = properties
        .remove("logical_size")
        .or_else(|| properties.remove("size"))
        .and_then(|v| <(i32, i32)>::try_from(v).ok())
        .filter(|s| s.0 >= 2 && s.1 >= 2 && s.0 <= 16384 && s.1 <= 16384)
        .ok_or("display_geometry_unavailable")?;
    let serial = properties
        .remove("pipewire-serial")
        .and_then(|v| u64::try_from(v).ok());
    let fd = screen
        .call("OpenPipeWireRemote", &(path, Options::new()))
        .await
        .map_err(|_| "portal_unavailable")?;
    Ok((stream, size, serial, devices, fd))
}
async fn close(connection: &zbus::Connection, path: &OwnedObjectPath) -> Result<(), String> {
    zbus::Proxy::new(connection, DEST, path, "org.freedesktop.portal.Session")
        .await
        .map_err(|_| "portal_unavailable")?
        .call::<_, _, ()>("Close", &())
        .await
        .map_err(|_| "portal_close_pending".into())
}
pub(super) async fn revoke() -> Result<(), String> {
    cancellations().send_modify(|epoch| *epoch = epoch.wrapping_add(1));
    if let Some(session) = owner().lock().unwrap().as_ref() {
        session.active.store(false, Ordering::Release);
    }
    let _operation = OPERATION.lock().await;
    let session = owner().lock().unwrap().clone();
    if let Some(session) = session {
        session.active.store(false, Ordering::Release);
        close(&session.connection, &session.path).await?;
        session.closed.store(true, Ordering::Release);
        owner().lock().unwrap().take();
    }
    Ok(())
}
impl Session {
    pub(super) fn notify<B: serde::Serialize + zbus::zvariant::DynamicType>(
        &self,
        method: &str,
        body: &B,
    ) -> Result<(), String> {
        // Called only on the existing blocking input worker, never an async
        // executor thread and never by creating a nested runtime.
        self.runtime.block_on(async {
            proxy(&self.connection, REMOTE)
                .await?
                .call::<_, _, ()>(method, body)
                .await
                .map_err(|_| "native_input_unavailable".into())
        })
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
        if self.closed.load(Ordering::Acquire) {
            return;
        }
        let connection = self.connection.clone();
        let path = self.path.clone();
        self.runtime.spawn(async move {
            if close(&connection, &path).await.is_err() {
                log::warn!("Remote desktop portal close failed");
            }
        });
    }
}
