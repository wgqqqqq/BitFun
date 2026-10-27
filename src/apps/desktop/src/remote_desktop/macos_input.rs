//! Display-scoped foreground input, never the AI's directed window backend.
//! Reserved for the control owner; the read-only dispatcher never calls this.
//! The owner must hold its admission/native mutex across submit, invalidate and
//! drain. The final permit checks PC, grant, lease, health and GUI reservation.

use core_foundation::{
    base::TCFType,
    string::CFString,
    uuid::{CFUUIDCreateString, CFUUIDRef, CFUUID},
};
use core_graphics::{
    display::CGDisplay,
    event::{
        CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, ScrollEventUnit,
    },
    event_source::{CGEventSource, CGEventSourceStateID},
    geometry::CGPoint,
};
use foreign_types::ForeignType;
use openbitfun_product_domains::remote_desktop::input::{
    InputAction, PointerButton, SourceGeometry,
};
use std::{
    collections::BTreeSet,
    ffi::c_void,
    marker::PhantomData,
    rc::Rc,
    time::{Duration, Instant},
};

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

impl NativeInputError {
    /// Closed diagnostic labels; never include event bodies or OS error text.
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

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
    fn CGPreflightPostEventAccess() -> bool;
    fn CGDisplayCreateUUIDFromDisplayID(display: u32) -> CFUUIDRef;
    fn obf_rd_input_session_available() -> bool;
    fn obf_rd_double_click_interval() -> f64;
    fn CGEventSetLocation(event: *mut c_void, point: CGPoint);
}

#[link(name = "Carbon", kind = "framework")]
extern "C" {
    fn IsSecureEventInputEnabled() -> bool;
}

fn session_available() -> bool {
    unsafe { obf_rd_input_session_available() && !IsSecureEventInputEnabled() }
}

fn permission() -> bool {
    // No options/request API: this probe never opens an OS prompt.
    unsafe { AXIsProcessTrustedWithOptions(std::ptr::null()) && CGPreflightPostEventAccess() }
}

fn display_uuid(id: u32) -> Option<String> {
    let uuid = unsafe { CGDisplayCreateUUIDFromDisplayID(id) };
    if uuid.is_null() {
        return None;
    }
    let uuid: CFUUID = unsafe { TCFType::wrap_under_create_rule(uuid) };
    let string = unsafe { CFUUIDCreateString(std::ptr::null(), uuid.as_concrete_TypeRef()) };
    if string.is_null() {
        return None;
    }
    let string: CFString = unsafe { TCFType::wrap_under_create_rule(string) };
    Some(format!("macos:{}", string.to_string().to_lowercase()))
}

struct BoundDisplay {
    id: u32,
    uuid: String,
    geometry: SourceGeometry,
    rotation: f64,
}
impl BoundDisplay {
    fn read(id: u32) -> Result<Self, NativeInputError> {
        let display = CGDisplay::new(id);
        if !display.is_active() {
            return Err(NativeInputError::TargetChanged);
        }
        let bounds = display.bounds();
        let geometry = SourceGeometry::new(
            (bounds.origin.x, bounds.origin.y),
            (bounds.size.width, bounds.size.height),
            (
                u32::try_from(display.pixels_wide())
                    .map_err(|_| NativeInputError::TargetChanged)?,
                u32::try_from(display.pixels_high())
                    .map_err(|_| NativeInputError::TargetChanged)?,
            ),
        )
        .map_err(|_| NativeInputError::TargetChanged)?;
        let rotation = display.rotation();
        if !rotation.is_finite() {
            return Err(NativeInputError::TargetChanged);
        }
        Ok(Self {
            id,
            uuid: display_uuid(id).ok_or(NativeInputError::TargetChanged)?,
            geometry,
            rotation,
        })
    }
    fn current(&self) -> bool {
        Self::read(self.id).is_ok_and(|current| {
            current.uuid == self.uuid
                && current.geometry == self.geometry
                && current.rotation == self.rotation
        })
    }
    fn point(&self, x: f64, y: f64) -> Result<CGPoint, NativeInputError> {
        self.geometry
            .project(x, y)
            .map(|(x, y)| CGPoint::new(x, y))
            .map_err(|_| NativeInputError::InvalidInput)
    }
}

#[derive(Default, Clone)]
struct Held {
    keys: BTreeSet<u16>,
    text: Option<Vec<u16>>,
    buttons: [bool; 3],
    wheel: (f64, f64),
    click: Option<Click>,
    click_counts: [i64; 3],
}

#[derive(Clone)]
struct Click {
    index: usize,
    point: CGPoint,
    flags: CGEventFlags,
    at: Instant,
    count: i64,
}
impl Held {
    fn flags(&self) -> CGEventFlags {
        self.keys
            .iter()
            .fold(CGEventFlags::CGEventFlagNull, |flags, usage| {
                flags | modifier(*usage)
            })
    }
    fn motion(&self) -> (CGEventType, CGMouseButton) {
        match self.buttons {
            [true, ..] => (CGEventType::LeftMouseDragged, CGMouseButton::Left),
            [_, true, _] => (CGEventType::RightMouseDragged, CGMouseButton::Right),
            [_, _, true] => (CGEventType::OtherMouseDragged, CGMouseButton::Center),
            _ => (CGEventType::MouseMoved, CGMouseButton::Left),
        }
    }
}

/// Created/used/drained on a single blocking worker. No transferable native
/// authority token and no Drop-time input: failed cleanup stays with the owner.
pub(super) struct MacInput {
    display: BoundDisplay,
    source: CGEventSource,
    held: Held,
    double_click_interval: Duration,
    _worker: PhantomData<Rc<()>>,
}
#[allow(dead_code)] // Reserved adapter; no control capability before native/health acceptance.
impl MacInput {
    pub(super) fn open(display_id: &str) -> Result<Self, NativeInputError> {
        if !permission() {
            return Err(NativeInputError::PermissionRequired);
        }
        if !session_available() {
            return Err(NativeInputError::SessionUnavailable);
        }
        let id = CGDisplay::active_displays()
            .map_err(|_| NativeInputError::NativeUnavailable)?
            .into_iter()
            .find(|id| display_uuid(*id).as_deref() == Some(display_id))
            .ok_or(NativeInputError::TargetChanged)?;
        let display = BoundDisplay::read(id)?;
        let source = CGEventSource::new(CGEventSourceStateID::Private)
            .map_err(|_| NativeInputError::NativeUnavailable)?;
        let double_click_interval =
            Duration::try_from_secs_f64(unsafe { obf_rd_double_click_interval() })
                .ok()
                .filter(|interval| !interval.is_zero())
                .ok_or(NativeInputError::NativeUnavailable)?;
        Ok(Self {
            display,
            source,
            held: Held::default(),
            double_click_interval,
            _worker: PhantomData,
        })
    }

    /// Success means posted to Quartz, not delivered to the focused app.
    pub(super) fn submit(
        &mut self,
        action: &InputAction,
        permit: impl FnOnce() -> bool,
    ) -> Result<(), NativeInputError> {
        #[cfg(test)]
        let timing_start = Instant::now();
        let (event, mut next) = self.prepare(action)?;
        #[cfg(test)]
        let timing_prepared = Instant::now();
        // Construction above has no OS input effects. One fresh native check
        // is sufficient; do not duplicate TCC/source probes for every event.
        if !permission() {
            return Err(NativeInputError::PermissionRequired);
        }
        #[cfg(test)]
        let timing_permission = Instant::now();
        if !session_available() {
            return Err(NativeInputError::SessionUnavailable);
        }
        #[cfg(test)]
        let timing_session = Instant::now();
        if !self.display.current() {
            return Err(NativeInputError::TargetChanged);
        }
        #[cfg(test)]
        let timing_display = Instant::now();
        // Keep the owner's admission/native lock through this final check and
        // post. Check the lease AFTER potentially slow native permission/IO.
        if !permit() {
            return Err(NativeInputError::InputSuspended);
        }
        #[cfg(test)]
        let timing_permit = Instant::now();
        event.post(CGEventTapLocation::HID);
        // The first Quartz post may block while connecting to the input
        // service. Anchor the next click to completed submission, not event
        // construction; cold startup must not consume the double-click gap.
        if matches!(action, InputAction::PointerButton { down: true, .. }) {
            if let Some(click) = next.click.as_mut() {
                click.at = Instant::now();
            }
        }
        #[cfg(test)]
        if std::env::var_os("OPENBITFUN_RD_INPUT_TIMING").is_some() {
            eprintln!("Native input timing: kind={} prepare_us={} permission_us={} session_us={} display_us={} permit_us={} post_us={} click_count={}",
                action.kind(), timing_prepared.duration_since(timing_start).as_micros(),
                timing_permission.duration_since(timing_prepared).as_micros(), timing_session.duration_since(timing_permission).as_micros(),
                timing_display.duration_since(timing_session).as_micros(), timing_permit.duration_since(timing_display).as_micros(),
                timing_permit.elapsed().as_micros(), event.get_integer_value_field(core_graphics::event::EventField::MOUSE_EVENT_CLICK_STATE));
        }
        self.held = next;
        Ok(())
    }

    // Event construction and ledger planning perform no posting or mutation.
    fn prepare(&self, action: &InputAction) -> Result<(CGEvent, Held), NativeInputError> {
        self.prepare_at(action, Instant::now())
    }

    fn prepare_at(
        &self,
        action: &InputAction,
        now: Instant,
    ) -> Result<(CGEvent, Held), NativeInputError> {
        if self.held.text.is_some() {
            return Err(NativeInputError::InputSuspended);
        }
        action.validate(false).map_err(|error| match error {
            openbitfun_product_domains::remote_desktop::input::InputError::TextUnsupported => {
                NativeInputError::UnsupportedInput
            }
            _ => NativeInputError::InvalidInput,
        })?;
        let mut next = self.held.clone();
        let event = match action {
            InputAction::PointerMove { x, y } => {
                let (kind, button) = next.motion();
                CGEvent::new_mouse_event(
                    self.source.clone(),
                    kind,
                    self.display.point(*x, *y)?,
                    button,
                )
            }
            InputAction::PointerButton { button, down, x, y } => {
                let (index, native, press, release) = button_events(*button);
                if *down == next.buttons[index] {
                    return Err(NativeInputError::InvalidInput);
                }
                let point = self.display.point(*x, *y)?;
                if *down {
                    let count = next
                        .click
                        .as_ref()
                        .filter(|last| {
                            last.index == index
                                && last.flags == next.flags()
                                && last.point.x == point.x
                                && last.point.y == point.y
                                && now
                                    .checked_duration_since(last.at)
                                    .is_some_and(|elapsed| elapsed <= self.double_click_interval)
                        })
                        .map_or(1, |last| last.count.saturating_add(1));
                    next.click = Some(Click {
                        index,
                        point,
                        flags: next.flags(),
                        at: now,
                        count,
                    });
                    next.click_counts[index] = count;
                }
                next.buttons[index] = *down;
                let event = CGEvent::new_mouse_event(
                    self.source.clone(),
                    if *down { press } else { release },
                    point,
                    native,
                )
                .map_err(|_| NativeInputError::NativeUnavailable)?;
                event.set_integer_value_field(
                    core_graphics::event::EventField::MOUSE_EVENT_CLICK_STATE,
                    next.click_counts[index],
                );
                Ok(event)
            }
            InputAction::Wheel { x, y, dx, dy } => {
                next.wheel.0 += dx;
                next.wheel.1 += dy;
                let wx = next.wheel.0.trunc() as i32;
                let wy = next.wheel.1.trunc() as i32;
                next.wheel.0 -= f64::from(wx);
                next.wheel.1 -= f64::from(wy);
                let event = CGEvent::new_scroll_event(
                    self.source.clone(),
                    ScrollEventUnit::PIXEL,
                    2,
                    -wy,
                    -wx,
                    0,
                )
                .map_err(|_| NativeInputError::NativeUnavailable)?;
                unsafe {
                    CGEventSetLocation(event.as_ptr().cast(), self.display.point(*x, *y)?);
                }
                Ok(event)
            }
            InputAction::Key { usage, down } => {
                let code = keycode(*usage).ok_or(NativeInputError::UnsupportedInput)?;
                if !down && !next.keys.contains(usage) {
                    return Err(NativeInputError::InvalidInput);
                }
                let repeated = *down && next.keys.contains(usage);
                if *down {
                    next.keys.insert(*usage);
                } else {
                    next.keys.remove(usage);
                }
                let event = CGEvent::new_keyboard_event(self.source.clone(), code, *down)
                    .map_err(|_| NativeInputError::NativeUnavailable)?;
                event.set_integer_value_field(
                    core_graphics::event::EventField::KEYBOARD_EVENT_AUTOREPEAT,
                    i64::from(repeated),
                );
                Ok(event)
            }
            InputAction::TextCommit { .. } => return Err(NativeInputError::UnsupportedInput),
        }
        .map_err(|_| NativeInputError::NativeUnavailable)?;
        event.set_flags(next.flags());
        Ok((event, next))
    }

    /// The owner first invalidates its lease and drains pending/in-flight work.
    /// This releases only recorded input, without a current control permit.
    /// No display check: unplugging the source must not strand keyboard state.
    pub(super) fn drain(&mut self) -> Result<(), NativeInputError> {
        let source = &self.source;
        let text = self.held.text.clone();
        self.held.drain_with(|release, flags, clicks| {
            if !permission() {
                return Err(NativeInputError::PermissionRequired);
            }
            if !session_available() {
                return Err(NativeInputError::SessionUnavailable);
            }
            let event = match release {
                Release::Text => text::unicode_event(source, text.as_deref().unwrap(), false),
                Release::Key(usage) => CGEvent::new_keyboard_event(
                    source.clone(),
                    keycode(usage).ok_or(NativeInputError::UnsupportedInput)?,
                    false,
                ),
                Release::Button(button) => {
                    let current = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
                        .and_then(CGEvent::new)
                        .map_err(|_| NativeInputError::NativeUnavailable)?;
                    let (_, native, _, up) = button_events(button);
                    CGEvent::new_mouse_event(source.clone(), up, current.location(), native)
                }
            }
            .map_err(|_| NativeInputError::NativeUnavailable)?;
            event.set_flags(flags);
            if matches!(release, Release::Button(_)) {
                event.set_integer_value_field(
                    core_graphics::event::EventField::MOUSE_EVENT_CLICK_STATE,
                    clicks,
                );
            }
            if !permission() {
                return Err(NativeInputError::PermissionRequired);
            }
            if !session_available() {
                return Err(NativeInputError::SessionUnavailable);
            }
            event.post(CGEventTapLocation::HID);
            Ok(())
        })
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Release {
    Text,
    Key(u16),
    Button(PointerButton),
}
impl Held {
    fn drain_with(
        &mut self,
        mut post: impl FnMut(Release, CGEventFlags, i64) -> Result<(), NativeInputError>,
    ) -> Result<(), NativeInputError> {
        self.wheel = (0.0, 0.0);
        self.click = None;
        if self.text.is_some() {
            post(Release::Text, CGEventFlags::CGEventFlagNull, 0)?;
            self.text = None;
        }
        for (index, button) in [
            PointerButton::Left,
            PointerButton::Right,
            PointerButton::Middle,
        ]
        .into_iter()
        .enumerate()
        {
            if self.buttons[index] {
                post(
                    Release::Button(button),
                    self.flags(),
                    self.click_counts[index],
                )?;
                self.buttons[index] = false;
            }
        }
        while let Some(usage) = self
            .keys
            .iter()
            .copied()
            .find(|usage| modifier(*usage).is_empty())
            .or_else(|| self.keys.iter().next().copied())
        {
            let mut next = self.clone();
            next.keys.remove(&usage);
            post(Release::Key(usage), next.flags(), 0)?;
            *self = next;
        }
        Ok(())
    }
}

pub(super) mod text;

fn button_events(button: PointerButton) -> (usize, CGMouseButton, CGEventType, CGEventType) {
    match button {
        PointerButton::Left => (
            0,
            CGMouseButton::Left,
            CGEventType::LeftMouseDown,
            CGEventType::LeftMouseUp,
        ),
        PointerButton::Right => (
            1,
            CGMouseButton::Right,
            CGEventType::RightMouseDown,
            CGEventType::RightMouseUp,
        ),
        PointerButton::Middle => (
            2,
            CGMouseButton::Center,
            CGEventType::OtherMouseDown,
            CGEventType::OtherMouseUp,
        ),
    }
}
fn modifier(usage: u16) -> CGEventFlags {
    match usage {
        0xe0 | 0xe4 => CGEventFlags::CGEventFlagControl,
        0xe1 | 0xe5 => CGEventFlags::CGEventFlagShift,
        0xe2 | 0xe6 => CGEventFlags::CGEventFlagAlternate,
        0xe3 | 0xe7 => CGEventFlags::CGEventFlagCommand,
        _ => CGEventFlags::CGEventFlagNull,
    }
}

// USB Keyboard/Keypad page 0x07 -> HIToolbox Events.h physical virtual keys.
// No character/layout guessing. CapsLock, media/system and unmapped keys are
// explicitly unsupported until their state/delivery native probe is complete.
fn keycode(usage: u16) -> Option<u16> {
    Some(match usage {
        0x04..=0x1d => [
            0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46, 45, 31, 35, 12, 15, 1, 17, 32, 9, 13, 7,
            16, 6,
        ][usize::from(usage - 0x04)],
        0x1e..=0x27 => [18, 19, 20, 21, 23, 22, 26, 28, 25, 29][usize::from(usage - 0x1e)],
        0x28 => 36,
        0x29 => 53,
        0x2a => 51,
        0x2b => 48,
        0x2c => 49,
        0x2d => 27,
        0x2e => 24,
        0x2f => 33,
        0x30 => 30,
        0x31 => 42,
        0x33 => 41,
        0x34 => 39,
        0x35 => 50,
        0x36 => 43,
        0x37 => 47,
        0x38 => 44,
        0x3a..=0x45 => {
            [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111][usize::from(usage - 0x3a)]
        }
        0x4a => 115,
        0x4b => 116,
        0x4c => 117,
        0x4d => 119,
        0x4e => 121,
        0x4f => 124,
        0x50 => 123,
        0x51 => 125,
        0x52 => 126,
        0x54 => 75,
        0x55 => 67,
        0x56 => 78,
        0x57 => 69,
        0x58 => 76,
        0x59..=0x61 => [83, 84, 85, 86, 87, 88, 89, 91, 92][usize::from(usage - 0x59)],
        0x62 => 82,
        0x63 => 65,
        0x67 => 81,
        0xe0..=0xe7 => [59, 56, 58, 55, 62, 60, 61, 54][usize::from(usage - 0xe0)],
        _ => return None,
    })
}

#[cfg(test)]
#[path = "macos_input_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "macos_input_native_tests.rs"]
mod native_tests;
