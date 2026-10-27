//! Foreground SendInput in the already unlocked desktop. Never elevates or
//! switches desktops; partial delivery retains a release ledger.
use super::*;
use crate::remote_desktop::native_input::{
    plan_text, windows_scan, NativeInputError as Error, TextChunk,
};
use openbitfun_product_domains::remote_desktop::input::{InputAction, PointerButton};
use std::collections::BTreeSet;
use windows::Win32::UI::{
    Input::KeyboardAndMouse::{
        GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
        KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, KEYEVENTF_UNICODE,
        MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
        MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
        MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT,
    },
    WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    },
};

pub(in crate::remote_desktop) struct Input {
    target: Display,
    keys: BTreeSet<u16>,
    buttons: [bool; 3],
    text: Vec<u16>,
    wheel: [f64; 2],
}
fn send(events: &[INPUT]) -> Result<(), Error> {
    if !session_available() {
        return Err(Error::SessionUnavailable);
    }
    if unsafe { SendInput(events, std::mem::size_of::<INPUT>() as i32) } != events.len() as u32 {
        return Err(Error::NativeUnavailable);
    }
    Ok(())
}
fn key(scan: u16, up: bool, unicode: bool) -> INPUT {
    let mut flags = if unicode {
        KEYEVENTF_UNICODE
    } else {
        KEYEVENTF_SCANCODE
    };
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    if !unicode && scan & 0xff00 == 0xe000 {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wScan: if unicode { scan } else { scan & 0xff },
                dwFlags: flags,
                ..Default::default()
            },
        },
    }
}
fn mouse(
    flags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS,
    data: u32,
    x: i32,
    y: i32,
) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: x,
                dy: y,
                mouseData: data,
                dwFlags: flags,
                ..Default::default()
            },
        },
    }
}
fn button(index: usize, down: bool) -> INPUT {
    mouse(
        match (index, down) {
            (0, true) => MOUSEEVENTF_LEFTDOWN,
            (0, false) => MOUSEEVENTF_LEFTUP,
            (1, true) => MOUSEEVENTF_RIGHTDOWN,
            (1, false) => MOUSEEVENTF_RIGHTUP,
            (_, true) => MOUSEEVENTF_MIDDLEDOWN,
            (_, false) => MOUSEEVENTF_MIDDLEUP,
        },
        0,
        0,
        0,
    )
}
impl Input {
    pub(in crate::remote_desktop) fn open(id: &str) -> Result<Self, Error> {
        if !session_available() {
            return Err(Error::SessionUnavailable);
        }
        // Do not release keys that were already held by a local user at acquire.
        if (1..=254).any(|code| unsafe { GetAsyncKeyState(code) } < 0) {
            return Err(Error::InputSuspended);
        }
        Ok(Self {
            target: resolve(id).map_err(|_| Error::TargetChanged)?,
            keys: BTreeSet::new(),
            buttons: [false; 3],
            text: Vec::new(),
            wheel: [0.0; 2],
        })
    }
    fn check(&self, permit: impl FnOnce() -> bool) -> Result<(), Error> {
        if !session_available() {
            return Err(Error::SessionUnavailable);
        }
        if resolve(&self.target.id).map_err(|_| Error::TargetChanged)? != self.target {
            return Err(Error::TargetChanged);
        }
        if !permit() {
            return Err(Error::InputSuspended);
        }
        Ok(())
    }
    fn move_to(&self, x: f64, y: f64) -> Result<INPUT, Error> {
        let _physical = physical_coordinates().map_err(|_| Error::TargetChanged)?;
        if !x.is_finite()
            || !y.is_finite()
            || !(0.0..=1.0).contains(&x)
            || !(0.0..=1.0).contains(&y)
        {
            return Err(Error::InvalidInput);
        }
        let (left, top, width, height) = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        };
        if width < 2 || height < 2 {
            return Err(Error::TargetChanged);
        }
        let px = self.target.x as f64 + x * f64::from(self.target.width - 1);
        let py = self.target.y as f64 + y * f64::from(self.target.height - 1);
        let dx = ((px - f64::from(left)) * 65535.0 / f64::from(width - 1)).round() as i32;
        let dy = ((py - f64::from(top)) * 65535.0 / f64::from(height - 1)).round() as i32;
        Ok(mouse(
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
            0,
            dx,
            dy,
        ))
    }
    pub(in crate::remote_desktop) fn submit(
        &mut self,
        action: &InputAction,
        permit: impl FnOnce() -> bool,
    ) -> Result<(), Error> {
        action.validate(false).map_err(|_| Error::InvalidInput)?;
        self.check(permit)?;
        match *action {
            InputAction::PointerMove { x, y } => send(&[self.move_to(x, y)?]),
            InputAction::PointerButton {
                button: which,
                down,
                x,
                y,
            } => {
                let index = match which {
                    PointerButton::Left => 0,
                    PointerButton::Right => 1,
                    PointerButton::Middle => 2,
                };
                if self.buttons[index] == down {
                    return Err(Error::InvalidInput);
                }
                let movement = self.move_to(x, y)?;
                if down {
                    self.buttons[index] = true;
                }
                send(&[movement, button(index, down)])?;
                self.buttons[index] = down;
                Ok(())
            }
            InputAction::Key { usage, down } => {
                let scan = windows_scan(usage).ok_or(Error::UnsupportedInput)?;
                if !down && !self.keys.contains(&scan) {
                    return Err(Error::InvalidInput);
                }
                if down {
                    self.keys.insert(scan);
                }
                send(&[key(scan, !down, false)])?;
                if !down {
                    self.keys.remove(&scan);
                }
                Ok(())
            }
            InputAction::Wheel { x, y, dx, dy } => {
                send(&[self.move_to(x, y)?])?;
                for (index, delta) in [dx, -dy].into_iter().enumerate() {
                    self.wheel[index] += delta * 1.2;
                    let whole = self.wheel[index].trunc() as i32;
                    if whole != 0 {
                        send(&[mouse(
                            if index == 0 {
                                MOUSEEVENTF_HWHEEL
                            } else {
                                MOUSEEVENTF_WHEEL
                            },
                            whole as u32,
                            0,
                            0,
                        )])?;
                        self.wheel[index] -= f64::from(whole);
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
        if !self.keys.is_empty() || self.buttons.iter().any(|held| *held) || !self.text.is_empty() {
            return Err(Error::InputSuspended);
        }
        self.check(permit)?;
        let mut units = [0; 2];
        self.text
            .extend_from_slice(chunk.0.encode_utf16(&mut units));
        let events: Vec<_> = self
            .text
            .iter()
            .flat_map(|unit| [key(*unit, false, true), key(*unit, true, true)])
            .collect();
        send(&events)?;
        self.text.clear();
        Ok(())
    }
    pub(in crate::remote_desktop) fn drain(&mut self) -> Result<(), Error> {
        for scan in self.keys.clone() {
            send(&[key(scan, true, false)])?;
            self.keys.remove(&scan);
        }
        for index in 0..3 {
            if self.buttons[index] {
                send(&[button(index, false)])?;
                self.buttons[index] = false;
            }
        }
        while let Some(unit) = self.text.last().copied() {
            send(&[key(unit, true, true)])?;
            self.text.pop();
        }
        self.wheel = [0.0; 2];
        Ok(())
    }
}
