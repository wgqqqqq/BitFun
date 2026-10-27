use super::*;

fn fixture(streaming: bool) -> (ReadOnlyHost, ControllerIdentity) {
    let source = ControllerIdentity {
        account_id: "account".into(),
        device_id: "phone".into(),
        public_key_fingerprint: "a".repeat(64),
    };
    let mut host = ReadOnlyHost::new(
        "account".into(),
        "boot".into(),
        ViewGrantFile {
            grants: vec![ViewGrant {
                account_id: source.account_id.clone(),
                device_id: source.device_id.clone(),
                public_key_fingerprint: source.public_key_fingerprint.clone(),
                display_ids: vec!["display-1".into(), "display-2".into()],
                control_display_ids: vec!["display-1".into(), "display-2".into()],
            }],
            ..Default::default()
        },
    )
    .unwrap();
    host.attach(
        &source,
        &AttachRequest {
            attach_id: "attachment".into(),
            expected_state_revision: host.revision(),
            display_id: "display-1".into(),
            force_relay: true,
        },
        "pc-old",
    )
    .unwrap();
    if streaming {
        host.bound(&source, "pc-old").unwrap();
    }
    (host, source)
}

#[test]
fn display_change_closes_old_authority_and_keeps_the_attachment_through_native_drain() {
    let (mut host, source) = fixture(true);
    assert_eq!(
        host.select_display(&source, "attachment", "display-2", &host.revision())
            .unwrap(),
        vec![MediaEffect::Close {
            connection_id: "pc-old".into()
        }]
    );
    let state = host.snapshot(&source).unwrap();
    assert!(state.busy && state.cleanup_pending);
    let attachment = state.attachment.unwrap();
    assert_eq!(attachment.attach_id, "attachment");
    assert_eq!(attachment.display_id, "display-2");
    assert_eq!(attachment.phase, ViewPhase::Suspended);
    assert!(!host.may_send_frame(&source, "pc-old", 0));
    assert_eq!(
        host.connection_for(&source, "attachment", "pc-old"),
        Err(ReadOnlyError::StaleConnection)
    );
    assert_eq!(
        host.bound(&source, "pc-old"),
        Err(ReadOnlyError::StaleConnection)
    );
    assert_eq!(
        host.resume(&source, "attachment", &host.revision(), "pc-new"),
        Err(ReadOnlyError::CleanupPending)
    );
    assert_eq!(
        host.select_display(&source, "attachment", "display-1", &host.revision()),
        Err(ReadOnlyError::CleanupPending)
    );
    host.media_closed("wrong-pc").unwrap();
    assert!(host.snapshot(&source).unwrap().cleanup_pending);
    host.media_closed("pc-old").unwrap();
    let suspended = host.snapshot(&source).unwrap();
    assert!(suspended.busy && !suspended.cleanup_pending);
    host.media_closed("pc-old").unwrap();
    assert_eq!(host.snapshot(&source).unwrap(), suspended);
    assert_eq!(
        host.resume(&source, "attachment", &host.revision(), "pc-new")
            .unwrap(),
        vec![MediaEffect::Prepare {
            connection_id: "pc-new".into(),
            display_id: "display-2".into(),
        }]
    );
    assert!(!host.may_send_frame(&source, "pc-new", 0));
    let binding = host.snapshot(&source).unwrap();
    host.media_closed("pc-old").unwrap();
    assert_eq!(host.snapshot(&source).unwrap(), binding);
    assert_eq!(
        host.bound(&source, "pc-new").unwrap(),
        vec![MediaEffect::StartCapture {
            connection_id: "pc-new".into(),
            display_id: "display-2".into(),
        }]
    );
    assert!(host.may_send_frame(&source, "pc-new", 0));
    assert!(!host.may_send_frame(&source, "pc-old", 0));
}

#[test]
fn suspend_is_idempotent_for_binding_and_streaming_and_cannot_reuse_the_retired_pc() {
    for streaming in [false, true] {
        let (mut host, source) = fixture(streaming);
        let revision = host.revision();
        assert_eq!(
            host.suspend(&source, "attachment", &revision)
                .unwrap()
                .len(),
            1
        );
        let state = host.snapshot(&source).unwrap();
        assert!(host
            .suspend(&source, "attachment", &revision)
            .unwrap()
            .is_empty());
        assert_eq!(host.snapshot(&source).unwrap(), state);
        host.media_closed("pc-old").unwrap();
        assert_eq!(
            host.resume(&source, "attachment", &host.revision(), "pc-old"),
            Err(ReadOnlyError::InvalidRequest)
        );
        assert_eq!(
            host.resume(&source, "attachment", &host.revision(), ""),
            Err(ReadOnlyError::InvalidRequest)
        );
        assert_eq!(
            host.resume(&source, "attachment", &revision, "pc-new"),
            Err(ReadOnlyError::StaleRevision)
        );
        assert_eq!(
            host.snapshot(&source).unwrap().attachment.unwrap().phase,
            ViewPhase::Suspended
        );
    }
}

#[test]
fn selecting_during_the_old_handshake_rejects_its_late_bind_and_keeps_the_slot_reserved() {
    let (mut host, source) = fixture(false);
    host.select_display(&source, "attachment", "display-2", &host.revision())
        .unwrap();
    assert_eq!(
        host.bound(&source, "pc-old"),
        Err(ReadOnlyError::StaleConnection)
    );
    host.media_closed("pc-old").unwrap();
    assert_eq!(
        host.attach(
            &source,
            &AttachRequest {
                attach_id: "second-attachment".into(),
                expected_state_revision: host.revision(),
                display_id: "display-2".into(),
                force_relay: false,
            },
            "second-pc"
        ),
        Err(ReadOnlyError::AttachmentBusy)
    );
    assert!(host.matches_attachment("attachment"));
    assert!(!host.may_send_frame(&source, "pc-old", 0));
}

#[test]
fn changing_display_does_not_transfer_its_predecessors_control_scope() {
    let (mut host, source) = fixture(true);
    let mut grants = host.local_view_grants().clone();
    grants.grants[0].control_display_ids = vec!["display-1".into()];
    host.replace_grants(grants).unwrap();
    host.media_closed("pc-old").unwrap();
    host.attach(
        &source,
        &AttachRequest {
            attach_id: "next".into(),
            expected_state_revision: host.revision(),
            display_id: "display-1".into(),
            force_relay: true,
        },
        "pc-current",
    )
    .unwrap();
    host.bound(&source, "pc-current").unwrap();
    host.select_display(&source, "next", "display-2", &host.revision())
        .unwrap();
    assert!(host.allows(&source, "display-2"));
    assert!(!host.allows_control(&source, "display-2"));
    host.media_closed("pc-current").unwrap();
    host.resume(&source, "next", &host.revision(), "pc-new")
        .unwrap();
    assert!(!host.allows_control(&source, "display-2"));
    assert!(!host.may_send_frame(&source, "pc-new", 0));
}

#[test]
fn wrong_identity_unauthorized_display_and_stale_cas_do_not_interrupt_the_current_source() {
    let (mut host, source) = fixture(true);
    let before = host.snapshot(&source).unwrap();
    for wrong in [
        ControllerIdentity {
            device_id: "other".into(),
            ..source.clone()
        },
        ControllerIdentity {
            account_id: "other".into(),
            ..source.clone()
        },
        ControllerIdentity {
            public_key_fingerprint: "b".repeat(64),
            ..source.clone()
        },
    ] {
        assert_eq!(
            host.suspend(&wrong, "attachment", &host.revision()),
            Err(ReadOnlyError::StaleConnection)
        );
        assert_eq!(
            host.select_display(&wrong, "attachment", "display-2", &host.revision()),
            Err(ReadOnlyError::StaleConnection)
        );
        assert_eq!(
            host.resume(&wrong, "attachment", &host.revision(), "pc-new"),
            Err(ReadOnlyError::StaleConnection)
        );
    }
    assert_eq!(
        host.suspend(&source, "old-attachment", &host.revision()),
        Err(ReadOnlyError::StaleConnection)
    );
    assert_eq!(
        host.select_display(&source, "attachment", "unapproved", &host.revision()),
        Err(ReadOnlyError::AuthorizationRequired)
    );
    assert_eq!(
        host.select_display(&source, "attachment", "display-2", "stale"),
        Err(ReadOnlyError::StaleRevision)
    );
    assert_eq!(
        host.suspend(&source, "attachment", "stale"),
        Err(ReadOnlyError::StaleRevision)
    );
    assert_eq!(
        host.resume(&source, "attachment", &host.revision(), "pc-new"),
        Err(ReadOnlyError::InvalidRequest)
    );
    assert_eq!(host.snapshot(&source).unwrap(), before);
    assert!(host.may_send_frame(&source, "pc-old", 0));
}

#[test]
fn identical_selection_is_a_live_noop_and_a_paused_selection_creates_no_native_resource() {
    let (mut host, source) = fixture(true);
    let before = host.snapshot(&source).unwrap();
    assert!(host
        .select_display(&source, "attachment", "display-1", "old-ack")
        .unwrap()
        .is_empty());
    assert_eq!(host.snapshot(&source).unwrap(), before);
    host.suspend(&source, "attachment", &host.revision())
        .unwrap();
    host.media_closed("pc-old").unwrap();
    assert!(host
        .select_display(&source, "attachment", "display-2", &host.revision())
        .unwrap()
        .is_empty());
    let changed = host.snapshot(&source).unwrap();
    assert!(changed.busy && !changed.cleanup_pending);
    assert!(host
        .select_display(&source, "attachment", "display-2", "lost-ack")
        .unwrap()
        .is_empty());
    assert_eq!(host.snapshot(&source).unwrap(), changed);
    assert!(!host.may_send_frame(&source, "pc-old", 0));
}

#[test]
fn an_original_attach_retry_after_selection_cannot_rewind_or_repurpose_the_source() {
    let (mut host, source) = fixture(true);
    host.select_display(&source, "attachment", "display-2", &host.revision())
        .unwrap();
    let selected = host.snapshot(&source).unwrap();
    let original = AttachRequest {
        attach_id: "attachment".into(),
        display_id: "display-1".into(),
        expected_state_revision: "boot:0".into(),
        force_relay: true,
    };
    assert!(host
        .attach(&source, &original, "unused-pc")
        .unwrap()
        .is_empty());
    assert_eq!(host.snapshot(&source).unwrap(), selected);
    assert_eq!(
        host.attach(
            &source,
            &AttachRequest {
                display_id: "display-2".into(),
                ..original
            },
            "unused-pc"
        ),
        Err(ReadOnlyError::AttachIdConflict)
    );
    assert_eq!(host.snapshot(&source).unwrap(), selected);
}

#[test]
fn detach_during_or_after_pause_does_not_lose_a_drain_or_invent_a_missing_pc() {
    for drained in [false, true] {
        let (mut host, source) = fixture(true);
        host.suspend(&source, "attachment", &host.revision())
            .unwrap();
        if drained {
            host.media_closed("pc-old").unwrap();
        }
        assert!(host.detach(&source, "attachment").unwrap().is_empty());
        let closed = host.snapshot(&source).unwrap();
        assert!(!closed.busy);
        assert_eq!(closed.cleanup_pending, !drained);
        assert_eq!(
            host.resume(&source, "attachment", &host.revision(), "pc-new"),
            Err(ReadOnlyError::StaleConnection)
        );
        host.media_closed("pc-old").unwrap();
        assert!(!host.snapshot(&source).unwrap().cleanup_pending);
        host.attach(
            &source,
            &AttachRequest {
                attach_id: "successor".into(),
                expected_state_revision: host.revision(),
                display_id: "display-1".into(),
                force_relay: false,
            },
            "pc-successor",
        )
        .unwrap();
        let next = host.snapshot(&source).unwrap();
        host.media_closed("pc-old").unwrap();
        assert_eq!(host.snapshot(&source).unwrap(), next);
    }
}

#[test]
fn revoke_and_relay_expiry_end_a_suspended_attachment_without_reopening_transport() {
    for revoke in [false, true] {
        let (mut host, source) = fixture(true);
        host.suspend(&source, "attachment", &host.revision())
            .unwrap();
        if revoke {
            assert!(host
                .replace_grants(ViewGrantFile::default())
                .unwrap()
                .is_empty());
        } else {
            host.relay_lost(100);
            assert_eq!(
                host.resume(&source, "attachment", &host.revision(), "pc-new"),
                Err(ReadOnlyError::RelayUnavailable)
            );
            assert!(host
                .expire_relay_grace(100 + RELAY_VIDEO_GRACE_MS)
                .unwrap()
                .is_empty());
        }
        assert!(!host.matches_attachment("attachment"));
        assert_eq!(host.retiring_connection.as_deref(), Some("pc-old"));
        host.media_closed("pc-old").unwrap();
        assert!(host.retiring_connection.is_none());
        assert!(!host.may_send_frame(&source, "pc-old", 0));
    }
}

#[test]
fn revision_exhaustion_leaves_source_transitions_atomic() {
    let (mut host, source) = fixture(true);
    host.revision = u64::MAX;
    let before = host.snapshot(&source).unwrap();
    assert_eq!(
        host.suspend(&source, "attachment", &host.revision()),
        Err(ReadOnlyError::RevisionExhausted)
    );
    assert_eq!(
        host.select_display(&source, "attachment", "display-2", &host.revision()),
        Err(ReadOnlyError::RevisionExhausted)
    );
    assert_eq!(host.snapshot(&source).unwrap(), before);
    let (mut host, source) = fixture(true);
    host.suspend(&source, "attachment", &host.revision())
        .unwrap();
    host.media_closed("pc-old").unwrap();
    host.revision = u64::MAX;
    let before = host.snapshot(&source).unwrap();
    assert_eq!(
        host.resume(&source, "attachment", &host.revision(), "pc-new"),
        Err(ReadOnlyError::RevisionExhausted)
    );
    assert_eq!(host.snapshot(&source).unwrap(), before);
}

#[test]
fn source_wire_requires_the_exact_outer_attachment_and_preserves_legacy_payloads() {
    assert_eq!(SOURCE_LIFECYCLE_V1, "source_lifecycle_v1");
    for op in ["select_display", "suspend", "resume"] {
        let mut body =
            serde_json::json!({"attach_id":"attachment", "expected_state_revision":"boot:3"});
        if op == "select_display" {
            body["display_id"] = serde_json::json!("display-2");
        }
        let value = serde_json::json!({"version":1,"op":op,"body":body});
        let request: ReadOnlyRequest = serde_json::from_value(value.clone()).unwrap();
        assert!(request.matches_route_attachment(Some("attachment")));
        assert!(!request.matches_route_attachment(Some("other")));
        assert!(!request.matches_route_attachment(None));
        assert_eq!(serde_json::to_value(request).unwrap(), value);
        let missing_cas =
            serde_json::json!({"version":1,"op":op,"body":{"attach_id":"attachment"}});
        assert!(serde_json::from_value::<ReadOnlyRequest>(missing_cas).is_err());
    }
    let request: ReadOnlyRequest = serde_json::from_value(serde_json::json!({
        "version": 1, "op": "attach", "body": {
            "attach_id":"legacy", "display_id":"display-1", "expected_state_revision":"boot:0"
        }
    }))
    .unwrap();
    let written = serde_json::to_value(&request).unwrap();
    assert!(written["body"].get("force_relay").is_none());
    assert!(serde_json::from_value::<ReadOnlyRequest>(written).is_ok());
}
