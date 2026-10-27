//! One blocking input worker per PC. No native seat crosses worker threads.
//! Lock order at submission: GUI/native facade -> host -> input admission.
use super::{media_session::Slot, native_input::NativeInput as MacInput};
use crate::computer_use::control_session::{self as gui, ExternalReservationToken};
use openbitfun_product_domains::remote_desktop::{
    control::{ControlAction, ControlMessage, ControlRequest},
    input::{ControlGeneration, InputAction, MAX_PENDING_INPUTS, MAX_PENDING_INPUT_BYTES},
    input_admission::InputAdmission,
};
use serde_json::{json, Value};
// Selecting the native media feature exposes control; local grants, OS
// permissions, a healthy bound PC and the GUI reservation remain mandatory.
pub(super) const CONTROL_AVAILABLE: bool = true;
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    time::Duration,
};

#[derive(Default)]
pub(super) struct Shared {
    state: Mutex<State>,
    inbox: Mutex<Inbox>,
    closed: AtomicBool,
    overflow: AtomicBool,
    wake: Condvar,
}
#[derive(Default)]
struct State {
    admission: InputAdmission,
    generation: Option<ControlGeneration>,
    quarantined: bool,
}
#[derive(Default)]
struct Inbox {
    queue: VecDeque<(ControlMessage, usize, u64)>,
    bytes: usize,
}
impl Inbox {
    fn push(&mut self, message: ControlMessage, bytes: usize, received_ms: u64) -> bool {
        // Native IO may block the worker after dequeue. Coalesce where the
        // backlog actually lives, without taking its admission/native guard.
        let merged = self
            .queue
            .back()
            .and_then(|(tail, _, _)| match (tail, &message) {
                (ControlMessage::Input(previous), ControlMessage::Input(next)) => {
                    previous.coalesced_with(next)
                }
                _ => None,
            });
        let coalesced = merged.is_some();
        let replaced_bytes = if coalesced {
            self.queue.back().map_or(0, |(_, bytes, _)| *bytes)
        } else {
            0
        };
        let (message, bytes) = if let Some(merged) = merged {
            let Ok(encoded) = serde_json::to_vec(&merged) else {
                return false;
            };
            (ControlMessage::Input(merged), encoded.len())
        } else {
            (message, bytes)
        };
        let next_bytes = self.bytes - replaced_bytes + bytes;
        if (!coalesced && self.queue.len() >= MAX_PENDING_INPUTS)
            || next_bytes > MAX_PENDING_INPUT_BYTES
        {
            return false;
        }
        if coalesced {
            self.queue.pop_back();
        }
        self.queue.push_back((message, bytes, received_ms));
        self.bytes = next_bytes;
        true
    }
}
impl State {
    fn revoke(&mut self) {
        if let Some(generation) = self.generation {
            let _ = self.admission.release(generation);
        }
    }
    fn renew(
        &mut self,
        generation: ControlGeneration,
        received_ms: u64,
        now_ms: u64,
    ) -> Result<ControlGeneration, &'static str> {
        // Queueing and host-lock waits consume the received renewal budget.
        // Checking current time first prevents an old receipt reviving expiry.
        self.admission.expire(now_ms);
        self.admission
            .renew(generation, received_ms)
            .map_err(|_| "stale_control")?;
        self.admission.expire(now_ms);
        if self.admission.permits(generation, now_ms) {
            Ok(generation)
        } else {
            Err("stale_control")
        }
    }
}
impl Shared {
    /// Callback stays bounded and never waits for native IO or worker completion.
    pub(super) fn receive(&self, bytes: &[u8], received_ms: u64) {
        let Ok(message) = ControlMessage::parse(bytes) else {
            return;
        };
        let mut inbox = self.inbox.lock().unwrap();
        if self.closed.load(Ordering::Acquire) || self.overflow.load(Ordering::Acquire) {
            return;
        }
        if !inbox.push(message, bytes.len(), received_ms) {
            inbox.queue.clear();
            inbox.bytes = 0;
            self.overflow.store(true, Ordering::Release);
        }
        self.wake.notify_one();
    }
    /// Caller holds no GUI lock. Never waits for native drainage here.
    pub(super) fn invalidate(&self, close: bool) {
        if close {
            self.closed.store(true, Ordering::Release);
        }
        self.state.lock().unwrap().revoke();
        let mut inbox = self.inbox.lock().unwrap();
        inbox.queue.clear();
        inbox.bytes = 0;
        self.wake.notify_one();
    }
}

pub(super) fn run(
    slot: Arc<Slot>,
    health: impl Fn() -> bool,
    send: impl Fn(Value) -> bool,
) -> bool {
    let shared = slot.control.clone();
    let mut native: Option<(MacInput, ExternalReservationToken)> = None;
    let mut revoking = None;
    loop {
        // Fresh health/authority loss revokes without requiring another DC message.
        let has_control = shared.state.lock().unwrap().generation.is_some();
        if (has_control && !slot.control_allowed(&health))
            || shared.overflow.load(Ordering::Acquire)
        {
            shared.invalidate(false);
        }
        let closed = shared.closed.load(Ordering::Acquire);
        let pending = {
            let mut state = shared.state.lock().unwrap();
            state.admission.expire(slot.elapsed_ms());
            state.admission.pending_release()
        };
        if pending.is_some() || (closed && native.is_some()) {
            let newly_revoking = pending.is_some() && revoking != pending;
            if newly_revoking {
                log::debug!("Remote desktop input cleanup started");
                slot.control_revision_changed();
                revoking = pending;
            }
            if let Some((input, ticket)) = native.as_mut() {
                let result = gui::release_external_control(*ticket, || {
                    input
                        .drain()
                        .map_err(|_| "Remote input cleanup failed".into())
                });
                if !matches!(result, Ok(true)) {
                    if newly_revoking {
                        log::debug!("Remote desktop input cleanup not confirmed");
                    }
                    // Keep native ledger/ticket and the app-wide slot occupied.
                    // A later iteration may retry OS release, never ordinary input.
                    std::thread::sleep(Duration::from_millis(250));
                    continue;
                }
            }
            native = None;
            let mut state = shared.state.lock().unwrap();
            if let Some(revocation) = pending {
                state.admission.finish_release(revocation);
            }
            state.generation = None;
            drop(state);
            if let Some(revocation) = pending {
                let queued = send(
                    json!({"version":1,"kind":"control_revoked","control_generation":revocation.released_generation(),"state_revision":slot.control_revision()}),
                );
                log::debug!("Remote desktop input cleanup finished revocation_queued={queued}");
            }
        }
        if shared.overflow.swap(false, Ordering::AcqRel) {
            let _ = send(json!({"version":1,"kind":"control_error","code":"input_backpressure"}));
        }
        if closed {
            return !shared.state.lock().unwrap().quarantined;
        }
        let message = {
            let mut inbox = shared.inbox.lock().unwrap();
            if inbox.queue.is_empty() {
                inbox = shared
                    .wake
                    .wait_timeout(inbox, Duration::from_millis(100))
                    .unwrap()
                    .0;
            }
            inbox
                .queue
                .pop_front()
                .map(|(message, bytes, received_ms)| {
                    inbox.bytes -= bytes;
                    (message, received_ms)
                })
        };
        let Some((message, received_ms)) = message else {
            continue;
        };
        match message {
            ControlMessage::Request(request) => {
                let action = match &request.action {
                    ControlAction::AcquireControl { .. } => "acquire_control",
                    ControlAction::RenewControl { .. } => "renew_control",
                    ControlAction::ReleaseControl { .. } => "release_control",
                };
                if action == "release_control" {
                    log::debug!("Remote desktop control request received action=release_control");
                }
                let result = match &request.action {
                    ControlAction::AcquireControl {
                        expected_state_revision,
                    } => acquire(&slot, &health, expected_state_revision, &mut native),
                    ControlAction::RenewControl { control_generation } => slot
                        .with_control_authority(&health, |_, state_owner| {
                            let mut state = state_owner.state.lock().unwrap();
                            state.renew(*control_generation, received_ms, slot.elapsed_ms())
                        }),
                    ControlAction::ReleaseControl { control_generation } => {
                        let mut state = shared.state.lock().unwrap();
                        state
                            .admission
                            .release(*control_generation)
                            .map(|_| *control_generation)
                            .map_err(|_| "stale_control")
                    }
                };
                if result.is_err() && !slot.control_allowed(&health) {
                    shared.invalidate(false);
                }
                let code = result.as_ref().err().copied().unwrap_or("ok");
                let queued = respond(&slot, &send, request, result);
                if action == "release_control" || code != "ok" || !queued {
                    log::debug!(
                        "Remote desktop control result action={action} code={code} queued={queued}"
                    );
                }
                if !queued {
                    shared.invalidate(true);
                }
            }
            ControlMessage::Input(message) => {
                let generation = message.generation();
                let message = {
                    let mut state = shared.state.lock().unwrap();
                    if state
                        .admission
                        .push(message, true, slot.elapsed_ms())
                        .is_err()
                    {
                        continue;
                    }
                    state.admission.pop(slot.elapsed_ms())
                };
                let Some(message) = message else { continue };
                let Some((input, ticket)) = native.as_mut() else {
                    shared.invalidate(false);
                    continue;
                };
                let mut submit = |chunk: Option<&super::native_input::TextChunk>| {
                    gui::with_external_control(*ticket, || {
                        slot.with_control_authority(&health, |_, state_owner| {
                            let state = state_owner.state.lock().unwrap();
                            let permit = || {
                                !shared.closed.load(Ordering::Acquire)
                                    && !shared.overflow.load(Ordering::Acquire)
                                    && state.admission.permits(generation, slot.elapsed_ms())
                                    && slot.live_control_transport(&health)
                            };
                            if let Some(chunk) = chunk {
                                input.submit_text_chunk(chunk, permit)
                            } else {
                                input.submit(message.action(), permit)
                            }
                            .map_err(|error| {
                                log::debug!(
                                    "Remote desktop input rejected stage=native reason={}",
                                    error.diagnostic_code()
                                );
                                "input_suspended"
                            })
                        })
                    })
                    .map_err(|_| {
                        log::debug!("Remote desktop input rejected stage=gui_reservation");
                        "input_suspended"
                    })
                    .and_then(|result| result)
                };
                let result = if let InputAction::TextCommit { text } = message.action() {
                    MacInput::plan_text(text)
                        .map_err(|_| "invalid_input")
                        .and_then(|chunks| {
                            for chunk in chunks {
                                submit(Some(&chunk))?;
                                // No GUI/host/admission guard is retained while pacing.
                                std::thread::sleep(Duration::from_millis(8));
                            }
                            Ok(())
                        })
                } else {
                    submit(None)
                };
                if let Err(code) = result {
                    log::debug!("Remote desktop input rejected stage=control code={code}");
                    shared.invalidate(false);
                    let _ = send(json!({"version":1,"kind":"control_error","code":code}));
                }
            }
        }
    }
}

fn acquire(
    slot: &Slot,
    health: &impl Fn() -> bool,
    expected: &str,
    native: &mut Option<(MacInput, ExternalReservationToken)>,
) -> Result<ControlGeneration, &'static str> {
    if native.is_some() {
        return Err("control_busy");
    }
    slot.with_control_authority(health, |_, _| Ok(()))?;
    let ticket = gui::reserve_external_control().map_err(|_| "control_busy")?;
    let prepared = MacInput::open(&slot.display_id());
    let result = match prepared {
        Ok(input) => {
            *native = Some((input, ticket));
            slot.with_control_authority(health, |host, shared| {
                if host.policy.revision() != expected {
                    return Err("stale_revision");
                }
                let mut state = shared.state.lock().unwrap();
                if shared.closed.load(Ordering::Acquire) || shared.overflow.load(Ordering::Acquire)
                {
                    return Err("stale_connection");
                }
                let generation = state
                    .admission
                    .grant(slot.elapsed_ms())
                    .map_err(|_| "control_busy")?;
                state.generation = Some(generation);
                if host
                    .policy
                    .control_changed(slot.source(), slot.connection_id())
                    .is_err()
                {
                    state.revoke();
                    return Err("stale_connection");
                }
                Ok(generation)
            })
        }
        Err(error) => Err(match error.diagnostic_code() {
            "permission_required" => "input_permission_required",
            "session_unavailable" => "host_locked",
            "target_changed" => "target_lost",
            "input_suspended" => "control_busy",
            _ => "input_suspended",
        }),
    };
    if result.is_err() {
        if let Some((input, _)) = native.as_mut() {
            // Failed acquisition posted no input; nevertheless preserve the
            // reservation on failed cleanup rather than opening a successor.
            if matches!(
                gui::release_external_control(ticket, || input
                    .drain()
                    .map_err(|_| "Remote input cleanup failed".into())),
                Ok(true)
            ) {
                *native = None;
            } else {
                slot.control.invalidate(true);
            }
        } else if !matches!(gui::release_external_control(ticket, || Ok(())), Ok(true)) {
            // No native state exists, but a failed GUI cleanup still cannot be
            // represented as a successfully available control slot.
            slot.control.state.lock().unwrap().quarantined = true;
            slot.control.invalidate(true);
        }
    }
    result
}
fn respond(
    slot: &Slot,
    send: &impl Fn(Value) -> bool,
    request: ControlRequest,
    result: Result<ControlGeneration, &'static str>,
) -> bool {
    match result {
        Ok(generation) => send(
            json!({"version":1,"kind":"control_result","request_id":request.request_id,"code":"ok","control_generation":generation,"state_revision":slot.control_revision()}),
        ),
        Err(code) => send(
            json!({"version":1,"kind":"control_result","request_id":request.request_id,"code":code,"state_revision":slot.control_revision()}),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const MOVE: &[u8] =
        br#"{"control_generation":"1","kind":"pointer_move","body":{"x":0.2,"y":0.3}}"#;
    const KEY: &[u8] = br#"{"control_generation":"1","kind":"key","body":{"usage":4,"down":true}}"#;
    #[test]
    fn renewal_budget_starts_at_host_ingress_not_worker_dequeue() {
        let mut state = State::default();
        let generation = state.admission.grant(0).unwrap();
        state.generation = Some(generation);
        assert_eq!(state.renew(generation, 1_000, 5_000), Ok(generation));
        assert!(state.admission.permits(generation, 6_999));
        assert!(!state.admission.permits(generation, 7_000));
        state.admission.expire(7_000);
        assert!(state.admission.pending_release().is_some());
        assert!(state.admission.grant(7_001).is_err());
    }
    #[test]
    fn renewal_received_before_expiry_cannot_revive_after_host_lock_wait() {
        let mut state = State::default();
        let generation = state.admission.grant(0).unwrap();
        state.generation = Some(generation);
        assert!(state.renew(generation, 1_000, 6_000).is_err());
        assert!(!state.admission.permits(generation, 6_000));
        assert!(state.admission.pending_release().is_some());
    }
    #[test]
    fn mailbox_preserves_renewal_receipt_while_coalescing_adjacent_moves() {
        let shared = Shared::default();
        let renewal = br#"{"version":1,"request_id":"renew","kind":"renew_control","body":{"control_generation":"1"}}"#;
        for (bytes, received_ms) in [
            (MOVE, 10),
            (MOVE, 20),
            (renewal.as_slice(), 30),
            (MOVE, 40),
            (MOVE, 50),
        ] {
            shared.receive(bytes, received_ms);
        }
        let mut inbox = shared.inbox.lock().unwrap();
        assert_eq!(
            inbox
                .queue
                .iter()
                .map(|(_, _, time)| *time)
                .collect::<Vec<_>>(),
            vec![20, 30, 50]
        );
        inbox.queue.pop_front();
        let (ControlMessage::Request(request), _, received_ms) = inbox.queue.pop_front().unwrap()
        else {
            panic!("Expected renewal");
        };
        let ControlAction::RenewControl { control_generation } = request.action else {
            panic!("Expected renewal action");
        };
        let mut state = State::default();
        let generation = state.admission.grant(0).unwrap();
        state.generation = Some(generation);
        assert_eq!(
            state.renew(control_generation, received_ms, 5_000),
            Ok(generation)
        );
        assert!(state.admission.permits(generation, 6_029));
        assert!(!state.admission.permits(generation, 6_030));
    }
    #[test]
    fn queued_old_renewal_does_not_shorten_or_retire_a_successor() {
        let mut state = State::default();
        let old = state.admission.grant(0).unwrap();
        let release = state.admission.release(old).unwrap();
        assert!(state.admission.finish_release(release));
        let current = state.admission.grant(4_000).unwrap();
        state.generation = Some(current);
        assert!(state.renew(old, 1_000, 5_000).is_err());
        assert!(state.admission.permits(current, 9_999));
        assert!(!state.admission.permits(current, 10_000));
        assert!(state.admission.pending_release().is_none());
    }
    fn queued_values(shared: &Shared) -> Vec<Value> {
        let inbox = shared.inbox.lock().unwrap();
        assert_eq!(
            inbox.bytes,
            inbox.queue.iter().map(|(_, bytes, _)| bytes).sum::<usize>()
        );
        inbox
            .queue
            .iter()
            .map(|(message, _, _)| match message {
                ControlMessage::Input(message) => serde_json::to_value(message).unwrap(),
                ControlMessage::Request(message) => serde_json::to_value(message).unwrap(),
            })
            .collect()
    }
    #[test]
    fn callback_coalesces_pending_moves_while_native_submission_is_blocked() {
        let shared = Shared::default();
        let _native_guard = shared.state.lock().unwrap();
        for _ in 0..MAX_PENDING_INPUTS * 4 {
            shared.receive(MOVE, 0);
        }
        let last = br#"{"control_generation":"1","kind":"pointer_move","body":{"x":0.9,"y":0.3}}"#;
        shared.receive(last, 0);
        assert!(!shared.overflow.load(Ordering::Acquire));
        let inbox = shared.inbox.lock().unwrap();
        assert_eq!(inbox.queue.len(), 1);
        let (ControlMessage::Input(message), bytes, _) = &inbox.queue[0] else {
            panic!("Expected pending input");
        };
        assert_eq!(
            message.action(),
            &InputAction::PointerMove { x: 0.9, y: 0.3 }
        );
        assert_eq!(*bytes, serde_json::to_vec(message).unwrap().len());
        assert_eq!(inbox.bytes, *bytes);
    }
    #[test]
    fn callback_mailbox_never_takes_the_native_admission_guard_and_stays_bounded() {
        let shared = Shared::default();
        let _native_guard = shared.state.lock().unwrap();
        // This would deadlock if the SDK callback used the guard held at post.
        for _ in 0..MAX_PENDING_INPUTS {
            shared.receive(KEY, 0);
        }
        assert_eq!(shared.inbox.lock().unwrap().queue.len(), MAX_PENDING_INPUTS);
        shared.receive(KEY, 0);
        assert!(shared.overflow.load(Ordering::Acquire));
        assert_eq!(shared.inbox.lock().unwrap().bytes, 0);
        assert!(shared.inbox.lock().unwrap().queue.is_empty());
        shared.receive(KEY, 0);
        assert!(shared.inbox.lock().unwrap().queue.is_empty());
    }
    #[test]
    fn mailbox_coalescing_preserves_input_control_and_generation_barriers() {
        let last = br#"{"control_generation":"1","kind":"pointer_move","body":{"x":0.8,"y":0.3}}"#;
        for barrier in [
            br#"{"control_generation":"1","kind":"pointer_button","body":{"button":"left","down":true,"x":0.2,"y":0.3}}"#.as_slice(),
            KEY,
            br#"{"control_generation":"1","kind":"text_commit","body":{"text":"fixed-test"}}"#,
            br#"{"control_generation":"1","kind":"wheel","body":{"x":0.2,"y":0.3,"dx":0.0,"dy":2.0}}"#,
            br#"{"version":1,"request_id":"acquire","kind":"acquire_control","body":{"expected_state_revision":"boot:1"}}"#,
            br#"{"version":1,"request_id":"renew","kind":"renew_control","body":{"control_generation":"1"}}"#,
            br#"{"version":1,"request_id":"release","kind":"release_control","body":{"control_generation":"1"}}"#,
            br#"{"control_generation":"2","kind":"pointer_move","body":{"x":0.5,"y":0.3}}"#,
        ] {
            let shared = Shared::default();
            for bytes in [MOVE, barrier, MOVE, last] {
                shared.receive(bytes, 0);
            }
            let expected: Vec<Value> = [MOVE, barrier, last].into_iter()
                .map(|bytes| serde_json::from_slice(bytes).unwrap()).collect();
            assert_eq!(queued_values(&shared), expected);
            assert!(!shared.overflow.load(Ordering::Acquire));
        }
    }
    #[test]
    fn stalled_drag_keeps_down_latest_move_and_up_at_its_final_coordinate() {
        let shared = Shared::default();
        let down = br#"{"control_generation":"1","kind":"pointer_button","body":{"button":"left","down":true,"x":0.2,"y":0.3}}"#;
        let up = br#"{"control_generation":"1","kind":"pointer_button","body":{"button":"left","down":false,"x":0.9,"y":0.7}}"#;
        shared.receive(down, 0);
        for _ in 0..MAX_PENDING_INPUTS * 4 {
            shared.receive(MOVE, 0);
        }
        shared.receive(up, 0);
        let expected: Vec<Value> = [down.as_slice(), MOVE, up]
            .into_iter()
            .map(|bytes| serde_json::from_slice(bytes).unwrap())
            .collect();
        assert_eq!(queued_values(&shared), expected);
        assert!(!shared.overflow.load(Ordering::Acquire));
    }
    #[test]
    fn full_mailbox_can_replace_a_move_but_never_discard_a_key_edge() {
        let shared = Shared::default();
        for _ in 0..MAX_PENDING_INPUTS - 1 {
            shared.receive(KEY, 0);
        }
        shared.receive(MOVE, 0);
        shared.receive(MOVE, 0);
        assert!(!shared.overflow.load(Ordering::Acquire));
        assert_eq!(queued_values(&shared).len(), MAX_PENDING_INPUTS);
        shared.receive(
            br#"{"control_generation":"1","kind":"key","body":{"usage":4,"down":false}}"#,
            0,
        );
        assert!(shared.overflow.load(Ordering::Acquire));
        assert!(queued_values(&shared).is_empty());
    }
    #[test]
    fn replacing_a_move_still_enforces_the_mailbox_byte_limit() {
        let shared = Shared::default();
        // Optional wire whitespace still consumes the ingress byte budget.
        for size in [32768, 32768 - MOVE.len()] {
            let mut padded = KEY.to_vec();
            padded.resize(size, b' ');
            shared.receive(&padded, 0);
        }
        shared.receive(MOVE, 0);
        assert_eq!(shared.inbox.lock().unwrap().bytes, MAX_PENDING_INPUT_BYTES);
        shared.receive(br#"{"control_generation":"1","kind":"pointer_move","body":{"x":0.12345678912345678,"y":0.3}}"#, 0);
        assert!(shared.overflow.load(Ordering::Acquire));
        assert!(queued_values(&shared).is_empty());
    }
    #[test]
    fn local_stop_clears_the_mailbox_and_retires_dequeued_input_until_actual_cleanup() {
        let shared = Shared::default();
        let generation = {
            let mut state = shared.state.lock().unwrap();
            let generation = state.admission.grant(0).unwrap();
            state.generation = Some(generation);
            generation
        };
        shared.receive(MOVE, 0);
        shared.invalidate(true);
        shared.receive(MOVE, 0);
        assert!(shared.inbox.lock().unwrap().queue.is_empty());
        let mut state = shared.state.lock().unwrap();
        assert!(!state.admission.permits(generation, 1));
        assert!(state.admission.pending_release().is_some());
        assert!(state.admission.grant(1).is_err());
    }
    #[test]
    fn serialized_byte_pressure_is_bounded_even_for_long_text_messages() {
        let shared = Shared::default();
        let message = serde_json::to_vec(&json!({"control_generation":"1","kind":"text_commit","body":{"text":"a".repeat(4096)}})).unwrap();
        let count = MAX_PENDING_INPUT_BYTES / message.len();
        for _ in 0..count {
            shared.receive(&message, 0);
        }
        assert_eq!(shared.inbox.lock().unwrap().bytes, count * message.len());
        shared.receive(&message, 0);
        assert!(shared.overflow.load(Ordering::Acquire));
        assert_eq!(shared.inbox.lock().unwrap().bytes, 0);
    }
}
