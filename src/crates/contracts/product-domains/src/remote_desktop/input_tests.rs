use super::*;

#[test]
fn source_projection_preserves_negative_origins_and_dpi_without_crossing_edges() {
    let retina = SourceGeometry::new((-1728.0, -100.0), (1728.0, 1117.0), (3456, 2234)).unwrap();
    assert_eq!(retina.project(0.0, 0.0).unwrap(), (-1728.0, -100.0));
    assert_eq!(retina.project(1.0, 1.0).unwrap(), (-0.5, 1016.5));
    assert_eq!(retina.project(0.5, 0.5).unwrap(), (-864.25, 458.25));
    let portrait = SourceGeometry::new((0.0, 0.0), (1080.0, 1920.0), (1080, 1920)).unwrap();
    assert_eq!(portrait.project(1.0, 1.0).unwrap(), (1079.0, 1919.0));
}

#[test]
fn projection_rejects_invalid_geometry_and_coordinates_instead_of_clamping() {
    for (origin, size, pixels) in [
        ((f64::NAN, 0.0), (1.0, 1.0), (2, 2)),
        ((0.0, 0.0), (f64::INFINITY, 1.0), (2, 2)),
        ((0.0, 0.0), (0.0, 1.0), (2, 2)),
        ((0.0, 0.0), (-1.0, 1.0), (2, 2)),
        ((0.0, 0.0), (1.0, 1.0), (1, 2)),
        ((f64::MAX, 0.0), (f64::MAX, 1.0), (2, 2)),
    ] {
        assert!(SourceGeometry::new(origin, size, pixels).is_err());
    }
    let geometry = SourceGeometry::new((0.0, 0.0), (1920.0, 1080.0), (1920, 1080)).unwrap();
    for (x, y) in [
        (f64::NAN, 0.0),
        (0.0, f64::INFINITY),
        (-0.1, 0.0),
        (1.1, 0.0),
    ] {
        assert!(geometry.project(x, y).is_err());
    }
}

fn gen(value: u64) -> ControlGeneration {
    ControlGeneration::new(value).unwrap()
}
fn msg(value: u64, action: InputAction) -> InputMessage {
    InputMessage::new(gen(value), action)
}
fn pointer(x: f64) -> InputAction {
    InputAction::PointerMove { x, y: 0.5 }
}
fn key(down: bool) -> InputAction {
    InputAction::Key { usage: 0xe0, down }
}
fn click(down: bool) -> InputAction {
    InputAction::PointerButton {
        button: PointerButton::Left,
        down,
        x: 0.4,
        y: 0.5,
    }
}
fn wheel(dy: f64) -> InputAction {
    InputAction::Wheel {
        x: 0.4,
        y: 0.5,
        dx: 0.0,
        dy,
    }
}
fn active() -> InputQueue {
    let mut queue = InputQueue::default();
    queue.activate(gen(1)).unwrap();
    queue
}

#[test]
fn adjacent_merge_never_relabels_generations_or_hides_invalid_input() {
    let first = msg(1, pointer(0.2));
    assert_eq!(
        first.coalesced_with(&msg(1, pointer(0.8))),
        Some(msg(1, pointer(0.8)))
    );
    assert!(first.coalesced_with(&msg(2, pointer(0.8))).is_none());
    let invalid = msg(1, pointer(f64::NAN));
    assert!(invalid.coalesced_with(&first).is_none());
    assert!(first.coalesced_with(&invalid).is_none());
    assert!(msg(1, wheel(MAX_WHEEL_DELTA))
        .coalesced_with(&msg(1, wheel(1.0)))
        .is_none());
}

#[test]
fn minimal_wire_round_trip_and_tolerant_optional_fields() {
    let bytes = br#"{"control_generation":"8","kind":"pointer_button","body":{"button":"left","down":true,"x":0.4,"y":0.5}}"#;
    let message = InputMessage::parse(bytes, false).unwrap();
    assert_eq!(message, msg(8, click(true)));
    assert_eq!(
        serde_json::to_value(&message).unwrap(),
        serde_json::from_slice::<serde_json::Value>(bytes).unwrap()
    );
    let extra = br#"{"control_generation":"8","kind":"pointer_button","future":true,"body":{"button":"left","down":true,"x":0.4,"y":0.5,"future":1}}"#;
    assert_eq!(InputMessage::parse(extra, false).unwrap(), message);
    for bytes in [
        br#"{"kind":"pointer_move","body":{"x":0,"y":0}}"#.as_slice(),
        br#"{"control_generation":"8","kind":"script","body":{"text":"untrusted"}}"#,
        br#"{"control_generation":"8","kind":"key","body":{"usage":65536,"down":true}}"#,
    ] {
        assert_eq!(
            InputMessage::parse(bytes, true),
            Err(InputError::InvalidInput)
        );
    }
}

#[test]
fn generation_is_nonzero_canonical_decimal_and_preserves_large_u64() {
    for value in [1, 8, u64::MAX] {
        let encoded = serde_json::to_string(&gen(value)).unwrap();
        assert_eq!(encoded, format!("\"{value}\""));
        assert_eq!(
            serde_json::from_str::<ControlGeneration>(&encoded).unwrap(),
            gen(value)
        );
    }
    for value in [
        "0",
        "1",
        "\"0\"",
        "\"01\"",
        "\"+1\"",
        "\" 1\"",
        "\"18446744073709551616\"",
        "null",
    ] {
        assert!(
            serde_json::from_str::<ControlGeneration>(value).is_err(),
            "{value}"
        );
    }
    assert!(ControlGeneration::new(0).is_err());
}

#[test]
fn invalid_numeric_coordinates_and_scroll_never_enter_the_queue() {
    let mut queue = active();
    for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -0.01, 1.01] {
        assert_eq!(
            queue.push(msg(1, pointer(value)), false),
            Err(InputError::InvalidInput)
        );
    }
    for action in [
        wheel(f64::INFINITY),
        wheel(MAX_WHEEL_DELTA + 1.0),
        wheel(0.0),
        InputAction::Key {
            usage: 0,
            down: true,
        },
        InputAction::Key {
            usage: 3,
            down: true,
        },
    ] {
        assert_eq!(
            queue.push(msg(1, action), false),
            Err(InputError::InvalidInput)
        );
    }
    assert!(queue.is_empty());
    assert!(queue.active());
    queue
        .push(msg(1, InputAction::PointerMove { x: 0.0, y: 1.0 }), false)
        .unwrap();
}

#[test]
fn text_is_negotiated_utf8_bounded_and_never_logged() {
    let text = "汉🙂".repeat(MAX_TEXT_BYTES / 7);
    let message = msg(1, InputAction::TextCommit { text: text.clone() });
    let bytes = serde_json::to_vec(&message).unwrap();
    assert_eq!(
        InputMessage::parse(&bytes, false),
        Err(InputError::TextUnsupported)
    );
    assert_eq!(InputMessage::parse(&bytes, true).unwrap(), message);
    for text in [
        "".to_string(),
        "bad\0text".into(),
        "🙂".repeat(MAX_TEXT_BYTES / 4 + 1),
    ] {
        assert!(msg(1, InputAction::TextCommit { text })
            .action
            .validate(true)
            .is_err());
    }
    let secret = msg(
        1,
        InputAction::TextCommit {
            text: "password-secret".into(),
        },
    );
    assert!(!format!("{secret:?}").contains("password-secret"));
    assert!(!format!("{:?}", secret.action()).contains("password-secret"));
    let large = vec![b' '; MAX_INPUT_BYTES + 1];
    assert_eq!(
        InputMessage::parse(&large, true),
        Err(InputError::InvalidInput)
    );
}

#[test]
fn moves_merge_only_adjacent_moves_not_button_key_text_or_wheel_boundaries() {
    let mut queue = active();
    queue.push(msg(1, pointer(0.1)), false).unwrap();
    queue.push(msg(1, pointer(0.2)), false).unwrap();
    let barriers = [
        click(true),
        key(true),
        wheel(2.0),
        InputAction::TextCommit { text: "hi".into() },
    ];
    for barrier in barriers.iter().cloned() {
        queue.push(msg(1, barrier), true).unwrap();
        queue.push(msg(1, pointer(0.3)), false).unwrap();
        queue.push(msg(1, pointer(0.4)), false).unwrap();
    }
    assert_eq!(queue.len(), 9);
    assert_eq!(queue.pop().unwrap().action(), &pointer(0.2));
    for barrier in barriers {
        assert_eq!(queue.pop().unwrap().action(), &barrier);
        assert_eq!(queue.pop().unwrap().action(), &pointer(0.4));
    }
    assert_eq!(queue.queued_bytes(), 0);
}

#[test]
fn identical_clicks_and_key_repeats_are_not_deduplicated() {
    let mut queue = active();
    for action in [
        click(true),
        click(false),
        click(true),
        click(false),
        key(true),
        key(true),
        key(false),
    ] {
        queue.push(msg(1, action), false).unwrap();
    }
    assert_eq!(queue.len(), 7);
    let release = queue.pending.get(3).unwrap().message.action();
    assert!(matches!(
        release,
        InputAction::PointerButton {
            down: false,
            x: 0.4,
            y: 0.5,
            ..
        }
    ));
}

#[test]
fn wheel_merge_respects_modifiers_anchor_direction_and_sum_bounds() {
    let mut queue = active();
    queue.push(msg(1, wheel(2.0)), false).unwrap();
    queue.push(msg(1, wheel(3.0)), false).unwrap();
    assert_eq!(queue.len(), 1);
    assert_eq!(queue.pop().unwrap().action(), &wheel(5.0));
    for action in [
        wheel(2.0),
        key(true),
        wheel(3.0),
        wheel(-1.0),
        InputAction::Wheel {
            x: 0.5,
            y: 0.5,
            dx: 0.0,
            dy: -1.0,
        },
        wheel(MAX_WHEEL_DELTA),
        wheel(MAX_WHEEL_DELTA),
    ] {
        queue.push(msg(1, action), false).unwrap();
    }
    assert_eq!(queue.len(), 7);
}

#[test]
fn revoked_and_old_grants_cannot_relabel_intents_or_clear_new_work() {
    let mut queue = active();
    let old_intent = msg(1, click(true));
    queue.push(msg(1, pointer(0.1)), false).unwrap();
    queue.activate(gen(1)).unwrap();
    assert_eq!(
        queue.len(),
        1,
        "duplicate grant notification must retain pending work"
    );
    queue.suspend();
    assert_eq!(queue.activate(gen(1)), Err(InputError::StaleGeneration));
    queue.activate(gen(2)).unwrap();
    queue.push(msg(2, key(true)), false).unwrap();
    assert_eq!(
        queue.push(old_intent, false),
        Err(InputError::StaleGeneration)
    );
    assert_eq!(queue.activate(gen(1)), Err(InputError::StaleGeneration));
    assert_eq!(queue.len(), 1);
    assert_eq!(queue.pop().unwrap().generation(), gen(2));
}

#[test]
fn event_budget_overflow_disarms_clears_and_requires_a_new_generation() {
    let mut queue = active();
    for _ in 0..MAX_PENDING_INPUTS {
        queue.push(msg(1, key(true)), false).unwrap();
    }
    assert_eq!(
        queue.push(msg(1, key(false)), false),
        Err(InputError::Backpressure)
    );
    assert!(!queue.active());
    assert!(queue.is_empty());
    assert_eq!(queue.queued_bytes(), 0);
    assert_eq!(
        queue.push(msg(1, key(false)), false),
        Err(InputError::Suspended)
    );
    assert_eq!(queue.activate(gen(1)), Err(InputError::StaleGeneration));
    queue.activate(gen(2)).unwrap();
    assert!(queue.pop().is_none());
}

#[test]
fn byte_budget_overflow_and_credit_after_dequeue_are_exact() {
    let text = InputAction::TextCommit {
        text: "界".repeat(MAX_TEXT_BYTES / 3),
    };
    let message = msg(1, text);
    let size = serde_json::to_vec(&message).unwrap().len();
    let mut queue = active();
    let capacity = MAX_PENDING_INPUT_BYTES / size;
    for _ in 0..capacity {
        queue.push(message.clone(), true).unwrap();
    }
    assert_eq!(queue.queued_bytes(), capacity * size);
    queue.pop();
    assert_eq!(queue.queued_bytes(), (capacity - 1) * size);
    queue.push(message.clone(), true).unwrap();
    assert_eq!(queue.push(message, true), Err(InputError::Backpressure));
    assert_eq!(queue.queued_bytes(), 0);
    assert!(!queue.active());
}

#[test]
fn replaced_move_updates_byte_accounting_not_event_count() {
    let mut queue = active();
    queue.push(msg(1, pointer(0.1)), false).unwrap();
    let replacement = msg(1, pointer(0.12345678912345678));
    let size = serde_json::to_vec(&replacement).unwrap().len();
    queue.push(replacement.clone(), false).unwrap();
    assert_eq!(queue.len(), 1);
    assert_eq!(queue.queued_bytes(), size);
    assert_eq!(queue.pop().unwrap(), replacement);
    assert_eq!(queue.queued_bytes(), 0);
}

#[test]
fn pointer_up_keeps_its_final_coordinates_after_queued_moves() {
    let mut queue = active();
    let up = InputAction::PointerButton {
        button: PointerButton::Left,
        down: false,
        x: 1.0,
        y: 0.0,
    };
    for action in [click(true), pointer(0.6), pointer(0.8), up.clone()] {
        queue.push(msg(1, action), false).unwrap();
    }
    assert_eq!(queue.pop().unwrap().action(), &click(true));
    assert_eq!(queue.pop().unwrap().action(), &pointer(0.8));
    assert_eq!(queue.pop().unwrap().action(), &up);
    assert!(queue.is_empty());
}
