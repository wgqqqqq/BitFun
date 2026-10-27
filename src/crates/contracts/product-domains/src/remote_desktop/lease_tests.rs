use super::*;
use crate::remote_desktop::input::{InputAction, InputMessage, InputQueue};

#[test]
fn deadline_closes_admission_before_a_delayed_watchdog_runs() {
    let mut lease = ControlLease::default();
    let grant = lease.grant(100).unwrap();
    assert!(lease.permits(grant, 6_099));
    assert!(!lease.permits(grant, 6_100));
    assert!(!lease.permits(grant, 100_000));
    assert_eq!(lease.grant(100_000), Err(LeaseError::ControlBusy));
    let release = lease.expire(100_000).unwrap();
    assert_ne!(release.current_generation(), grant);
    assert_eq!(lease.expire(100_001), None);
    assert_eq!(lease.pending_release(), Some(release));
    assert_eq!(lease.grant(100_001), Err(LeaseError::ControlBusy));
    assert!(lease.finish_release(release));
    assert!(lease.grant(100_002).is_ok());
}

#[test]
fn renewal_at_the_deadline_invalidates_and_never_revives_the_lease() {
    let mut lease = ControlLease::default();
    let grant = lease.grant(0).unwrap();
    lease.renew(grant, 2_000).unwrap();
    assert!(lease.permits(grant, 7_999));
    assert_eq!(lease.renew(grant, 8_000), Err(LeaseError::LeaseExpired));
    let release = lease.pending_release().unwrap();
    assert!(!lease.permits(grant, 7_999));
    assert_eq!(lease.renew(grant, 8_001), Err(LeaseError::StaleGeneration));
    assert_eq!(lease.pending_release(), Some(release));
    assert_eq!(lease.grant(8_001), Err(LeaseError::ControlBusy));
}

#[test]
fn delayed_old_renew_release_and_drain_cannot_affect_a_successor() {
    let mut lease = ControlLease::default();
    let old = lease.grant(0).unwrap();
    let old_release = lease.release(old).unwrap();
    assert_eq!(lease.release(old).unwrap(), old_release);
    assert!(lease.finish_release(old_release));
    assert!(!lease.finish_release(old_release));
    let next = lease.grant(1_000).unwrap();
    assert_ne!(next, old_release.current_generation());
    assert_eq!(lease.renew(old, 2_000), Err(LeaseError::StaleGeneration));
    assert_eq!(lease.release(old), Err(LeaseError::StaleGeneration));
    assert!(!lease.finish_release(old_release));
    // The old renewal did not prolong or revoke the current lease.
    assert!(lease.permits(next, 6_999));
    assert!(!lease.permits(next, 7_000));
    let next_release = lease.release(next).unwrap();
    assert!(!lease.finish_release(old_release));
    assert_eq!(lease.pending_release(), Some(next_release));
}

#[test]
fn failed_native_drain_stays_busy_without_a_timeout_escape() {
    let mut lease = ControlLease::default();
    let grant = lease.grant(0).unwrap();
    let release = lease.release(grant).unwrap();
    for now in [6_000, 30_000, 1_000_000] {
        assert_eq!(lease.expire(now), None);
        assert_eq!(lease.grant(now), Err(LeaseError::ControlBusy));
        assert_eq!(lease.pending_release(), Some(release));
        assert!(!lease.permits(grant, now));
    }
    // The facade retries actual cleanup. Only its success permits this call.
    assert!(lease.finish_release(release));
    assert!(lease.grant(1_000_001).is_ok());
}

#[test]
fn queue_and_already_dequeued_work_cannot_cross_revocation() {
    let mut lease = ControlLease::default();
    let mut queue = InputQueue::default();
    let old = lease.grant(0).unwrap();
    queue.activate(old).unwrap();
    let old_input = InputMessage::new(
        old,
        InputAction::Key {
            usage: 4,
            down: true,
        },
    );
    queue.push(old_input.clone(), false).unwrap();
    let in_flight = queue.pop().unwrap();
    queue.push(old_input.clone(), false).unwrap();
    let release = lease.release(old).unwrap();
    queue.suspend(); // the native owner does this before any drain IO
    assert!(queue.is_empty());
    assert!(!lease.permits(in_flight.generation(), 1));
    assert!(lease.finish_release(release));
    let next = lease.grant(2).unwrap();
    queue.activate(next).unwrap();
    assert!(queue.push(old_input, false).is_err());
    assert!(!lease.permits(in_flight.generation(), 3));
    assert!(lease.permits(next, 3));
}

#[test]
fn clock_overflow_changes_neither_the_lease_nor_its_generation() {
    let mut lease = ControlLease::default();
    assert_eq!(lease.grant(u64::MAX), Err(LeaseError::ClockOverflow));
    let grant = lease.grant(u64::MAX - CONTROL_LEASE_MS).unwrap();
    assert_eq!(grant, ControlGeneration::new(1).unwrap());
    assert_eq!(lease.renew(grant, u64::MAX), Err(LeaseError::LeaseExpired));
    assert!(lease.pending_release().is_some());
    let mut lease = ControlLease::default();
    let grant = lease.grant(u64::MAX - CONTROL_LEASE_MS - 1).unwrap();
    assert_eq!(
        lease.renew(grant, u64::MAX - CONTROL_LEASE_MS + 1),
        Err(LeaseError::ClockOverflow)
    );
    assert!(lease.permits(grant, u64::MAX - 2));
    assert!(!lease.permits(grant, u64::MAX - 1));
}

#[test]
fn final_grant_reserves_revocation_and_exhaustion_never_wraps() {
    let mut lease = ControlLease {
        latest: u64::MAX - 2,
        phase: Phase::Idle,
    };
    let last = lease.grant(0).unwrap();
    assert_eq!(last, ControlGeneration::new(u64::MAX - 1).unwrap());
    let release = lease.expire(6_000).unwrap();
    assert_eq!(
        release.current_generation(),
        ControlGeneration::new(u64::MAX).unwrap()
    );
    assert!(!lease.permits(last, 6_000));
    assert!(lease.finish_release(release));
    assert_eq!(lease.grant(6_001), Err(LeaseError::GenerationExhausted));
    assert!(!lease.permits(ControlGeneration::new(1).unwrap(), 6_001));
}
