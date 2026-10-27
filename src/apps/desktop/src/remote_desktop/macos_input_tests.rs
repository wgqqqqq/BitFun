use super::*;
use core_graphics::event::EventField;

// Builds real Quartz events, but neither posts input nor probes/requests TCC.
fn provider() -> MacInput {
    MacInput {
        display: BoundDisplay {
            id: 0,
            uuid: "unbound-test-source".into(),
            geometry: SourceGeometry::new((-1000.0, 0.0), (1000.0, 800.0), (2000, 1600)).unwrap(),
            rotation: 0.0,
        },
        source: CGEventSource::new(CGEventSourceStateID::Private).unwrap(),
        held: Held::default(),
        double_click_interval: Duration::from_millis(500),
        _worker: PhantomData,
    }
}

#[test]
fn physical_keys_use_native_codes_and_explicitly_refuse_unmapped_usages() {
    assert_eq!(keycode(0x04), Some(0)); // A, not the HID numeric value
    assert_eq!(keycode(0x1d), Some(6)); // Z
    assert_eq!(keycode(0x58), Some(76)); // keypad Enter != Return
    assert_eq!(keycode(0x28), Some(36));
    for usage in [0, 1, 2, 3, 0x39, 0x46, 0x53, 0x66, 0xff, 0xffff] {
        assert_eq!(keycode(usage), None);
    }
    let input = provider();
    assert!(matches!(
        input.prepare(&InputAction::Key {
            usage: 0xffff,
            down: true
        }),
        Err(NativeInputError::UnsupportedInput)
    ));
    assert!(matches!(
        input.prepare(&InputAction::TextCommit {
            text: "private".into()
        }),
        Err(NativeInputError::UnsupportedInput)
    ));
    assert!(input.held.keys.is_empty());
}

#[test]
fn native_key_repeats_and_both_modifier_sides_keep_independent_state() {
    let mut input = provider();
    for usage in [0xe1, 0xe5, 0x04, 0x04] {
        let (event, next) = input
            .prepare(&InputAction::Key { usage, down: true })
            .unwrap();
        assert!(event.get_flags().contains(CGEventFlags::CGEventFlagShift));
        if usage == 0x04 {
            assert_eq!(
                event.get_integer_value_field(EventField::KEYBOARD_EVENT_AUTOREPEAT),
                i64::from(input.held.keys.contains(&usage))
            );
            assert_eq!(
                event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE),
                0
            );
        }
        input.held = next;
    }
    let (event, next) = input
        .prepare(&InputAction::Key {
            usage: 0xe1,
            down: false,
        })
        .unwrap();
    assert!(event.get_flags().contains(CGEventFlags::CGEventFlagShift));
    input.held = next;
    let (event, next) = input
        .prepare(&InputAction::Key {
            usage: 0xe5,
            down: false,
        })
        .unwrap();
    assert!(!event.get_flags().contains(CGEventFlags::CGEventFlagShift));
    input.held = next;
    assert!(matches!(
        input.prepare(&InputAction::Key {
            usage: 0xe5,
            down: false
        }),
        Err(NativeInputError::InvalidInput)
    ));
}

#[test]
fn text_rejects_held_keys_buttons_and_pending_cleanup_before_native_checks() {
    let mut input = provider();
    let chunks = MacInput::plan_text("fixed text").unwrap();
    input.held.keys.insert(0xe1);
    assert_eq!(
        input.submit_text_chunk(&chunks[0], || panic!("Held modifier reached native permit")),
        Err(NativeInputError::InvalidInput)
    );
    assert!(input.held.keys.contains(&0xe1));
    input.held.keys.clear();
    input.held.buttons[0] = true;
    assert_eq!(
        input.submit_text_chunk(&chunks[0], || panic!("Held button reached native permit")),
        Err(NativeInputError::InvalidInput)
    );
    input.held.buttons[0] = false;
    input.held.text = Some(vec![65]);
    assert_eq!(
        input.submit_text_chunk(&chunks[0], || panic!(
            "Pending release reached native permit"
        )),
        Err(NativeInputError::InputSuspended)
    );
    assert!(matches!(
        input.prepare(&InputAction::PointerMove { x: 0.5, y: 0.5 }),
        Err(NativeInputError::InputSuspended)
    ));
}

#[test]
fn dragging_and_button_up_use_their_requested_final_source_point() {
    let mut input = provider();
    let (_, held) = input
        .prepare(&InputAction::PointerButton {
            button: PointerButton::Middle,
            down: true,
            x: 0.0,
            y: 0.0,
        })
        .unwrap();
    input.held = held;
    let (drag, _) = input
        .prepare(&InputAction::PointerMove { x: 1.0, y: 1.0 })
        .unwrap();
    assert_eq!(
        drag.get_type() as u32,
        CGEventType::OtherMouseDragged as u32
    );
    assert_eq!((drag.location().x, drag.location().y), (-0.5, 799.5));
    let (up, next) = input
        .prepare(&InputAction::PointerButton {
            button: PointerButton::Middle,
            down: false,
            x: 0.5,
            y: 0.25,
        })
        .unwrap();
    assert_eq!(up.get_type() as u32, CGEventType::OtherMouseUp as u32);
    assert_eq!((up.location().x, up.location().y), (-500.25, 199.875));
    assert!(!next.buttons[2]);
    assert!(input.held.buttons[2]); // preparation never changes live state
}

#[test]
fn fractional_scroll_survives_until_a_pixel_is_available_and_reversal_cancels() {
    let mut input = provider();
    for _ in 0..2 {
        let (event, next) = input
            .prepare(&InputAction::Wheel {
                x: 0.5,
                y: 0.5,
                dx: 0.25,
                dy: 0.5,
            })
            .unwrap();
        assert_eq!(event.get_type() as u32, CGEventType::ScrollWheel as u32);
        input.held = next;
    }
    assert_eq!(input.held.wheel, (0.5, 0.0));
    let (_, next) = input
        .prepare(&InputAction::Wheel {
            x: 0.5,
            y: 0.5,
            dx: -0.5,
            dy: 0.0,
        })
        .unwrap();
    assert_eq!(next.wheel, (0.0, 0.0));
}

#[test]
fn failed_cleanup_retains_unreleased_state_and_retry_never_reposts_completed_releases() {
    let mut held = Held {
        keys: [0x04, 0xe1, 0xe5].into_iter().collect(),
        buttons: [true, false, true],
        wheel: (0.5, 0.5),
        ..Held::default()
    };
    let mut completed = Vec::new();
    let failure = held.drain_with(|release, _, _| {
        if release == Release::Key(0x04) {
            return Err(NativeInputError::PermissionRequired);
        }
        completed.push(release);
        Ok(())
    });
    assert_eq!(failure, Err(NativeInputError::PermissionRequired));
    assert!(held.keys.contains(&0x04));
    assert_eq!(held.buttons, [false; 3]);
    assert_eq!(held.wheel, (0.0, 0.0));
    assert!(
        completed
            == vec![
                Release::Button(PointerButton::Left),
                Release::Button(PointerButton::Middle)
            ]
    );
    completed.clear();
    held.drain_with(|release, flags, _| {
        completed.push(release);
        if release == Release::Key(0xe1) {
            assert!(flags.contains(CGEventFlags::CGEventFlagShift));
        }
        if release == Release::Key(0xe5) {
            assert!(!flags.contains(CGEventFlags::CGEventFlagShift));
        }
        Ok(())
    })
    .unwrap();
    assert!(completed == vec![Release::Key(0x04), Release::Key(0xe1), Release::Key(0xe5)]);
    assert!(held.keys.is_empty());
    held.drain_with(|_, _, _| panic!("completed state must not inject release again"))
        .unwrap();
}

#[test]
fn complete_click_pairs_keep_native_counts_and_reset_on_target_or_modifier_change() {
    let mut input = provider();
    let first = Instant::now();
    for (offset, x, button, count) in [
        (0, 0.5, PointerButton::Left, 1),
        (100, 0.5, PointerButton::Left, 2),
        (700, 0.5, PointerButton::Left, 1),
        (800, 0.6, PointerButton::Left, 1),
        (900, 0.6, PointerButton::Right, 1),
    ] {
        for down in [true, false] {
            let (event, next) = input
                .prepare_at(
                    &InputAction::PointerButton {
                        button,
                        down,
                        x,
                        y: 0.5,
                    },
                    first + Duration::from_millis(offset),
                )
                .unwrap();
            assert_eq!(
                event.get_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE),
                count
            );
            input.held = next;
        }
    }
    input.held.keys.insert(0xe1);
    let (event, _) = input
        .prepare_at(
            &InputAction::PointerButton {
                button: PointerButton::Right,
                down: true,
                x: 0.6,
                y: 0.5,
            },
            first + Duration::from_millis(1000),
        )
        .unwrap();
    assert_eq!(
        event.get_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE),
        1
    );
}
