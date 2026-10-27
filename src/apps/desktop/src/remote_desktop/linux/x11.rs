use sha2::{Digest, Sha256};
use std::sync::OnceLock;
use x11rb::{
    connection::Connection,
    protocol::{
        randr::{Connection as OutputConnection, ConnectionExt as _},
        screensaver::{ConnectionExt as _, State},
        xproto::{AtomEnum, ConnectionExt as _},
    },
    rust_connection::RustConnection,
};
#[derive(Clone, PartialEq, Eq)]
pub(super) struct Display {
    pub id: String,
    pub root: u32,
    pub x: i16,
    pub y: i16,
    pub width: u16,
    pub height: u16,
    pub rotation: u16,
}
pub(super) fn connect() -> Result<(RustConnection, usize), String> {
    if super::wayland() {
        return Err("portal_session_required".into());
    }
    x11rb::connect(None).map_err(|_| "desktop_unavailable".into())
}
pub(super) fn control_available() -> bool {
    use x11rb::protocol::xtest::ConnectionExt as _;
    let Ok((connection, _)) = connect() else {
        return false;
    };
    connection
        .xtest_get_version(2, 2)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .is_some_and(|version| (version.major_version, version.minor_version) >= (2, 2))
}
pub(super) fn session_available() -> bool {
    let Ok((connection, screen)) = connect() else {
        return false;
    };
    connection
        .screensaver_query_info(connection.setup().roots[screen].root)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .is_some_and(|reply| reply.state != u8::from(State::ON))
}
pub(super) fn list() -> Result<Vec<Display>, String> {
    let (connection, screen) = connect()?;
    let root = connection.setup().roots[screen].root;
    let resources = connection
        .randr_get_screen_resources_current(root)
        .map_err(|_| "display_unavailable")?
        .reply()
        .map_err(|_| "display_unavailable")?;
    let edid = connection
        .intern_atom(false, b"EDID")
        .map_err(|_| "display_unavailable")?
        .reply()
        .map_err(|_| "display_unavailable")?
        .atom;
    let mut displays = Vec::new();
    for output in resources.outputs {
        let info = connection
            .randr_get_output_info(output, resources.config_timestamp)
            .map_err(|_| "display_unavailable")?
            .reply()
            .map_err(|_| "display_unavailable")?;
        if info.connection != OutputConnection::CONNECTED || info.crtc == 0 {
            continue;
        }
        let crtc = connection
            .randr_get_crtc_info(info.crtc, resources.config_timestamp)
            .map_err(|_| "display_unavailable")?
            .reply()
            .map_err(|_| "display_unavailable")?;
        if crtc.width < 2 || crtc.height < 2 || crtc.x < 0 || crtc.y < 0 {
            return Err("display_geometry_unavailable".into());
        }
        let identity = connection
            .randr_get_output_property(output, edid, AtomEnum::ANY, 0, 1024, false, false)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .map(|reply| reply.data)
            .filter(|bytes| !bytes.is_empty());
        // Without EDID, grants last only for this process and RandR topology.
        // A replug/restart must never silently authorize a substituted display.
        static BOOT: OnceLock<String> = OnceLock::new();
        let identity = identity.unwrap_or_else(|| {
            format!(
                "{}:{}",
                BOOT.get_or_init(|| uuid::Uuid::new_v4().to_string()),
                resources.config_timestamp
            )
            .into_bytes()
        });
        let mut hash = Sha256::new();
        hash.update(&info.name);
        hash.update([0]);
        hash.update(identity);
        displays.push(Display {
            id: format!("x11:{:x}", hash.finalize()),
            root,
            x: crtc.x,
            y: crtc.y,
            width: crtc.width,
            height: crtc.height,
            rotation: crtc.rotation.into(),
        });
    }
    Ok(displays)
}
pub(super) fn resolve(id: &str) -> Result<Display, String> {
    list()?
        .into_iter()
        .find(|d| d.id == id)
        .ok_or_else(|| "target_lost".into())
}

pub(super) fn free_key(connection: &RustConnection) -> Result<(u8, Vec<u32>), String> {
    let setup = connection.setup();
    let min = setup.min_keycode;
    let count = setup.max_keycode - min + 1;
    let map = connection
        .get_keyboard_mapping(min, count)
        .map_err(|_| "input_unavailable")?
        .reply()
        .map_err(|_| "input_unavailable")?;
    if map.keysyms_per_keycode == 0 {
        return Err("text_unsupported".into());
    }
    map.keysyms
        .chunks(map.keysyms_per_keycode as usize)
        .enumerate()
        .rev()
        .find(|(_, symbols)| symbols.iter().all(|s| *s == 0))
        .map(|(index, symbols)| (min + index as u8, symbols.to_vec()))
        .ok_or_else(|| "text_unsupported".into())
}
