use super::*;
use crate::remote_desktop::media_session::tests::{drained, fixture};
use crate::remote_desktop::RemoteDesktopState;
use openbitfun_product_domains::remote_desktop::{RelayNotice, RelayNoticeKind};

fn successor(slot: &Slot) -> PendingMedia {
    PendingMedia {
        generation: slot.pending.generation,
        socket_generation: slot.pending.socket_generation,
        relay: slot.pending.relay.clone(),
        source: slot.source().clone(),
        attach_id: slot.attach_id().into(),
        connection_id: "pc-new".into(),
        target: CaptureTarget {
            id: 0,
            uuid: "not-a-real-display".into(),
            width: 1280,
            height: 720,
        },
        force_relay: slot.pending.force_relay,
        quality: slot.pending.quality,
        owner: slot.pending.owner.clone(),
    }
}

async fn suspended() -> (RemoteDesktopState, Arc<Slot>) {
    let (state, pending) = fixture();
    let source = pending.source.clone();
    state.1.reserve(pending).unwrap();
    let slot = state.1.current(&source, "pc").unwrap();
    let effects = {
        let mut owner = state.0.lock().unwrap();
        let host = owner.as_mut().unwrap();
        host.policy
            .suspend(&source, "a", &host.policy.revision())
            .unwrap()
    };
    state.1.apply(effects);
    assert!(slot.canceled());
    assert!(!slot.frame_allowed());
    assert!(!slot.live_control_transport(&|| panic!("retired input sampled health")));
    assert_eq!(
        slot.replacement_allowed(&successor(&slot), Instant::now()),
        Err("cleanup_pending")
    );
    tokio::time::timeout(Duration::from_secs(2), async {
        while slot.retained_until.get().is_none() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    (state, slot)
}

#[tokio::test]
async fn late_route_ready_acknowledges_suspension_without_reopening_draining_media() {
    let (state, pending) = fixture();
    let source = pending.source.clone();
    state.1.reserve(pending).unwrap();
    let slot = state.1.current(&source, "pc").unwrap();
    slot.lost();
    let effects = {
        let mut owner = state.0.lock().unwrap();
        let host = owner.as_mut().unwrap();
        host.policy
            .suspend(&source, "a", &host.policy.revision())
            .unwrap()
    };
    state.1.apply(effects);
    // No await: the actor cannot have confirmed native drainage yet.
    assert!(state.1.for_attachment("a").is_none());
    assert!(slot.retained_until.get().is_none());
    assert!(state.relay_notice(
        slot.pending.generation,
        2,
        &RelayNotice {
            version: 1,
            attach_id: "a".into(),
            kind: RelayNoticeKind::Ready,
        }
    ));
    assert!(slot.canceled());
    // Route readiness is metadata; cancellation remains the media/input gate.
    assert!(slot.relay_ready.load(Ordering::Acquire));
    assert!(!slot.frame_allowed());
    assert!(!slot.live_control_transport(&|| panic!("draining input sampled health")));
    assert_eq!(slot.socket_generation.load(Ordering::Acquire), 2);
    assert_eq!(
        slot.replacement_allowed(&successor(&slot), Instant::now()),
        Err("cleanup_pending")
    );
    let snapshot = state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .policy
        .snapshot(&source)
        .unwrap();
    assert!(snapshot.cleanup_pending);
    assert_eq!(snapshot.attachment.unwrap().phase, ViewPhase::Suspended);
    state.stop(slot.pending.generation).unwrap();
    assert!(!state.relay_notice(
        slot.pending.generation,
        3,
        &RelayNotice {
            version: 1,
            attach_id: "a".into(),
            kind: RelayNoticeKind::Ready,
        }
    ));
    drained(&state).await;
}

#[tokio::test]
async fn native_actor_retains_only_a_drained_suspended_slot_and_ready_does_not_extend_it() {
    let (state, slot) = suspended().await;
    assert!(state.1.occupied());
    assert!(!state.1.cleaning());
    assert!(state.1.current(slot.source(), "pc").is_none());
    assert!(state.1.for_attachment("a").is_some());
    assert!(slot.attachment_continues());
    let deadline = *slot.retained_until.get().unwrap();
    assert!(state.relay_notice(
        slot.pending.generation,
        2,
        &RelayNotice {
            version: 1,
            attach_id: "a".into(),
            kind: RelayNoticeKind::Ready,
        }
    ));
    assert_eq!(*slot.retained_until.get().unwrap(), deadline);
    assert!(!slot.route_visible(deadline));
    let owner = state.0.lock().unwrap();
    let snapshot = owner
        .as_ref()
        .unwrap()
        .policy
        .snapshot(slot.source())
        .unwrap();
    assert!(snapshot.busy && !snapshot.cleanup_pending);
    assert_eq!(snapshot.attachment.unwrap().phase, ViewPhase::Suspended);
    drop(owner);
    state.stop(slot.pending.generation).unwrap();
    drained(&state).await;
    assert!(!slot.attachment_continues());
}

#[tokio::test]
async fn changing_quality_cannot_extend_retention_or_restore_old_frame_authority() {
    use openbitfun_product_domains::remote_desktop::{QualityPreset, SetQualityRequest};
    let (state, slot) = suspended().await;
    let deadline = *slot.retained_until.get().unwrap();
    {
        let mut owner = state.0.lock().unwrap();
        let host = owner.as_mut().unwrap();
        host.policy
            .set_quality(
                slot.source(),
                &SetQualityRequest {
                    attach_id: "a".into(),
                    expected_state_revision: host.policy.revision(),
                    quality: QualityPreset::Clear,
                },
            )
            .unwrap();
    }
    assert_eq!(*slot.retained_until.get().unwrap(), deadline);
    assert!(!slot.frame_allowed());
    let mut next = successor(&slot);
    next.quality = QualityPreset::Clear;
    assert_eq!(
        slot.replacement_allowed(&next, deadline),
        Err("sharing_ended")
    );
    assert!(!slot.retain(deadline));
    assert!(!slot.attachment_continues());
    drained(&state).await;
}

#[tokio::test]
async fn a_new_pc_replaces_only_the_drained_slot_of_the_same_owner_and_attachment() {
    let (state, slot) = suspended().await;
    let mut wrong = successor(&slot);
    wrong.generation += 1;
    assert_eq!(
        slot.replacement_allowed(&wrong, Instant::now()),
        Err("cleanup_pending")
    );
    let mut wrong = successor(&slot);
    wrong.source.public_key_fingerprint = "b".repeat(64);
    assert_eq!(
        slot.replacement_allowed(&wrong, Instant::now()),
        Err("cleanup_pending")
    );
    let mut wrong = successor(&slot);
    wrong.attach_id = "new-attachment".into();
    assert_eq!(
        slot.replacement_allowed(&wrong, Instant::now()),
        Err("cleanup_pending")
    );
    let mut wrong = successor(&slot);
    wrong.force_relay = !slot.pending.force_relay;
    assert_eq!(
        slot.replacement_allowed(&wrong, Instant::now()),
        Err("cleanup_pending")
    );
    let mut wrong = successor(&slot);
    wrong.connection_id = "pc".into();
    assert_eq!(
        slot.replacement_allowed(&wrong, Instant::now()),
        Err("cleanup_pending")
    );
    let (other, pending) = fixture();
    assert_eq!(state.1.reserve(pending), Err("cleanup_pending"));
    drop(other);
    {
        let mut owner = state.0.lock().unwrap();
        let host = owner.as_mut().unwrap();
        host.policy
            .resume(slot.source(), "a", &host.policy.revision(), "pc-new")
            .unwrap();
        state.1.reserve(successor(&slot)).unwrap();
    }
    assert!(!slot.retain(Instant::now()));
    assert!(
        slot.attachment_continues(),
        "Old actor must not unregister the retained Relay attachment"
    );
    slot.fail("media_unreachable");
    slot.fail("cleanup_failed"); // Neither old callback owns the new connection.
    tokio::time::timeout(Duration::from_secs(2), async {
        while Arc::strong_count(&slot) > 1 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let next = state.1.current(slot.source(), "pc-new").unwrap();
    assert!(!next.canceled());
    assert!(state.0.lock().unwrap().as_ref().unwrap().failure.is_none());
    state.retire();
    drained(&state).await;
}

#[tokio::test]
async fn the_retained_budget_expires_synchronously_before_an_actor_tick() {
    let (state, slot) = suspended().await;
    let deadline = *slot.retained_until.get().unwrap();
    assert!(slot.retain(deadline - Duration::from_millis(1)));
    assert_eq!(
        slot.replacement_allowed(&successor(&slot), deadline),
        Err("sharing_ended")
    );
    assert!(!slot.retain(deadline));
    assert!(!slot.attachment_continues());
    assert_eq!(
        state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .failure
            .as_ref()
            .unwrap()
            .1,
        "sharing_ended"
    );
    slot.wake.notify_one();
    drained(&state).await;
}

#[tokio::test]
async fn expected_transport_close_is_ignored_but_cleanup_failure_ends_the_retained_attachment() {
    let (state, slot) = suspended().await;
    slot.fail("media_unreachable");
    assert!(slot.attachment_continues());
    assert!(state.0.lock().unwrap().as_ref().unwrap().failure.is_none());
    slot.fail("cleanup_failed");
    assert!(!slot.attachment_continues());
    assert_eq!(
        state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .failure
            .as_ref()
            .unwrap()
            .1,
        "cleanup_failed"
    );
    drained(&state).await;
}

#[tokio::test]
async fn account_retirement_reclaims_a_suspended_slot_without_media_or_a_live_controller() {
    let (state, slot) = suspended().await;
    state.retire();
    assert!(!slot.retain(Instant::now()));
    drained(&state).await;
    assert!(!slot.attachment_continues());
}

#[tokio::test]
async fn relay_grace_is_still_bounded_while_no_pc_exists() {
    let (state, slot) = suspended().await;
    {
        let mut owner = state.0.lock().unwrap();
        let host = owner.as_mut().unwrap();
        host.started = Instant::now() - Duration::from_secs(31);
        host.policy.relay_lost(0);
    }
    assert!(!slot.retain(Instant::now()));
    assert!(!slot.attachment_continues());
    slot.wake.notify_one();
    drained(&state).await;
}
