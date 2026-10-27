//! Platform selection only. The shared worker still owns all input authority.
#[cfg(target_os = "linux")]
pub(super) use super::linux::Input as NativeInput;
#[cfg(target_os = "macos")]
pub(super) use super::macos_input::{text::TextChunk, MacInput as NativeInput};
#[cfg(target_os = "windows")]
pub(super) use super::windows::Input as NativeInput;

#[cfg(not(target_os = "macos"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum NativeInputError {
    InvalidInput,
    UnsupportedInput,
    PermissionRequired,
    SessionUnavailable,
    TargetChanged,
    InputSuspended,
    NativeUnavailable,
}
#[cfg(not(target_os = "macos"))]
impl NativeInputError {
    pub(super) fn diagnostic_code(self) -> &'static str {
        match self {
            Self::InvalidInput => "invalid_input",
            Self::UnsupportedInput => "unsupported_input",
            Self::PermissionRequired => "permission_required",
            Self::SessionUnavailable => "session_unavailable",
            Self::TargetChanged => "target_changed",
            Self::InputSuspended => "input_suspended",
            Self::NativeUnavailable => "native_unavailable",
        }
    }
}

#[cfg(any(not(target_os = "macos"), test))]
#[path = "input_plan.rs"]
mod plan;
#[cfg(not(target_os = "macos"))]
pub(super) use plan::{evdev_key, plan_text, windows_scan, TextChunk};

pub(super) fn available() -> bool {
    #[cfg(target_os = "linux")]
    {
        return super::linux::control_available();
    }
    #[cfg(not(target_os = "linux"))]
    true
}
pub(super) fn text_supported() -> bool {
    #[cfg(target_os = "linux")]
    {
        return super::linux::text_supported();
    }
    #[cfg(not(target_os = "linux"))]
    true
}
