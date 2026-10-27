//! Independent Linux remote desktop seat; never borrows the AI's portal session.
#[cfg(feature = "remote-desktop-media")]
mod input;
mod portal;
mod session;
#[cfg(feature = "remote-desktop-media")]
mod source;
mod x11;
#[cfg(feature = "remote-desktop-media")]
pub(super) use input::Input;
#[cfg(feature = "remote-desktop-media")]
pub(super) use source::Source;

pub(super) fn wayland() -> bool {
    std::env::var("XDG_SESSION_TYPE").is_ok_and(|s| s.eq_ignore_ascii_case("wayland"))
        || std::env::var_os("WAYLAND_DISPLAY").is_some_and(|s| !s.is_empty())
}
pub(super) fn list() -> Result<Vec<super::displays::Display>, String> {
    if wayland() {
        Ok(portal::current()
            .into_iter()
            .map(|s| super::displays::Display {
                display_id: s.id.clone(),
                width: s.size.0 as u64,
                height: s.size.1 as u64,
            })
            .collect())
    } else {
        x11::list().map(|displays| {
            displays
                .into_iter()
                .map(|d| super::displays::Display {
                    display_id: d.id,
                    width: d.width as u64,
                    height: d.height as u64,
                })
                .collect()
        })
    }
}
pub(super) fn availability() -> &'static str {
    if gstreamer::init().is_err()
        || [
            if wayland() {
                "pipewiresrc"
            } else {
                "ximagesrc"
            },
            "videoconvert",
            "appsink",
        ]
        .iter()
        .any(|name| gstreamer::ElementFactory::find(name).is_none())
    {
        return "media_backend_unavailable";
    }
    if wayland() && portal::current().is_none() {
        return "permission_required";
    }
    if !session::known() {
        return "unsupported";
    }
    if !session::unlocked() {
        return "host_locked";
    }
    if wayland() {
        if portal::current().is_some() {
            "ready"
        } else {
            "permission_required"
        }
    } else if x11::session_available() {
        "ready"
    } else {
        "host_locked"
    }
}
pub(crate) async fn authorize() -> Result<(), String> {
    portal::authorize().await
}
pub(crate) async fn revoke() -> Result<(), String> {
    portal::revoke().await
}
pub(crate) async fn initialize() {
    session::initialize().await;
}
pub(super) fn session_unlocked() -> bool {
    session::unlocked()
}
pub(super) fn control_available() -> bool {
    if wayland() {
        portal::current().is_some_and(|s| s.devices & 3 == 3)
    } else {
        x11::control_available()
    }
}
pub(super) fn text_supported() -> bool {
    if wayland() {
        return control_available();
    }
    x11::connect().is_ok_and(|(connection, _)| x11::free_key(&connection).is_ok())
}
