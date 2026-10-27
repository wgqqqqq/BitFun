use super::*;

fn running(mode: ControlMode) -> Admission<u8> {
    let mut state = Admission::default();
    let generation = state.begin_start("ai", mode).unwrap();
    state.finish_start(generation).unwrap();
    state
}

#[test]
fn external_hold_blocks_every_ai_entry_without_creating_an_ai_owner() {
    let mut state = Admission::<u8>::default();
    let ticket = state.reserve_external().unwrap();
    assert!(state.external_matches(ticket));
    for mode in [
        ControlMode::Background,
        ControlMode::Foreground,
        ControlMode::Observe,
    ] {
        assert!(state
            .begin_start("ai", mode)
            .unwrap_err()
            .contains("CONTROL_BUSY"));
        assert!(state
            .request_share("ai", mode)
            .unwrap_err()
            .contains("CONTROL_BUSY"));
    }
    for action in ["get_app_state", "app_click", "app_type_text", "open_app"] {
        assert!(state
            .admit("ai", action, 1)
            .unwrap_err()
            .contains("CONTROL_BUSY"));
    }
    assert!(state.bind("pid:1/window:2".into()).is_err());
    assert!(state.check(None).is_err());
    assert!(state.snapshot.owner.is_none());
    assert!(state.snapshot.target.is_none());
    assert_eq!(state.snapshot.generation, 0);
    assert_eq!(state.snapshot.sequence, 0);
}

#[test]
fn active_idle_ai_in_every_mode_cannot_be_preempted() {
    for mode in [
        ControlMode::Background,
        ControlMode::Foreground,
        ControlMode::Observe,
    ] {
        let mut state = running(mode);
        state.bind("pid:1/window:2".into()).unwrap();
        let generation = state.snapshot.generation;
        assert!(!state.busy);
        assert!(state.reserve_external().is_err());
        assert!(state.active());
        assert_eq!(state.snapshot.owner.as_deref(), Some("ai"));
        assert_eq!(state.snapshot.target.as_deref(), Some("pid:1/window:2"));
        assert_eq!(state.snapshot.generation, generation);
    }
}

#[test]
fn starting_and_manual_selection_keep_the_resource() {
    let mut state = Admission::<u8>::default();
    let start = state.begin_start("ai", ControlMode::Background).unwrap();
    assert!(state.reserve_external().is_err());
    state.finish_start(start).unwrap();
    state.request_share("ai", ControlMode::Foreground).unwrap();
    assert_eq!(state.snapshot.state, "awaiting_share");
    assert!(!state.busy);
    assert!(state.reserve_external().is_err());
}

#[test]
fn stop_and_native_cleanup_must_finish_before_human_admission() {
    let mut state = running(ControlMode::Background);
    let action = state.admit("ai", "app_click", 1).unwrap();
    assert!(state.reserve_external().is_err());
    let cleanup = state
        .request_stop(Some("ai"), None, "stop")
        .unwrap()
        .unwrap();
    assert!(state.reserve_external().is_err());
    state.finish_cleanup(cleanup.wrapping_sub(1));
    assert!(state.reserve_external().is_err());
    state.finish_cleanup(cleanup);
    let ticket = state.reserve_external().unwrap();
    // Stopped history is retained; it must neither block nor receive this lease.
    assert_eq!(state.snapshot.owner.as_deref(), Some("ai"));
    assert!(state.request_share("ai", ControlMode::Background).is_err());
    assert!(state.check_input(action).is_err());
    assert!(state.release(action, false).is_none());
    assert_eq!(
        state.request_stop(Some("ai"), None, "late stop").unwrap(),
        None
    );
    state.finish_cleanup(cleanup);
    assert!(state.external_matches(ticket));
}

#[test]
fn release_invalidates_input_but_keeps_admission_until_successful_drain() {
    let mut state = Admission::<u8>::default();
    let ticket = state.reserve_external().unwrap();
    assert!(!state.finish_external_release(ticket, true));
    assert!(state.external_matches(ticket));
    assert!(state.begin_external_release(ticket));
    assert!(!state.external_matches(ticket));
    assert!(!state.finish_external_release(ticket, false));
    assert!(state.reserve_external().is_err());
    assert!(state.begin_start("ai", ControlMode::Background).is_err());
    assert!(state.admit("ai", "get_app_state", 1).is_err());
    assert!(state.begin_external_release(ticket));
    assert!(state.finish_external_release(ticket, true));
    let generation = state.begin_start("ai", ControlMode::Background).unwrap();
    state.finish_start(generation).unwrap();
    let input = state.admit("ai", "app_click", 1).unwrap();
    assert!(state.check_input(input).is_ok());
}

#[test]
fn old_release_cannot_invalidate_or_clear_a_successor() {
    let mut state = Admission::<u8>::default();
    let old = state.reserve_external().unwrap();
    assert!(state.begin_external_release(old));
    assert!(state.finish_external_release(old, true));
    let current = state.reserve_external().unwrap();
    assert_ne!(old, current);
    assert!(!state.begin_external_release(old));
    assert!(!state.finish_external_release(old, true));
    assert!(state.external_matches(current));
    state.begin_external_release(current);
    assert!(!state.finish_external_release(old, true));
    assert!(state.reserve_external().is_err());
    assert!(state.finish_external_release(current, true));
}

#[test]
fn unknown_state_and_exhausted_reservation_ids_fail_without_mutation() {
    let mut state = Admission::<u8>::default();
    state.snapshot.state = "future_state".into();
    assert!(state.reserve_external().is_err());
    state.snapshot.state = "idle".into();
    state.external_sequence = u64::MAX;
    assert!(state
        .reserve_external()
        .unwrap_err()
        .contains("CONTROL_FAILED"));
    assert!(state.external.is_none());
    assert!(state.admit("ai", "get_app_state", 1).is_ok());
}

#[test]
fn competing_start_and_reservation_under_the_same_mutex_admit_exactly_one() {
    use std::sync::{Arc, Barrier, Mutex};
    let state = Arc::new(Mutex::new(Admission::<u8>::default()));
    let barrier = Arc::new(Barrier::new(2));
    let ai_state = state.clone();
    let ai_barrier = barrier.clone();
    let ai = std::thread::spawn(move || {
        ai_barrier.wait();
        ai_state
            .lock()
            .unwrap()
            .begin_start("ai", ControlMode::Background)
            .is_ok()
    });
    let human = std::thread::spawn(move || {
        barrier.wait();
        state.lock().unwrap().reserve_external().is_ok()
    });
    assert_ne!(ai.join().unwrap(), human.join().unwrap());
}
