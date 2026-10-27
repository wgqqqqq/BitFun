//! Foreground seat input. X11 and Portal are selected once; neither is a
//! recovery path for the other. Native delivery and cleanup share one worker.
use super::{portal, x11};
use crate::remote_desktop::native_input::{
    evdev_key, plan_text, NativeInputError as Error, TextChunk,
};
use atspi::zbus::zvariant::Value;
use openbitfun_product_domains::remote_desktop::input::{InputAction, PointerButton};
use std::{
    collections::{BTreeSet, HashMap},
    sync::{atomic::Ordering, Arc},
};
use x11rb::{
    connection::Connection,
    protocol::{
        xproto::{self, ConnectionExt as _},
        xtest::ConnectionExt as _,
    },
    rust_connection::RustConnection,
};
enum Backend {
    Portal(Arc<portal::Session>),
    X11(RustConnection, x11::Display),
}
enum TextRelease {
    Portal(i32),
    X11 {
        code: u8,
        old: Vec<u32>,
        mapped: Vec<u32>,
        down: bool,
    },
}
pub(in crate::remote_desktop) struct Input {
    backend: Backend,
    keys: BTreeSet<u16>,
    buttons: [bool; 3],
    text: Option<TextRelease>,
    wheel: [f64; 2],
    wheel_release: Option<u8>,
}
type Options<'a> = HashMap<&'a str, Value<'a>>;
impl Input {
    pub(in crate::remote_desktop) fn open(id: &str) -> Result<Self, Error> {
        let backend = if super::wayland() {
            let session = portal::current()
                .filter(|s| s.id == id && s.devices & 3 == 3)
                .ok_or(Error::PermissionRequired)?;
            Backend::Portal(session)
        } else {
            if !x11::session_available() {
                return Err(Error::SessionUnavailable);
            }
            let display = x11::resolve(id).map_err(|_| Error::TargetChanged)?;
            let (connection, _) = x11::connect().map_err(|_| Error::NativeUnavailable)?;
            connection
                .xtest_get_version(2, 2)
                .map_err(|_| Error::NativeUnavailable)?
                .reply()
                .map_err(|_| Error::NativeUnavailable)?;
            let held = connection
                .query_keymap()
                .map_err(|_| Error::NativeUnavailable)?
                .reply()
                .map_err(|_| Error::NativeUnavailable)?;
            let pointer = connection
                .query_pointer(display.root)
                .map_err(|_| Error::NativeUnavailable)?
                .reply()
                .map_err(|_| Error::NativeUnavailable)?;
            if held.keys.iter().any(|v| *v != 0) || u16::from(pointer.mask) & 0x1f00 != 0 {
                return Err(Error::InputSuspended);
            }
            Backend::X11(connection, display)
        };
        Ok(Self {
            backend,
            keys: BTreeSet::new(),
            buttons: [false; 3],
            text: None,
            wheel: [0.0; 2],
            wheel_release: None,
        })
    }
    fn check(&self, permit: impl FnOnce() -> bool) -> Result<(), Error> {
        if !super::session_unlocked() {
            return Err(Error::SessionUnavailable);
        }
        match &self.backend {
            Backend::Portal(s) if !s.active.load(Ordering::Acquire) => {
                return Err(Error::SessionUnavailable)
            }
            Backend::X11(_, display) => {
                if !x11::session_available() {
                    return Err(Error::SessionUnavailable);
                }
                if x11::resolve(&display.id).map_err(|_| Error::TargetChanged)? != *display {
                    return Err(Error::TargetChanged);
                }
            }
            _ => {}
        }
        if !permit() {
            return Err(Error::InputSuspended);
        }
        Ok(())
    }
    fn fake(
        connection: &RustConnection,
        kind: u8,
        detail: u8,
        root: u32,
        x: i16,
        y: i16,
    ) -> Result<(), Error> {
        connection
            .xtest_fake_input(kind, detail, x11rb::CURRENT_TIME, root, x, y, 0)
            .map_err(|_| Error::NativeUnavailable)?
            .check()
            .map_err(|_| Error::NativeUnavailable)
    }
    fn key(&self, key: u16, down: bool) -> Result<(), Error> {
        match &self.backend {
            Backend::Portal(s) => s
                .notify(
                    "NotifyKeyboardKeycode",
                    &(&s.path, Options::new(), i32::from(key), u32::from(down)),
                )
                .map_err(|_| Error::NativeUnavailable),
            Backend::X11(c, _) => Self::fake(
                c,
                if down {
                    xproto::KEY_PRESS_EVENT
                } else {
                    xproto::KEY_RELEASE_EVENT
                },
                u8::try_from(key + 8).map_err(|_| Error::UnsupportedInput)?,
                0,
                0,
                0,
            ),
        }
    }
    fn button(&self, index: usize, down: bool) -> Result<(), Error> {
        match &self.backend {
            Backend::Portal(s) => s
                .notify(
                    "NotifyPointerButton",
                    &(&s.path, Options::new(), 272 + index as i32, u32::from(down)),
                )
                .map_err(|_| Error::NativeUnavailable),
            Backend::X11(c, _) => Self::fake(
                c,
                if down {
                    xproto::BUTTON_PRESS_EVENT
                } else {
                    xproto::BUTTON_RELEASE_EVENT
                },
                [1, 3, 2][index],
                0,
                0,
                0,
            ),
        }
    }
    fn pointer(&self, x: f64, y: f64) -> Result<(), Error> {
        match &self.backend {
            Backend::Portal(s) => s
                .notify(
                    "NotifyPointerMotionAbsolute",
                    &(
                        &s.path,
                        Options::new(),
                        s.stream,
                        x * f64::from(s.size.0 - 1),
                        y * f64::from(s.size.1 - 1),
                    ),
                )
                .map_err(|_| Error::NativeUnavailable),
            Backend::X11(c, d) => {
                let px = i32::from(d.x) + (x * f64::from(d.width - 1)).round() as i32;
                let py = i32::from(d.y) + (y * f64::from(d.height - 1)).round() as i32;
                Self::fake(
                    c,
                    xproto::MOTION_NOTIFY_EVENT,
                    0,
                    d.root,
                    px.try_into().map_err(|_| Error::TargetChanged)?,
                    py.try_into().map_err(|_| Error::TargetChanged)?,
                )
            }
        }
    }
    pub(in crate::remote_desktop) fn submit(
        &mut self,
        action: &InputAction,
        permit: impl Fn() -> bool,
    ) -> Result<(), Error> {
        action.validate(false).map_err(|_| Error::InvalidInput)?;
        self.check(&permit)?;
        match *action {
            InputAction::PointerMove { x, y } => self.pointer(x, y),
            InputAction::PointerButton { button, down, x, y } => {
                let index = match button {
                    PointerButton::Left => 0,
                    PointerButton::Right => 1,
                    PointerButton::Middle => 2,
                };
                if self.buttons[index] == down {
                    return Err(Error::InvalidInput);
                }
                self.pointer(x, y)?;
                self.check(&permit)?;
                if down {
                    self.buttons[index] = true;
                }
                self.button(index, down)?;
                self.buttons[index] = down;
                Ok(())
            }
            InputAction::Key { usage, down } => {
                let key = evdev_key(usage).ok_or(Error::UnsupportedInput)?;
                if !down && !self.keys.contains(&key) {
                    return Err(Error::InvalidInput);
                }
                if down {
                    self.keys.insert(key);
                }
                self.key(key, down)?;
                if !down {
                    self.keys.remove(&key);
                }
                Ok(())
            }
            InputAction::Wheel { x, y, dx, dy } => {
                self.pointer(x, y)?;
                self.check(&permit)?;
                if let Backend::Portal(s) = &self.backend {
                    return s
                        .notify(
                            "NotifyPointerAxis",
                            &(
                                &s.path,
                                Options::from([("finish", Value::from(true))]),
                                dx,
                                dy,
                            ),
                        )
                        .map_err(|_| Error::NativeUnavailable);
                }
                let Backend::X11(c, _) = &self.backend else {
                    return Err(Error::NativeUnavailable);
                };
                for (index, delta) in [dx, dy].into_iter().enumerate() {
                    let total = self.wheel[index] + delta / 100.0;
                    let steps = total.trunc() as i32;
                    if steps.abs() > 64 {
                        return Err(Error::InvalidInput);
                    }
                    self.wheel[index] = total;
                    for _ in 0..steps.unsigned_abs() {
                        self.check(&permit)?;
                        let button = if index == 0 {
                            if steps > 0 {
                                7
                            } else {
                                6
                            }
                        } else if steps > 0 {
                            5
                        } else {
                            4
                        };
                        self.wheel_release = Some(button);
                        Self::fake(c, xproto::BUTTON_PRESS_EVENT, button, 0, 0, 0)?;
                        // This up is cleanup for the just-posted wheel down.
                        Self::fake(c, xproto::BUTTON_RELEASE_EVENT, button, 0, 0, 0)?;
                        self.wheel_release = None;
                        self.wheel[index] -= f64::from(steps.signum());
                    }
                }
                Ok(())
            }
            _ => Err(Error::UnsupportedInput),
        }
    }
    pub(in crate::remote_desktop) fn plan_text(text: &str) -> Result<Vec<TextChunk>, Error> {
        plan_text(text).map_err(|_| Error::InvalidInput)
    }
    pub(in crate::remote_desktop) fn submit_text_chunk(
        &mut self,
        chunk: &TextChunk,
        permit: impl FnOnce() -> bool,
    ) -> Result<(), Error> {
        if !self.keys.is_empty() || self.buttons.iter().any(|b| *b) || self.text.is_some() {
            return Err(Error::InputSuspended);
        }
        self.check(permit)?;
        let symbol = match chunk.0 {
            '\n' | '\r' => 0xff0d,
            '\t' => 0xff09,
            c if c as u32 <= 0xff => c as u32,
            c => 0x01000000 | c as u32,
        };
        match &self.backend {
            Backend::Portal(s) => {
                self.text = Some(TextRelease::Portal(symbol as i32));
                s.notify(
                    "NotifyKeyboardKeysym",
                    &(&s.path, Options::new(), symbol as i32, 1u32),
                )
                .map_err(|_| Error::NativeUnavailable)?;
            }
            Backend::X11(c, _) => {
                let (code, old) = x11::free_key(c).map_err(|_| Error::UnsupportedInput)?;
                let mut mapped = vec![0; old.len()];
                mapped[0] = symbol;
                self.text = Some(TextRelease::X11 {
                    code,
                    old,
                    mapped: mapped.clone(),
                    down: true,
                });
                c.change_keyboard_mapping(1, code, mapped.len() as u8, &mapped)
                    .map_err(|_| Error::NativeUnavailable)?
                    .check()
                    .map_err(|_| Error::NativeUnavailable)?;
                Self::fake(c, xproto::KEY_PRESS_EVENT, code, 0, 0, 0)?;
            }
        }
        self.release_text()
    }
    fn release_text(&mut self) -> Result<(), Error> {
        let Some(text) = self.text.as_mut() else {
            return Ok(());
        };
        match (&self.backend, text) {
            (Backend::Portal(s), TextRelease::Portal(symbol)) => s
                .notify(
                    "NotifyKeyboardKeysym",
                    &(&s.path, Options::new(), *symbol, 0u32),
                )
                .map_err(|_| Error::NativeUnavailable)?,
            (
                Backend::X11(c, _),
                TextRelease::X11 {
                    code,
                    old,
                    mapped,
                    down,
                },
            ) => {
                if *down {
                    Self::fake(c, xproto::KEY_RELEASE_EVENT, *code, 0, 0, 0)?;
                    *down = false;
                }
                let now = c
                    .get_keyboard_mapping(*code, 1)
                    .map_err(|_| Error::NativeUnavailable)?
                    .reply()
                    .map_err(|_| Error::NativeUnavailable)?;
                if now.keysyms != *old && now.keysyms != *mapped {
                    return Err(Error::TargetChanged);
                }
                c.change_keyboard_mapping(1, *code, old.len() as u8, old)
                    .map_err(|_| Error::NativeUnavailable)?
                    .check()
                    .map_err(|_| Error::NativeUnavailable)?;
            }
            _ => return Err(Error::NativeUnavailable),
        }
        self.text = None;
        Ok(())
    }
    pub(in crate::remote_desktop) fn drain(&mut self) -> Result<(), Error> {
        if matches!(&self.backend,Backend::Portal(s) if s.closed.load(Ordering::Acquire)) {
            self.keys.clear();
            self.buttons = [false; 3];
            self.text = None;
            self.wheel = [0.0; 2];
            self.wheel_release = None;
            return Ok(());
        }
        for key in self.keys.clone() {
            self.key(key, false)?;
            self.keys.remove(&key);
        }
        for index in 0..3 {
            if self.buttons[index] {
                self.button(index, false)?;
                self.buttons[index] = false;
            }
        }
        if let (Some(button), Backend::X11(connection, _)) = (self.wheel_release, &self.backend) {
            Self::fake(connection, xproto::BUTTON_RELEASE_EVENT, button, 0, 0, 0)?;
            self.wheel_release = None;
        }
        self.release_text()?;
        self.wheel = [0.0; 2];
        Ok(())
    }
}
