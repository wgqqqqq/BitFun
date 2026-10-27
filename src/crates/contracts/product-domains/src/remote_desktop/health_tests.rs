use super::*;
fn report(echo: u64, frames: u64) -> ReceiverHealth {
    ReceiverHealth {
        version: 1,
        kind: "health_reply".into(),
        echo,
        first_frame: true,
        visible: true,
        focused: true,
        receiving: true,
        decoded: frames,
        presented: frames,
    }
}
fn round(h: &mut MediaHealth, now: u64, frames: u64) {
    let p = h.probe(now).unwrap();
    assert!(h.receive(report(p.echo, frames), now + 1));
}

fn confirmed_idle() -> MediaHealth {
    let mut h = MediaHealth::default();
    h.source_frame(1, 0);
    round(&mut h, 0, 1);
    for now in [2000, 4000, 6000, 8000] {
        h.source_idle(now);
        round(&mut h, now, 1);
        assert!(h.candidate(now + 1, true));
    }
    h
}

#[test]
fn resumed_idle_source_has_time_to_present_its_first_changed_frame() {
    let mut h = confirmed_idle();
    h.source_frame(2, 10000);
    assert!(
        h.candidate(10000, true),
        "Normal transport delay after idle must not revoke control immediately"
    );
    round(&mut h, 10000, 2);
    assert!(h.candidate(10001, true));
    h.source_idle(18000);
    round(&mut h, 18000, 2);
    h.source_frame(3, 20000);
    assert!(
        h.candidate(20000, true),
        "A later confirmed idle period has its own first changed frame"
    );
}

#[test]
fn resuming_idle_does_not_extend_a_missing_health_roundtrip() {
    let mut h = confirmed_idle();
    h.source_frame(2, 10000);
    h.probe(10000).unwrap();
    h.source_idle(12000);
    assert!(h.candidate(12999, true));
    assert!(!h.candidate(13000, true));
}

#[test]
fn more_samples_and_idle_reports_cannot_extend_the_resume_budget() {
    let mut h = confirmed_idle();
    for (frames, now) in [(2, 10000), (3, 12000), (4, 14000)] {
        h.source_frame(frames, now);
        h.source_idle(now);
        round(&mut h, now, 1);
        assert!(h.candidate(now + 1, true));
    }
    assert!(h.candidate(15999, true));
    assert!(!h.candidate(16000, true));
    h.source_frame(5, 16000);
    h.source_idle(16000);
    round(&mut h, 16000, 1);
    assert!(!h.candidate(16001, true));
    let p = h.probe(18000).unwrap();
    let mut only_decoded = report(p.echo, 2);
    only_decoded.presented = 1;
    h.source_idle(18000);
    assert!(h.receive(only_decoded, 18001));
    assert!(
        !h.candidate(18001, true),
        "Decoded frames cannot replace presentation progress"
    );
    round(&mut h, 20000, 3);
    h.source_idle(20000);
    assert!(h.candidate(20001, true));
}

#[test]
fn resume_budget_cannot_hide_negative_health_or_native_source_loss() {
    for field in [
        "first_frame",
        "visible",
        "focused",
        "receiving",
        "counter_reset",
        "source_lost",
    ] {
        let mut h = confirmed_idle();
        h.source_frame(2, 10000);
        assert!(h.candidate(10000, true));
        assert!(!h.candidate(10000, false));
        let p = h.probe(10000).unwrap();
        let mut r = report(p.echo, 1);
        match field {
            "first_frame" => r.first_frame = false,
            "visible" => r.visible = false,
            "focused" => r.focused = false,
            "receiving" => r.receiving = false,
            "counter_reset" => r.decoded = 0,
            "source_lost" => h.source_unavailable(),
            _ => unreachable!(),
        }
        assert!(h.receive(r, 10001));
        assert!(
            !h.candidate(10001, true),
            "Negative {field} must apply immediately"
        );
    }
}

#[test]
fn unavailable_or_unconfirmed_idle_cannot_start_a_resume_budget() {
    let mut lost = confirmed_idle();
    lost.source_unavailable();
    lost.source_frame(2, 10000);
    lost.source_idle(10000);
    round(&mut lost, 10000, 1);
    assert!(!lost.candidate(10001, true));
    let mut unseen = confirmed_idle();
    unseen.source_frame(2, 9000);
    unseen.source_unavailable();
    unseen.source_idle(10000);
    round(&mut unseen, 10000, 1);
    unseen.source_frame(3, 11000);
    assert!(!unseen.candidate(11001, true));
}

#[test]
fn idle_after_explicit_source_loss_cannot_reuse_the_old_static_picture() {
    let mut h = confirmed_idle();
    h.source_unavailable();
    h.source_idle(10000);
    round(&mut h, 10000, 1);
    assert!(!h.candidate(10001, true));
    assert_eq!(h.source_activity(10001), SourceActivity::Unknown);

    // Receiver progress alone cannot repair an unobservable capture source.
    h.source_idle(12000);
    round(&mut h, 12000, 2);
    assert!(!h.candidate(12001, true));

    h.source_frame(2, 14000);
    h.source_idle(14000);
    round(&mut h, 14000, 3);
    assert!(h.candidate(14001, true));
}

#[test]
fn fresh_idle_can_restore_an_observation_gap_without_explicit_source_loss() {
    let mut h = confirmed_idle();
    assert_eq!(h.source_activity(20000), SourceActivity::Unknown);
    assert!(!h.candidate(20000, true));
    h.source_idle(20000);
    round(&mut h, 20000, 1);
    assert!(h.candidate(20001, true));
}

#[test]
fn queued_duplicate_expired_and_unsolicited_reports_never_refresh_health() {
    let mut h = MediaHealth::default();
    h.source_frame(1, 0);
    assert!(!h.receive(report(0, 1), 0));
    let p = h.probe(0).unwrap();
    assert!(h.probe(1).is_none());
    assert!(!h.receive(report(p.echo, 1), 3000));
    let next = h.probe(3000).unwrap();
    assert!(!h.receive(report(p.echo, 1), 3001));
    assert!(h.receive(report(next.echo, 1), 3001));
    assert!(!h.receive(report(next.echo, 2), 3002));
    assert!(h.candidate(3002, true));
    h.probe(5000).unwrap();
    assert!(!h.candidate(8000, true));
    h.source_idle(8000);
    h.probe(8000).unwrap();
    assert!(!h.candidate(8001, true));
}

#[test]
fn decoder_progress_cannot_substitute_for_presentation_or_native_progress() {
    let mut h = MediaHealth::default();
    h.source_frame(1, 0);
    round(&mut h, 0, 1);
    assert!(h.candidate(1, true));
    h.source_frame(2, 6000);
    let p = h.probe(6000).unwrap();
    let mut r = report(p.echo, 2);
    r.presented = 1;
    assert!(h.receive(r, 6001));
    assert!(!h.candidate(6001, true));
    round(&mut h, 8000, 3);
    assert!(h.candidate(8001, true));
    round(&mut h, 12000, 4);
    assert!(!h.candidate(12001, true));
}

#[test]
fn native_idle_preserves_static_observation_and_resumed_progress_is_bounded() {
    let mut h = MediaHealth::default();
    h.source_idle(0);
    round(&mut h, 0, 1);
    assert!(!h.candidate(1, true));
    h.source_frame(1, 1);
    round(&mut h, 2000, 2);
    h.source_idle(6000);
    round(&mut h, 6000, 2);
    assert!(h.candidate(6001, true));
    h.source_frame(2, 8000);
    h.source_idle(8000);
    round(&mut h, 8000, 2);
    assert!(h.candidate(8001, true));
    round(&mut h, 10000, 3);
    h.source_idle(10001);
    assert!(h.candidate(10001, true));
    assert!(!h.candidate(16001, true));
}

#[test]
fn negative_visibility_and_transport_pause_immediately_and_counter_reset_needs_new_pc() {
    let mut h = MediaHealth::default();
    h.source_frame(1, 0);
    round(&mut h, 0, 10);
    assert!(!h.candidate(1, false));
    let p = h.probe(2000).unwrap();
    let mut r = report(p.echo, 10);
    r.focused = false;
    assert!(h.receive(r, 2001));
    assert!(!h.candidate(2001, true));
    round(&mut h, 4000, 1);
    h.source_idle(4001);
    assert!(!h.candidate(4001, true));
    round(&mut h, 6000, 20);
    h.source_idle(6001);
    assert!(!h.candidate(6001, true));
    h.source_unavailable();
    assert!(!h.candidate(6002, true));
}

#[test]
fn wire_counters_use_canonical_strings_and_tolerate_optional_future_observations() {
    let mut value = serde_json::to_value(report(0, u64::MAX)).unwrap();
    value["optional_future"] = true.into();
    assert_eq!(
        serde_json::from_value::<ReceiverHealth>(value.clone())
            .unwrap()
            .decoded,
        u64::MAX
    );
    for bad in [
        serde_json::json!(1),
        serde_json::json!("01"),
        serde_json::json!("+1"),
        serde_json::json!("18446744073709551616"),
    ] {
        value["decoded"] = bad;
        assert!(serde_json::from_value::<ReceiverHealth>(value.clone()).is_err());
    }
}
