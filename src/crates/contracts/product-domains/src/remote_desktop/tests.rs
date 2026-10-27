use super::*;

fn source(device: &str) -> ControllerIdentity {
    ControllerIdentity {
        account_id: "account".into(),
        device_id: device.into(),
        public_key_fingerprint: "a".repeat(64),
    }
}

#[test]
fn legacy_view_records_and_old_reader_round_trip_never_gain_control() {
    let old = serde_json::json!({"version":1,"grants":[{
        "account_id":"account","device_id":"phone","public_key_fingerprint":"a".repeat(64),"display_ids":["display-1"]
    }]});
    let file: ViewGrantFile = serde_json::from_value(old).unwrap();
    assert!(file.grants[0].control_display_ids.is_empty());
    let host = ReadOnlyHost::new("account".into(), "boot".into(), file.clone()).unwrap();
    assert!(host.allows(&source("phone"), "display-1"));
    assert!(!host.allows_control(&source("phone"), "display-1"));
    #[derive(Deserialize)]
    struct OldRecord {
        account_id: String,
        device_id: String,
        public_key_fingerprint: String,
        display_ids: Vec<String>,
    }
    let written = serde_json::to_value(&file).unwrap();
    let old_reader: OldRecord = serde_json::from_value(written["grants"][0].clone()).unwrap();
    assert_eq!(old_reader.account_id, "account");
    assert_eq!(old_reader.device_id, "phone");
    assert_eq!(old_reader.public_key_fingerprint, "a".repeat(64));
    assert_eq!(old_reader.display_ids, vec!["display-1"]);
    let decoded: ViewGrantFile = serde_json::from_value(written).unwrap();
    assert_eq!(decoded, file);
}

#[test]
fn control_requires_exact_identity_and_both_scopes_in_one_supported_record() {
    let mut file = grants();
    file.grants[0].control_display_ids = vec!["display-1".into(), "display-3".into()];
    let host = ReadOnlyHost::new("account".into(), "boot".into(), file.clone()).unwrap();
    let phone = source("phone");
    assert!(host.allows_control(&phone, "display-1"));
    assert!(!host.allows_control(&phone, "display-2"));
    assert!(!host.allows_control(&phone, "display-3"));
    assert!(!host.allows_control(&source("desktop"), "display-1"));
    for changed in [
        ControllerIdentity {
            account_id: "other".into(),
            ..phone.clone()
        },
        ControllerIdentity {
            public_key_fingerprint: "b".repeat(64),
            ..phone.clone()
        },
    ] {
        assert!(!host.allows_control(&changed, "display-1"));
    }
    let mut separate = file.grants[0].clone();
    separate.display_ids = vec!["display-3".into()];
    separate.control_display_ids.clear();
    file.grants.push(separate);
    let host = ReadOnlyHost::new("account".into(), "boot".into(), file.clone()).unwrap();
    assert!(host.allows(&phone, "display-3"));
    assert!(!host.allows_control(&phone, "display-3"));
    file.version = 2;
    let host = ReadOnlyHost::new("account".into(), "boot".into(), file).unwrap();
    assert!(!host.allows_control(&phone, "display-1"));
}
fn grants() -> ViewGrantFile {
    ViewGrantFile {
        version: 1,
        grants: vec![
            ViewGrant {
                account_id: "account".into(),
                device_id: "phone".into(),
                public_key_fingerprint: "a".repeat(64),
                display_ids: vec!["display-1".into(), "display-2".into()],
                control_display_ids: Vec::new(),
            },
            ViewGrant {
                account_id: "account".into(),
                device_id: "desktop".into(),
                public_key_fingerprint: "a".repeat(64),
                display_ids: vec!["display-2".into()],
                control_display_ids: Vec::new(),
            },
        ],
    }
}
fn host() -> ReadOnlyHost {
    ReadOnlyHost::new("account".into(), "boot-1".into(), grants()).unwrap()
}

#[test]
fn control_transitions_fence_pending_acquisitions_only_for_the_bound_owner() {
    let mut host = host();
    let phone = source("phone");
    let attach = request(&host, "attachment", "display-1");
    host.attach(&phone, &attach, "pc").unwrap();
    let initial = host.revision();
    assert!(host.control_changed(&source("desktop"), "pc").is_err());
    assert!(host.control_changed(&phone, "old-pc").is_err());
    assert_eq!(host.revision(), initial);
    let granted = host.control_changed(&phone, "pc").unwrap();
    assert_ne!(granted, initial);
    let released = host.control_changed(&phone, "pc").unwrap();
    assert_ne!(released, granted);
    assert_eq!(host.snapshot(&phone).unwrap().state_revision, released);
    // Advancing CAS is not an input grant or a native reservation.
    assert!(!host.allows_control(&phone, "display-1"));
}
fn request(host: &ReadOnlyHost, id: &str, display: &str) -> AttachRequest {
    AttachRequest {
        attach_id: id.into(),
        expected_state_revision: host.revision(),
        display_id: display.into(),
        force_relay: false,
    }
}

#[test]
fn control_scope_change_closes_the_old_binding_even_when_viewing_remains_allowed() {
    let mut host = host();
    let phone = source("phone");
    let attach = request(&host, "attachment", "display-1");
    host.attach(&phone, &attach, "pc").unwrap();
    let mut next = grants();
    next.grants[0].control_display_ids = vec!["display-1".into()];
    assert_eq!(
        host.replace_grants(next).unwrap(),
        vec![MediaEffect::Close {
            connection_id: "pc".into()
        }]
    );
    assert!(host.allows(&phone, "display-1"));
    assert!(host.allows_control(&phone, "display-1"));
    assert!(!host.may_send_frame(&phone, "pc", 0));
    assert!(host.snapshot(&phone).unwrap().cleanup_pending);
    let retry = request(&host, "next", "display-1");
    assert_eq!(
        host.attach(&phone, &retry, "next-pc").unwrap_err(),
        ReadOnlyError::CleanupPending
    );
}

#[test]
fn unrelated_device_scope_edits_do_not_retire_the_current_binding() {
    let mut host = host();
    let phone = source("phone");
    let attach = request(&host, "attachment", "display-1");
    host.attach(&phone, &attach, "pc").unwrap();
    let mut next = grants();
    next.grants[1].control_display_ids = vec!["display-2".into()];
    assert!(host.replace_grants(next).unwrap().is_empty());
    assert_eq!(
        host.snapshot(&phone)
            .unwrap()
            .attachment
            .unwrap()
            .connection_id,
        "pc"
    );
}

#[test]
fn final_revision_retires_scope_without_a_second_counter_advance() {
    let mut host = host();
    let phone = source("phone");
    let attach = request(&host, "attachment", "display-1");
    host.attach(&phone, &attach, "pc").unwrap();
    host.revision = u64::MAX - 1;
    let mut next = grants();
    next.grants[0].control_display_ids = vec!["display-1".into()];
    assert_eq!(
        host.replace_grants(next).unwrap(),
        vec![MediaEffect::Close {
            connection_id: "pc".into()
        }]
    );
    assert!(!host.may_send_frame(&phone, "pc", 0));
    assert!(host.snapshot(&phone).unwrap().cleanup_pending);
}

#[test]
fn missing_legacy_grant_fields_and_newer_schema_never_authorize() {
    let legacy: ViewGrantFile =
        serde_json::from_str(r#"{"grants":[{"device_id":"phone"}]}"#).unwrap();
    assert_eq!(legacy.version, 1);
    let restored: ViewGrantFile =
        serde_json::from_str(&serde_json::to_string(&legacy).unwrap()).unwrap();
    assert_eq!(legacy, restored);
    assert!(
        !ReadOnlyHost::new("account".into(), "boot".into(), restored)
            .unwrap()
            .allows(&source("phone"), "display-1")
    );
    let empty: ViewGrantFile = serde_json::from_str("{}").unwrap();
    assert!(empty.grants.is_empty());
    let mut future = grants();
    future.version = 2;
    assert!(!ReadOnlyHost::new("account".into(), "boot".into(), future)
        .unwrap()
        .allows(&source("phone"), "display-1"));
}

#[test]
fn view_grant_round_trip_preserves_identity_and_explicit_screen_scope() {
    let old = grants();
    let restored: ViewGrantFile =
        serde_json::from_str(&serde_json::to_string(&old).unwrap()).unwrap();
    assert_eq!(old, restored);
    let h = ReadOnlyHost::new("account".into(), "boot".into(), restored).unwrap();
    assert!(h.allows(&source("phone"), "display-1"));
    assert!(!h.allows(&source("phone"), "new-display"));
}

#[test]
fn account_device_and_key_changes_cannot_borrow_a_grant() {
    let mut h = host();
    let mut another_account = source("phone");
    another_account.account_id = "other".into();
    for untrusted in [source("outsider"), another_account] {
        assert_eq!(
            h.attach(&untrusted, &request(&h, "attach", "display-1"), "pc"),
            Err(ReadOnlyError::AuthorizationRequired)
        );
    }
    let mut changed = source("phone");
    changed.public_key_fingerprint = "b".repeat(64);
    assert!(!h.allows(&changed, "display-1"));
    changed.public_key_fingerprint.clear();
    assert!(!h.allows(&changed, "display-1"));
    assert_eq!(
        h.snapshot(&source("outsider")),
        Err(ReadOnlyError::AuthorizationRequired)
    );
}

#[test]
fn attachment_prepares_transport_before_any_frame_and_bind_is_idempotent() {
    let mut h = host();
    let s = source("phone");
    let req = request(&h, "attach", "display-1");
    assert_eq!(
        h.attach(&s, &req, "pc-1").unwrap(),
        vec![MediaEffect::Prepare {
            connection_id: "pc-1".into(),
            display_id: "display-1".into()
        }]
    );
    assert!(!h.may_send_frame(&s, "pc-1", 0));
    assert_eq!(
        h.bound(&source("desktop"), "pc-1"),
        Err(ReadOnlyError::StaleConnection)
    );
    assert_eq!(h.bound(&s, "pc-old"), Err(ReadOnlyError::StaleConnection));
    assert_eq!(
        h.bound(&s, "pc-1").unwrap(),
        vec![MediaEffect::StartCapture {
            connection_id: "pc-1".into(),
            display_id: "display-1".into()
        }]
    );
    assert!(h.may_send_frame(&s, "pc-1", 0));
    let revision = h.revision();
    assert!(h.bound(&s, "pc-1").unwrap().is_empty());
    assert_eq!(revision, h.revision());
    assert!(!h.may_send_frame(&source("desktop"), "pc-1", 0));
}

#[test]
fn lost_attach_ack_live_retry_precedes_cas_without_creating_a_second_peer() {
    let mut h = host();
    let s = source("phone");
    let req = request(&h, "attach", "display-1");
    h.attach(&s, &req, "pc-1").unwrap();
    let revision = h.revision();
    assert!(h.attach(&s, &req, "pc-never-created").unwrap().is_empty());
    assert_eq!(revision, h.revision());
    assert_eq!(
        h.snapshot(&s).unwrap().attachment.unwrap().connection_id,
        "pc-1"
    );
    let mut changed = req.clone();
    changed.display_id = "display-2".into();
    assert_eq!(
        h.attach(&s, &changed, "pc-new"),
        Err(ReadOnlyError::AttachIdConflict)
    );
    assert_eq!(
        h.attach(
            &source("desktop"),
            &request(&h, "other", "display-2"),
            "pc-other"
        ),
        Err(ReadOnlyError::AttachmentBusy)
    );
    let other = h.snapshot(&source("desktop")).unwrap();
    assert!(other.busy);
    assert!(
        other.attachment.is_none(),
        "other viewer cannot learn connection/display IDs"
    );
}

#[test]
fn local_stop_fences_delayed_attach_and_cleanup_must_finish_before_reuse() {
    let mut h = host();
    let s = source("phone");
    let stale = request(&h, "attach", "display-1");
    h.attach(&s, &stale, "pc-1").unwrap();
    h.bound(&s, "pc-1").unwrap();
    assert_eq!(
        h.stop().unwrap(),
        vec![MediaEffect::Close {
            connection_id: "pc-1".into()
        }]
    );
    assert!(!h.may_send_frame(&s, "pc-1", 0));
    assert_eq!(
        h.attach(&s, &request(&h, "new", "display-1"), "pc-2"),
        Err(ReadOnlyError::CleanupPending)
    );
    h.media_closed("not-the-retiring-peer").unwrap();
    assert!(h.snapshot(&s).unwrap().cleanup_pending);
    h.media_closed("pc-1").unwrap();
    assert_eq!(
        h.attach(&s, &stale, "pc-2"),
        Err(ReadOnlyError::StaleRevision)
    );
    h.attach(&s, &request(&h, "new", "display-1"), "pc-2")
        .unwrap();
    h.media_closed("pc-1").unwrap();
    h.detach(&s, "attach").unwrap();
    assert_eq!(
        h.snapshot(&s).unwrap().attachment.unwrap().connection_id,
        "pc-2"
    );
}

#[test]
fn empty_slot_stop_and_process_restart_also_fence_old_attach() {
    let mut h = host();
    let s = source("phone");
    let stale = request(&h, "attach", "display-1");
    h.stop().unwrap();
    assert_eq!(
        h.attach(&s, &stale, "pc"),
        Err(ReadOnlyError::StaleRevision)
    );
    let mut restarted = ReadOnlyHost::new("account".into(), "boot-2".into(), grants()).unwrap();
    assert_eq!(
        restarted.attach(&s, &stale, "pc"),
        Err(ReadOnlyError::StaleRevision)
    );
}

#[test]
fn verified_idle_probe_recovers_relay_loss_and_fences_pre_loss_attach() {
    let mut h = host();
    let s = source("phone");
    let old = request(&h, "old", "display-1");
    h.relay_lost(100);
    let mut stranger = s.clone();
    stranger.public_key_fingerprint = "b".repeat(64);
    assert_eq!(
        h.revalidate_idle_route(&stranger),
        Err(ReadOnlyError::AuthorizationRequired)
    );
    assert_eq!(
        h.attach(&s, &old, "pc-old"),
        Err(ReadOnlyError::RelayUnavailable)
    );
    h.revalidate_idle_route(&s).unwrap();
    assert_eq!(
        h.attach(&s, &old, "pc-old"),
        Err(ReadOnlyError::StaleRevision)
    );
    let revision = h.revision();
    h.revalidate_idle_route(&s).unwrap();
    assert_eq!(h.revision(), revision, "Repeated probes must preserve CAS");
    h.attach(&s, &request(&h, "new", "display-1"), "pc-new")
        .unwrap();
    assert_eq!(
        h.snapshot(&s).unwrap().attachment.unwrap().phase,
        ViewPhase::Binding
    );
    assert!(!h.may_send_frame(&s, "pc-new", 200));
}

#[test]
fn idle_probe_cannot_revalidate_a_live_attachment_or_unfinished_cleanup() {
    let mut h = host();
    let s = source("phone");
    h.attach(&s, &request(&h, "old", "display-1"), "pc-old")
        .unwrap();
    h.bound(&s, "pc-old").unwrap();
    h.relay_lost(100);
    h.revalidate_idle_route(&s).unwrap();
    assert_eq!(
        h.connection_for(&s, "old", "pc-old"),
        Err(ReadOnlyError::RelayUnavailable)
    );
    h.stop().unwrap();
    h.revalidate_idle_route(&s).unwrap();
    assert_eq!(
        h.attach(&s, &request(&h, "new", "display-1"), "pc-new"),
        Err(ReadOnlyError::RelayUnavailable)
    );
    h.media_closed("wrong-pc").unwrap();
    h.revalidate_idle_route(&s).unwrap();
    assert!(h.snapshot(&s).unwrap().cleanup_pending);
    h.media_closed("pc-old").unwrap();
    h.revalidate_idle_route(&s).unwrap();
    h.attach(&s, &request(&h, "new", "display-1"), "pc-new")
        .unwrap();
    h.media_closed("pc-old").unwrap();
    assert_eq!(
        h.snapshot(&s).unwrap().attachment.unwrap().connection_id,
        "pc-new"
    );
}

#[test]
fn grant_revocation_before_bind_or_during_stream_closes_immediately() {
    for bound in [false, true] {
        let mut h = host();
        let s = source("phone");
        h.attach(&s, &request(&h, "attach", "display-1"), "pc")
            .unwrap();
        if bound {
            h.bound(&s, "pc").unwrap();
        }
        assert_eq!(
            h.replace_grants(ViewGrantFile::default()).unwrap(),
            vec![MediaEffect::Close {
                connection_id: "pc".into()
            }]
        );
        assert!(!h.may_send_frame(&s, "pc", 0));
        assert_eq!(h.bound(&s, "pc"), Err(ReadOnlyError::StaleConnection));
    }
}

#[test]
fn relay_loss_does_not_reset_grace_and_blocks_new_binding() {
    let mut h = host();
    let s = source("phone");
    h.attach(&s, &request(&h, "attach", "display-1"), "pc")
        .unwrap();
    h.bound(&s, "pc").unwrap();
    h.relay_lost(100);
    h.relay_lost(29_000);
    assert!(h.may_send_frame(&s, "pc", 30_099));
    assert!(
        !h.may_send_frame(&s, "pc", 30_100),
        "per-frame gate closes even if the watchdog is delayed"
    );
    assert_eq!(
        h.attach(&s, &request(&h, "other", "display-2"), "pc-2"),
        Err(ReadOnlyError::RelayUnavailable)
    );
    assert_eq!(
        h.expire_relay_grace(30_100).unwrap(),
        vec![MediaEffect::Close {
            connection_id: "pc".into()
        }]
    );
    h.relay_revalidated(30_101).unwrap();
    assert!(!h.may_send_frame(&s, "pc", 30_101));
}

#[test]
fn late_authenticated_reconnect_cannot_reopen_an_expired_stream() {
    let mut h = host();
    let s = source("phone");
    h.attach(&s, &request(&h, "attach", "display-1"), "pc")
        .unwrap();
    h.bound(&s, "pc").unwrap();
    h.relay_lost(100);
    assert_eq!(
        h.relay_revalidated(30_100).unwrap(),
        vec![MediaEffect::Close {
            connection_id: "pc".into()
        }]
    );
    assert!(!h.may_send_frame(&s, "pc", 30_101));
    assert!(h.snapshot(&s).unwrap().cleanup_pending);
}

#[test]
fn native_display_ids_are_opaque_and_not_posix_paths() {
    let display = r"\\.\DISPLAY1";
    let mut records = grants();
    records.grants[0].display_ids = vec![display.into()];
    let h = ReadOnlyHost::new("account".into(), "boot".into(), records).unwrap();
    assert!(h.allows(&source("phone"), display));
    assert!(!h.allows(&source("phone"), "\\\\.\\DISPLAY1\n"));
}

#[test]
fn relay_loss_before_bind_never_starts_capture() {
    let mut h = host();
    let s = source("phone");
    h.attach(&s, &request(&h, "attach", "display-1"), "pc")
        .unwrap();
    h.relay_lost(0);
    assert_eq!(h.bound(&s, "pc"), Err(ReadOnlyError::RelayUnavailable));
    assert!(!h.may_send_frame(&s, "pc", 0));
}

#[test]
fn read_only_wire_has_no_input_or_local_approval_operation() {
    for op in [
        "grant",
        "stop",
        "acquire_control",
        "pointer_button",
        "remote_command",
        "invoke",
    ] {
        assert!(serde_json::from_value::<ReadOnlyRequest>(
            serde_json::json!({"version":1,"op":op,"body":{}})
        )
        .is_err());
    }
    let request: ReadOnlyRequest =
        serde_json::from_value(serde_json::json!({"version":1,"op":"attach","body":{
            "attach_id":"a","expected_state_revision":"b:1","display_id":"screen"
        }}))
        .unwrap();
    assert_eq!(request.version, PROTOCOL_VERSION);
    assert!(matches!(request.command, ReadOnlyCommand::Attach(_)));
}

#[test]
fn relay_attachment_header_must_match_the_decrypted_mutation() {
    let attach: ReadOnlyRequest =
        serde_json::from_value(serde_json::json!({"version":1,"op":"attach","body":{
        "attach_id":"attachment-a","expected_state_revision":"boot:0","display_id":"screen"}}))
        .unwrap();
    assert!(attach.matches_route_attachment(Some("attachment-a")));
    assert!(!attach.matches_route_attachment(Some("attachment-b")));
    assert!(!attach.matches_route_attachment(None));
    let detach: ReadOnlyRequest = serde_json::from_value(
        serde_json::json!({"version":1,"op":"detach","body":{"attach_id":"attachment-a"}}),
    )
    .unwrap();
    assert!(detach.matches_route_attachment(Some("attachment-a")));
    assert!(!detach.matches_route_attachment(None));
    let capabilities: ReadOnlyRequest =
        serde_json::from_value(serde_json::json!({"version":1,"op":"capabilities"})).unwrap();
    assert!(capabilities.matches_route_attachment(None));
    assert!(!capabilities.matches_route_attachment(Some("attachment-a")));
    let legacy: ViewGrantFile = serde_json::from_value(serde_json::json!({})).unwrap();
    assert!(legacy.grants.is_empty());
    let notice: RelayNotice = serde_json::from_value(
        serde_json::json!({"version":1,"attachId":"attachment-a","kind":"revoked"}),
    )
    .unwrap();
    assert!(notice.valid());
    assert!(serde_json::from_value::<RelayNotice>(
        serde_json::json!({"version":1,"attachId":"a","kind":"grant_control"})
    )
    .is_err());
}

#[test]
fn answer_is_scoped_to_the_current_authenticated_owner_and_connection() {
    let mut host = host();
    let controller = source("phone");
    let attach = request(&host, "a", "display-1");
    host.attach(&controller, &attach, "pc").unwrap();
    assert!(host.connection_for(&controller, "a", "pc").is_ok());
    for (source, attachment, connection) in [
        (source("desktop"), "a", "pc"),
        (controller.clone(), "old", "pc"),
        (controller.clone(), "a", "old-pc"),
    ] {
        assert_eq!(
            host.connection_for(&source, attachment, connection),
            Err(ReadOnlyError::StaleConnection)
        );
    }
    let message = ReadOnlyRequest {
        version: 1,
        command: ReadOnlyCommand::Signal(AnswerRequest {
            attach_id: "a".into(),
            connection_id: "pc".into(),
            answer_sdp: "private-sdp-content".into(),
        }),
    };
    assert!(message.matches_route_attachment(Some("a")));
    assert!(!message.matches_route_attachment(Some("other")));
    assert!(!message.matches_route_attachment(None));
    assert!(!format!("{message:?}").contains("private-sdp-content"));
    host.relay_lost(0);
    assert_eq!(
        host.connection_for(&controller, "a", "pc"),
        Err(ReadOnlyError::RelayUnavailable)
    );
    host.relay_revalidated(1).unwrap();
    host.stop().unwrap();
    assert_eq!(
        host.connection_for(&controller, "a", "pc"),
        Err(ReadOnlyError::StaleConnection)
    );
}

#[test]
fn legacy_attach_uses_default_ice_policy_and_live_retry_cannot_change_it() {
    let mut host = host();
    let mut legacy:AttachRequest=serde_json::from_value(serde_json::json!({"attach_id":"a","expected_state_revision":host.revision(),"display_id":"display-1"})).unwrap();
    assert!(!legacy.force_relay);
    let old = serde_json::to_value(&legacy).unwrap();
    assert!(old.get("force_relay").is_none());
    assert!(
        !serde_json::from_value::<AttachRequest>(old)
            .unwrap()
            .force_relay
    );
    host.attach(&source("phone"), &legacy, "pc").unwrap();
    legacy.force_relay = true;
    assert_eq!(
        host.attach(&source("phone"), &legacy, "other-pc"),
        Err(ReadOnlyError::AttachIdConflict)
    );
}
