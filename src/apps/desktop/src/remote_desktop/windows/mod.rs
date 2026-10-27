//! Display identities and the current interactive Windows desktop only.
use sha2::{Digest, Sha256};
use windows::{
    core::{BOOL, PCWSTR},
    Win32::{
        Foundation::{HANDLE, LPARAM, RECT},
        Graphics::Gdi::{
            EnumDisplayDevicesW, EnumDisplayMonitors, EnumDisplaySettingsW, GetMonitorInfoW,
            DEVMODEW, DISPLAY_DEVICEW, ENUM_CURRENT_SETTINGS, HDC, HMONITOR, MONITORINFOEXW,
        },
        System::{
            StationsAndDesktops::{
                CloseDesktop, GetThreadDesktop, GetUserObjectInformationW, OpenInputDesktop,
                DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS, HDESK, UOI_NAME,
            },
            Threading::GetCurrentThreadId,
        },
    },
};

#[cfg(feature = "remote-desktop-media")]
mod capture;
#[cfg(feature = "remote-desktop-media")]
mod input;
#[cfg(feature = "remote-desktop-media")]
pub(super) use capture::Source;
#[cfg(feature = "remote-desktop-media")]
pub(super) use input::Input;

#[derive(Clone, PartialEq, Eq)]
pub(super) struct Display {
    pub id: String,
    pub monitor: usize,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub orientation: u32,
    pub dpi: (u32, u32),
}
fn wide(value: &[u16]) -> String {
    String::from_utf16_lossy(&value[..value.iter().position(|c| *c == 0).unwrap_or(value.len())])
}
pub(super) struct PhysicalCoordinates(windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT);
pub(super) fn physical_coordinates() -> Result<PhysicalCoordinates, String> {
    use windows::Win32::UI::HiDpi::{
        SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    let previous =
        unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    if previous.0.is_null() {
        return Err("physical_coordinates_unavailable".into());
    }
    Ok(PhysicalCoordinates(previous))
}
impl Drop for PhysicalCoordinates {
    fn drop(&mut self) {
        unsafe {
            windows::Win32::UI::HiDpi::SetThreadDpiAwarenessContext(self.0);
        }
    }
}
pub(super) fn session_available() -> bool {
    fn name(desktop: HDESK) -> Option<String> {
        let mut text = [0u16; 256];
        unsafe {
            GetUserObjectInformationW(
                HANDLE(desktop.0),
                UOI_NAME,
                Some(text.as_mut_ptr().cast()),
                std::mem::size_of_val(&text) as u32,
                None,
            )
            .ok()?;
        }
        Some(wide(&text))
    }
    unsafe {
        let Ok(input) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)
        else {
            return false;
        };
        let current = GetThreadDesktop(GetCurrentThreadId()).ok().and_then(name);
        let incoming = name(input);
        let _ = CloseDesktop(input);
        current.as_deref() == Some("Default") && incoming == current
    }
}
pub(super) fn list() -> Result<Vec<Display>, String> {
    let _physical = physical_coordinates()?;
    unsafe extern "system" fn enumerate(
        monitor: HMONITOR,
        _: HDC,
        _: *mut RECT,
        data: LPARAM,
    ) -> BOOL {
        let result = unsafe { &mut *(data.0 as *mut Result<Vec<Display>, String>) };
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of_val(&info) as u32;
        if !unsafe { GetMonitorInfoW(monitor, &mut info.monitorInfo) }.as_bool() {
            *result = Err("display_unavailable".into());
            return BOOL(0);
        }
        let mut device = DISPLAY_DEVICEW::default();
        device.cb = std::mem::size_of_val(&device) as u32;
        if !unsafe { EnumDisplayDevicesW(PCWSTR(info.szDevice.as_ptr()), 0, &mut device, 1) }
            .as_bool()
            || wide(&device.DeviceID).is_empty()
        {
            *result = Err("display_identity_unavailable".into());
            return BOOL(0);
        }
        let mut mode = DEVMODEW::default();
        mode.dmSize = std::mem::size_of_val(&mode) as u16;
        let (mut dpi_x, mut dpi_y) = (0, 0);
        if !unsafe {
            EnumDisplaySettingsW(
                PCWSTR(info.szDevice.as_ptr()),
                ENUM_CURRENT_SETTINGS,
                &mut mode,
            )
        }
        .as_bool()
            || unsafe {
                windows::Win32::UI::HiDpi::GetDpiForMonitor(
                    monitor,
                    windows::Win32::UI::HiDpi::MDT_EFFECTIVE_DPI,
                    &mut dpi_x,
                    &mut dpi_y,
                )
            }
            .is_err()
            || dpi_x == 0
            || dpi_y == 0
        {
            *result = Err("display_geometry_unavailable".into());
            return BOOL(0);
        }
        let orientation = unsafe { mode.Anonymous1.Anonymous2.dmDisplayOrientation.0 };
        let rect = info.monitorInfo.rcMonitor;
        let (width, height) = (
            rect.right.saturating_sub(rect.left),
            rect.bottom.saturating_sub(rect.top),
        );
        if width < 2 || height < 2 {
            *result = Err("display_unavailable".into());
            return BOOL(0);
        }
        if let Ok(displays) = result {
            displays.push(Display {
                id: format!(
                    "windows:{:x}",
                    Sha256::digest(wide(&device.DeviceID).to_lowercase().as_bytes())
                ),
                monitor: monitor.0 as usize,
                x: rect.left,
                y: rect.top,
                width: width as u32,
                height: height as u32,
                orientation,
                dpi: (dpi_x, dpi_y),
            });
        }
        BOOL(1)
    }
    let mut result = Ok(Vec::new());
    if !unsafe {
        EnumDisplayMonitors(
            None,
            None,
            Some(enumerate),
            LPARAM((&mut result as *mut _) as isize),
        )
    }
    .as_bool()
        && result.is_ok()
    {
        return Err("display_enumeration_failed".into());
    }
    result
}
pub(super) fn resolve(id: &str) -> Result<Display, String> {
    list()?
        .into_iter()
        .find(|display| display.id == id)
        .ok_or_else(|| "target_lost".into())
}
pub(super) fn availability() -> &'static str {
    if !session_available() {
        "host_locked"
    } else if list().is_ok_and(|displays| !displays.is_empty()) {
        "ready"
    } else {
        "media_backend_unavailable"
    }
}
