//! Fail closed when the desktop cannot report lock state. A lost D-Bus owner
//! never turns into an unlocked seat. No capture or input is performed here.
use atspi::zbus;
use futures::StreamExt;
use std::sync::atomic::{AtomicBool, Ordering};
static UNLOCKED: AtomicBool = AtomicBool::new(false);
static WATCHING: AtomicBool = AtomicBool::new(false);
static INIT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
pub(super) fn known() -> bool {
    WATCHING.load(Ordering::Acquire)
}
pub(super) fn unlocked() -> bool {
    UNLOCKED.load(Ordering::Acquire) && WATCHING.load(Ordering::Acquire)
}
pub(super) async fn initialize() {
    let _guard = INIT.lock().await;
    if WATCHING.load(Ordering::Acquire) {
        return;
    }
    UNLOCKED.store(false, Ordering::Release);
    let Ok(connection) = zbus::Connection::session().await else {
        return;
    };
    for (destination, path) in [
        (
            "org.freedesktop.ScreenSaver",
            "/org/freedesktop/ScreenSaver",
        ),
        ("org.freedesktop.ScreenSaver", "/ScreenSaver"),
        ("org.gnome.ScreenSaver", "/org/gnome/ScreenSaver"),
    ] {
        let Ok(proxy) =
            zbus::Proxy::new_owned(connection.clone(), destination, path, destination).await
        else {
            continue;
        };
        let Ok(mut changed) = proxy.receive_signal("ActiveChanged").await else {
            continue;
        };
        let Ok(mut owner_changed) = proxy.receive_owner_changed().await else {
            continue;
        };
        let active: Result<bool, _> = proxy.call("GetActive", &()).await;
        let Ok(active) = active else {
            continue;
        };
        UNLOCKED.store(!active, Ordering::Release);
        WATCHING.store(true, Ordering::Release);
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    changed=changed.next()=>match changed {
                        Some(signal)=>{let active=signal.body().deserialize::<(bool,)>().map(|v|v.0).unwrap_or(true);UNLOCKED.store(!active,Ordering::Release);},
                        None=>break,
                    },
                    _=owner_changed.next()=>break,
                }
            }
            UNLOCKED.store(false, Ordering::Release);
            WATCHING.store(false, Ordering::Release);
        });
        return;
    }
}
