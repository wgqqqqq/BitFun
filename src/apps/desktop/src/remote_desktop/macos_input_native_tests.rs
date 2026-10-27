//! Opt-in black-box receipt test. No account/media authority is simulated here:
//! this tests production native submission only against its dedicated canvas.
use super::*;
use core_foundation::{
    base::{CFGetTypeID, CFTypeRef},
    dictionary::CFDictionary,
    number::CFNumber,
};
use openbitfun_product_domains::remote_desktop::{
    input::InputMessage, input_admission::InputAdmission,
};
use serde_json::Value;
use std::{path::PathBuf, thread};

#[test]
#[ignore = "Read-only native precondition probe; run through the dedicated fixture script"]
fn native_remote_desktop_input_permission_probe() {
    println!(
        "RD_INPUT_PROBE {}",
        if !permission() {
            "permission_required"
        } else if !session_available() {
            "session_unavailable"
        } else {
            "ready"
        }
    );
}

fn read(path: &PathBuf) -> Value {
    let bytes = std::fs::read(path).expect("Dedicated fixture receipt unavailable");
    assert!(bytes.len() <= 16 * 1024);
    serde_json::from_slice(&bytes).expect("Invalid fixture receipt")
}

fn frontmost_pid() -> Option<i32> {
    use objc2::{
        msg_send,
        runtime::{AnyClass, AnyObject},
    };
    unsafe {
        let class = AnyClass::get(c"NSWorkspace")?;
        let workspace: *mut AnyObject = msg_send![class, sharedWorkspace];
        if workspace.is_null() {
            return None;
        }
        let app: *mut AnyObject = msg_send![workspace, frontmostApplication];
        if app.is_null() {
            return None;
        }
        Some(msg_send![app, processIdentifier])
    }
}

fn window_matches(initial: &Value, pid: i32) -> Option<bool> {
    use core_graphics::window::{copy_window_info, kCGWindowListOptionIncludingWindow};
    let id = u32::try_from(initial["window_id"].as_u64()?).ok()?;
    let array = copy_window_info(kCGWindowListOptionIncludingWindow, id)?;
    if array.len() != 1 {
        return Some(false);
    }
    let item = *array.get(0)? as CFTypeRef;
    if unsafe { CFGetTypeID(item) } != CFDictionary::<*const c_void, *const c_void>::type_id() {
        return None;
    }
    let dict: CFDictionary<*const c_void, *const c_void> =
        unsafe { TCFType::wrap_under_get_rule(item.cast()) };
    let number = |dict: &CFDictionary<*const c_void, *const c_void>, key: &str| -> Option<f64> {
        let key = CFString::new(key);
        let value = *dict.find(key.as_concrete_TypeRef().cast::<c_void>())?;
        if unsafe { CFGetTypeID(value) } != CFNumber::type_id() {
            return None;
        }
        unsafe { CFNumber::wrap_under_get_rule(value.cast()) }.to_f64()
    };
    if number(&dict, "kCGWindowOwnerPID")? != f64::from(pid)
        || number(&dict, "kCGWindowNumber")? != f64::from(id)
        || number(&dict, "kCGWindowLayer")? != 0.0
    {
        return Some(false);
    }
    let key = CFString::new("kCGWindowBounds");
    let bounds = *dict.find(key.as_concrete_TypeRef().cast::<c_void>())?;
    if unsafe { CFGetTypeID(bounds) } != CFDictionary::<*const c_void, *const c_void>::type_id() {
        return None;
    }
    let bounds: CFDictionary<*const c_void, *const c_void> =
        unsafe { TCFType::wrap_under_get_rule(bounds.cast()) };
    for key in ["X", "Y", "Width", "Height"] {
        if number(&bounds, key)? != initial["window_bounds"][key].as_f64()? {
            return Some(false);
        }
    }
    Some(true)
}

fn fixture_allowed(initial: &Value, path: &PathBuf, pid: i32) -> bool {
    let current = read(path);
    frontmost_pid() == Some(pid)
        && current["pid"].as_i64() == Some(i64::from(pid))
        && current["active"] == true
        && current["key_window"] == true
        && current["unexpected_keys"] == 0
        && window_matches(initial, pid) == Some(true)
}

fn wait(path: &PathBuf, condition: impl Fn(&Value) -> bool) -> Value {
    let until = Instant::now() + Duration::from_secs(2);
    loop {
        let state = read(path);
        if condition(&state) {
            return state;
        }
        assert!(
            Instant::now() < until,
            "Dedicated native fixture did not acknowledge the expected event"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
#[ignore = "Posts only to a foreground fixture created by test-remote-desktop-input.mjs"]
fn native_remote_desktop_input_fixture_delivery_and_revoke() {
    assert!(
        permission(),
        "Native input permission unavailable; no permission is requested by the test"
    );
    assert!(
        session_available(),
        "Host session unavailable; the test never unlocks it"
    );
    let path = PathBuf::from(
        std::env::var("OPENBITFUN_RD_INPUT_RECEIPT")
            .expect("Run through the dedicated fixture script"),
    );
    let pid: i32 = std::env::var("OPENBITFUN_RD_INPUT_PID")
        .unwrap()
        .parse()
        .unwrap();
    assert!(pid > 0);
    let initial = wait(&path, |state| {
        state["active"] == true && state["key_window"] == true
    });
    assert!(fixture_allowed(&initial, &path, pid));
    let id = u32::try_from(initial["display_id"].as_u64().unwrap()).unwrap();
    let mut input = MacInput::open(&display_uuid(id).unwrap()).unwrap();
    let reservation = crate::computer_use::control_session::reserve_external_control().unwrap();
    let display = CGDisplay::new(id);
    let bounds = display.bounds();
    let x = (initial["x"].as_f64().unwrap() - bounds.origin.x)
        / (bounds.size.width - bounds.size.width / display.pixels_wide() as f64);
    let y = (initial["y"].as_f64().unwrap() - bounds.origin.y)
        / (bounds.size.height - bounds.size.height / display.pixels_high() as f64);
    let started = Instant::now();
    let mut lease = InputAdmission::default();
    let generation = lease.grant(0).unwrap();
    let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut submit = |action: &InputAction| {
            lease
                .push(
                    InputMessage::new(generation, action.clone()),
                    false,
                    started.elapsed().as_millis() as u64,
                )
                .unwrap();
            let message = lease.pop(started.elapsed().as_millis() as u64).unwrap();
            crate::computer_use::control_session::with_external_control(reservation, || {
                input.submit(message.action(), || {
                    fixture_allowed(&initial, &path, pid)
                        && lease.permits(message.generation(), started.elapsed().as_millis() as u64)
                })
            })
            .unwrap()
        };
        let button = |down| InputAction::PointerButton {
            button: PointerButton::Left,
            down,
            x,
            y,
        };
        eprintln!("Native input fixture: click pair");
        for _ in [1, 2] {
            submit(&button(true)).unwrap();
            submit(&button(false)).unwrap();
        }
        // Production input has no per-event app receipt/round trip. Waiting
        // after each mouse-up would distort the system double-click interval.
        wait(&path, |state| state["downs"] == 2 && state["ups"] == 2);
        assert_eq!(read(&path)["clicks"], serde_json::json!([1, 2]));
        eprintln!("Native input fixture: physical key");
        for down in [true, false] {
            submit(&InputAction::Key { usage: 0x04, down }).unwrap();
        }
        wait(&path, |state| {
            state["key_downs"] == 1 && state["key_ups"] == 1
        });
        eprintln!("Native input fixture: held modifier and drag");
        submit(&InputAction::Key {
            usage: 0xe1,
            down: true,
        })
        .unwrap();
        submit(&InputAction::Key {
            usage: 0x04,
            down: true,
        })
        .unwrap();
        wait(&path, |state| state["shifted_keys"] == 1);
        submit(&button(true)).unwrap();
        submit(&InputAction::PointerMove {
            x: x + 20.0 / (bounds.size.width - bounds.size.width / display.pixels_wide() as f64),
            y,
        })
        .unwrap();
        wait(&path, |state| {
            state["downs"] == 3 && state["drags"].as_u64().is_some_and(|n| n > 0)
        });
    }));
    // Always attempt real ledger cleanup, including on a receipt/assertion
    // failure. Stop the lease before drain; no fresh input may follow it.
    let release = lease.release(generation).unwrap();
    let cleanup =
        crate::computer_use::control_session::release_external_control(reservation, || {
            input
                .drain()
                .map_err(|error| format!("Native input cleanup failed: {error:?}"))
        });
    if let Err(failure) = run {
        if let Err(error) = cleanup {
            eprintln!("Native fixture cleanup failed: {error}");
        }
        std::panic::resume_unwind(failure);
    }
    assert!(cleanup.unwrap());
    wait(&path, |state| {
        state["ups"] == 3 && state["key_ups"] == 2 && state["shift_held"] == false
    });
    assert!(lease.finish_release(release));
    let before = read(&path);
    assert!(
        crate::computer_use::control_session::with_external_control(reservation, || panic!(
            "released GUI reservation executed native input"
        ))
        .is_err()
    );
    assert_eq!(
        input.submit(
            &InputAction::Key {
                usage: 0x04,
                down: true
            },
            || lease.permits(generation, started.elapsed().as_millis() as u64)
                && fixture_allowed(&initial, &path, pid)
        ),
        Err(NativeInputError::InputSuspended)
    );
    thread::sleep(Duration::from_millis(100));
    let after = read(&path);
    assert_eq!(after["key_downs"], before["key_downs"]);
    assert!(input.held.keys.is_empty());
    assert!(!input.held.buttons.into_iter().any(|held| held));
}

#[test]
#[ignore = "Posts Unicode only to the dedicated Cocoa text fixture; run script with --text"]
fn native_remote_desktop_input_text_delivery_and_partial_cancel() {
    assert!(permission() && session_available());
    let path = PathBuf::from(std::env::var("OPENBITFUN_RD_INPUT_RECEIPT").unwrap());
    let pid: i32 = std::env::var("OPENBITFUN_RD_INPUT_PID")
        .unwrap()
        .parse()
        .unwrap();
    let initial = wait(&path, |state| {
        state["active"] == true && state["key_window"] == true
    });
    assert!(fixture_allowed(&initial, &path, pid));
    let id = u32::try_from(initial["display_id"].as_u64().unwrap()).unwrap();
    let mut input = MacInput::open(&display_uuid(id).unwrap()).unwrap();
    let reservation = crate::computer_use::control_session::reserve_external_control().unwrap();
    let started = Instant::now();
    let mut lease = InputAdmission::default();
    let generation = lease.grant(0).unwrap();
    let text = "ABCDEFG\u{1f642}\u{4e2d}\u{6587}e\u{301}\u{1f469}\u{200d}\u{1f4bb}:0123456789012345678901234567890123456789";
    lease
        .push(
            InputMessage::new(generation, InputAction::TextCommit { text: text.into() }),
            true,
            0,
        )
        .unwrap();
    let message = lease.pop(started.elapsed().as_millis() as u64).unwrap();
    let InputAction::TextCommit { text } = message.action() else {
        panic!("Wrong native fixture action")
    };
    let chunks = MacInput::plan_text(text).unwrap();
    let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        for chunk in &chunks {
            crate::computer_use::control_session::with_external_control(reservation, || {
                input.submit_text_chunk(chunk, || {
                    fixture_allowed(&initial, &path, pid)
                        && lease.permits(generation, started.elapsed().as_millis() as u64)
                })
            })
            .unwrap()
            .unwrap();
            // Target/native-adapter pacing; outside the GUI/native guard.
            thread::sleep(Duration::from_millis(8));
        }
        wait(&path, |state| {
            state["text_complete_matches"] == true
                && state["text_downs"].as_u64() == Some(chunks.len() as u64)
                && state["text_ups"] == state["text_downs"]
        });
        // Start a second commit, then cancel after one complete native pair.
        lease
            .push(
                InputMessage::new(generation, InputAction::TextCommit { text: text.into() }),
                true,
                started.elapsed().as_millis() as u64,
            )
            .unwrap();
        let followup = lease.pop(started.elapsed().as_millis() as u64).unwrap();
        crate::computer_use::control_session::with_external_control(reservation, || {
            input.submit_text_chunk(&chunks[0], || {
                fixture_allowed(&initial, &path, pid)
                    && lease.permits(followup.generation(), started.elapsed().as_millis() as u64)
            })
        })
        .unwrap()
        .unwrap();
        wait(&path, |state| state["text_followup_prefix_matches"] == true);
    }));
    let release = lease.release(generation).unwrap();
    let cleanup =
        crate::computer_use::control_session::release_external_control(reservation, || {
            input
                .drain()
                .map_err(|error| format!("Native text cleanup failed: {error:?}"))
        });
    if let Err(failure) = run {
        if let Err(error) = cleanup {
            eprintln!("Native text fixture cleanup failed: {error}");
        }
        std::panic::resume_unwind(failure);
    }
    assert!(cleanup.unwrap());
    assert!(lease.finish_release(release));
    assert!(
        crate::computer_use::control_session::with_external_control(reservation, || panic!(
            "Released text reservation executed a chunk"
        ))
        .is_err()
    );
    let before = read(&path);
    assert_eq!(
        input.submit_text_chunk(&chunks[1], || lease
            .permits(generation, started.elapsed().as_millis() as u64)
            && fixture_allowed(&initial, &path, pid)),
        Err(NativeInputError::InputSuspended)
    );
    thread::sleep(Duration::from_millis(100));
    let after = read(&path);
    assert_eq!(before["text_units"], after["text_units"]);
    assert_eq!(before["text_downs"], after["text_downs"]);
    assert_eq!(after["text_downs"], after["text_ups"]);
    assert!(input.held.text.is_none() && input.held.keys.is_empty());
}
