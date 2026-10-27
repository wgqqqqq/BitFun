use super::*;
use openbitfun_product_domains::remote_desktop::{AttachRequest, ReadOnlyHost, ViewGrant};
use std::time::Duration;

fn fixture() -> (RemoteDesktopState, ControllerIdentity, u64) {
    let generation = crate::remote_desktop::connection::generation();
    let source = ControllerIdentity {
        account_id: "account".into(),
        device_id: "phone".into(),
        public_key_fingerprint: "a".repeat(64),
    };
    let mut policy = ReadOnlyHost::new(
        "account".into(),
        "boot".into(),
        ViewGrantFile {
            grants: vec![ViewGrant {
                account_id: source.account_id.clone(),
                device_id: source.device_id.clone(),
                public_key_fingerprint: source.public_key_fingerprint.clone(),
                display_ids: vec!["screen".into(), "screen-2".into()],
                control_display_ids: Vec::new(),
            }],
            ..Default::default()
        },
    )
    .unwrap();
    policy
        .attach(
            &source,
            &AttachRequest {
                attach_id: "a".into(),
                expected_state_revision: policy.revision(),
                display_id: "screen".into(),
                force_relay: true,
            },
            "pc",
        )
        .unwrap();
    let relay = RelayContext {
        relay_url: "http://127.0.0.1:1".into(),
        session: openbitfun_services_integrations::remote_connect::account::AccountSession::new(
            "fixture".into(),
            "account".into(),
            [7; 32],
        ),
        host_device_id: "host".into(),
        service_connection_id: 1,
        capabilities: vec![
            "remote_desktop_turn_v1".into(),
            "remote_desktop_credential_binding_v1".into(),
        ],
    };
    let state = RemoteDesktopState::default();
    *state.0.lock().unwrap() = Some(Host {
        account_generation: generation,
        policy,
        store: None,
        started: Instant::now(),
        credential_binding: Some("a".repeat(64)),
        relay: Some(relay.clone()),
        failure: None,
    });
    state
        .1
        .reserve(media_session::PendingMedia {
            generation,
            socket_generation: 1,
            relay,
            source: source.clone(),
            attach_id: "a".into(),
            connection_id: "pc".into(),
            target: target(),
            force_relay: true,
            quality: Default::default(),
            owner: Arc::downgrade(&state.0),
        })
        .unwrap();
    (state, source, generation)
}

fn target() -> displays::CaptureTarget {
    displays::CaptureTarget {
        id: 0,
        uuid: "not-a-real-display".into(),
        width: 800,
        height: 600,
    }
}

fn request(host: &Host) -> SourceRequest {
    SourceRequest {
        attach_id: "a".into(),
        expected_state_revision: host.policy.revision(),
    }
}

async fn pause(state: &RemoteDesktopState, source: &ControllerIdentity) {
    {
        let mut owner = state.0.lock().unwrap();
        let host = owner.as_mut().unwrap();
        let request = request(host);
        let reply = state.suspend_source(host, source, request);
        assert!(reply.body.get("error").is_none());
        assert_eq!(reply.body["state"]["attachment"]["phase"], "suspended");
        assert!(
            reply.attachment.is_none(),
            "Do not request Relay binding during old native drain"
        );
    }
    tokio::time::timeout(Duration::from_secs(2), async {
        while state.1.cleaning() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(state.1.retained(source, "a", "pc").is_ok());
}

async fn close(state: &RemoteDesktopState) {
    state.retire();
    tokio::time::timeout(Duration::from_secs(2), async {
        while state.1.occupied() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn source_pause_and_resume_bind_a_fresh_pc_with_the_original_ice_policy() {
    let (state, source, _) = fixture();
    pause(&state, &source).await;
    {
        let mut owner = state.0.lock().unwrap();
        let host = owner.as_mut().unwrap();
        // The resolver boundary is intentionally a fake display. No ready
        // notice is delivered, so this fixture never starts SDK/capture/input.
        let mut value = serde_json::to_value(request(host)).unwrap();
        value["force_relay"] = json!(false);
        let reply = state.prepare_resumed_source(
            host,
            &source,
            serde_json::from_value(value).unwrap(),
            2,
            target(),
        );
        assert!(reply.body.get("error").is_none());
        assert_eq!(reply.body["state"]["attachment"]["attach_id"], "a");
        assert_eq!(reply.body["state"]["attachment"]["phase"], "binding");
        let pc = reply.body["state"]["attachment"]["connection_id"]
            .as_str()
            .unwrap();
        assert_ne!(pc, "pc");
        let slot = state.1.current(&source, pc).unwrap();
        assert!(slot.force_relay());
        assert_eq!(slot.display_id(), "macos:not-a-real-display");
        assert_eq!(slot.status()["source_first_frame"], false);
        assert!(matches!(
            reply.attachment,
            Some(AttachmentReply {
                disposition: AttachmentDisposition::Accepted,
                ..
            })
        ));
    }
    close(&state).await;
}

#[tokio::test]
async fn source_quality_uses_the_authenticated_route_and_applies_only_to_a_new_pc() {
    use openbitfun_product_domains::remote_desktop::{QualityPreset, SetQualityRequest};
    let (state, source, generation) = fixture();
    pause(&state, &source).await;
    let revision = state.0.lock().unwrap().as_ref().unwrap().policy.revision();
    let command = || ReadOnlyRequest {
        version: 1,
        command: ReadOnlyCommand::SetQuality(SetQualityRequest {
            attach_id: "a".into(),
            expected_state_revision: revision.clone(),
            quality: QualityPreset::Clear,
        }),
    };
    let wrong_route = state
        .handle(
            generation,
            2,
            &source,
            command(),
            Some("other"),
            Some(&"a".repeat(64)),
        )
        .await;
    assert_eq!(wrong_route.body["error"]["code"], "invalid_request");
    let reply = state
        .handle(
            generation,
            2,
            &source,
            command(),
            Some("a"),
            Some(&"a".repeat(64)),
        )
        .await;
    assert!(reply.body.get("error").is_none());
    assert_eq!(reply.body["state"]["attachment"]["quality"], "clear");
    assert_eq!(reply.body["state"]["attachment"]["phase"], "suspended");
    assert!(
        reply.attachment.is_none(),
        "Preference must not renew Relay/media authority"
    );
    {
        let mut owner = state.0.lock().unwrap();
        let host = owner.as_mut().unwrap();
        let resume = request(host);
        let resumed = state.prepare_resumed_source(host, &source, resume, 2, target());
        assert!(resumed.body.get("error").is_none());
        let pc = resumed.body["state"]["attachment"]["connection_id"]
            .as_str()
            .unwrap();
        let slot = state.1.current(&source, pc).unwrap();
        assert_ne!(pc, "pc");
        assert!(slot.force_relay());
        assert_eq!(slot.status()["quality"], "clear");
        assert_eq!(slot.status()["source_first_frame"], false);
    }
    // No ready notice: this fixture never starts SDK/capture or injects input.
    close(&state).await;
}

#[tokio::test]
async fn source_resume_stale_cas_or_identity_does_not_consume_the_retained_slot() {
    let (state, source, _) = fixture();
    pause(&state, &source).await;
    {
        let mut owner = state.0.lock().unwrap();
        let host = owner.as_mut().unwrap();
        let before = host.policy.snapshot(&source).unwrap();
        let mut stale = request(host);
        stale.expected_state_revision = "old".into();
        assert_eq!(
            state
                .prepare_resumed_source(host, &source, stale, 2, target())
                .body["error"]["code"],
            "stale_revision"
        );
        let wrong = ControllerIdentity {
            public_key_fingerprint: "b".repeat(64),
            ..source.clone()
        };
        let wrong_request = request(host);
        assert!(state
            .prepare_resumed_source(host, &wrong, wrong_request, 2, target())
            .body
            .get("error")
            .is_some());
        assert_eq!(host.policy.snapshot(&source).unwrap(), before);
    }
    assert!(state.1.retained(&source, "a", "pc").is_ok());
    close(&state).await;
}

#[tokio::test]
async fn suspended_state_revalidates_its_route_without_exposing_the_retired_offer() {
    let (state, source, generation) = fixture();
    pause(&state, &source).await;
    let reply = state
        .handle(
            generation,
            2,
            &source,
            ReadOnlyRequest {
                version: 1,
                command: ReadOnlyCommand::GetState,
            },
            Some("a"),
            Some(&"a".repeat(64)),
        )
        .await;
    assert!(reply.body["media"].is_null());
    assert_eq!(reply.body["state"]["attachment"]["phase"], "suspended");
    assert!(matches!(
        reply.attachment,
        Some(AttachmentReply {
            disposition: AttachmentDisposition::Accepted,
            ..
        })
    ));
    close(&state).await;
}

#[tokio::test]
async fn credential_binding_cannot_be_replaced_or_omitted_after_relay_restart() {
    for (suspended, replacement) in [false, true].into_iter().flat_map(|suspended| {
        [Some("b".repeat(64)), Some("A".repeat(64)), None]
            .into_iter()
            .map(move |binding| (suspended, binding))
    }) {
        let (state, source, generation) = fixture();
        if suspended {
            pause(&state, &source).await;
        }
        let request = || ReadOnlyRequest {
            version: 1,
            command: ReadOnlyCommand::GetState,
        };
        let before = state
            .handle(
                generation,
                2,
                &source,
                request(),
                Some("a"),
                Some(&"a".repeat(64)),
            )
            .await;
        assert!(before.body.get("error").is_none());
        assert!(before.attachment.is_some());
        // Same device/key, new server socket and a new credential pair. It
        // must not receive Accepted or restore media authority through Ready.
        let rejected = state
            .handle(
                generation,
                3,
                &source,
                request(),
                Some("a"),
                replacement.as_deref(),
            )
            .await;
        assert_eq!(rejected.body["error"]["code"], "authorization_expired");
        assert!(rejected.attachment.is_none());
        assert!(state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .policy
            .snapshot(&source)
            .unwrap()
            .attachment
            .is_none());
        assert!(!state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .policy
            .may_send_frame(&source, "pc", 0));
        assert!(!state.relay_notice(
            generation,
            3,
            &openbitfun_product_domains::remote_desktop::RelayNotice {
                version: 1,
                attach_id: "a".into(),
                kind: openbitfun_product_domains::remote_desktop::RelayNoticeKind::Ready,
            }
        ));
        close(&state).await;
    }
}

#[tokio::test]
async fn old_relay_keeps_discovery_but_does_not_advertise_media_authority() {
    let (state, _, generation) = fixture();
    state
        .0
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .relay
        .as_mut()
        .unwrap()
        .capabilities
        .retain(|capability| capability != "remote_desktop_credential_binding_v1");
    assert_eq!(state.availability(generation), "relay_upgrade_required");
    close(&state).await;
}

#[tokio::test]
async fn stale_or_unowned_credential_bindings_cannot_stop_the_current_attachment() {
    let (state, source, generation) = fixture();
    pause(&state, &source).await;
    let before = state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .policy
        .snapshot(&source)
        .unwrap();
    let mut stranger = source.clone();
    stranger.device_id = "another-phone".into();
    for (caller, attachment) in [(&source, "old-attachment"), (&stranger, "a")] {
        let response = state
            .handle(
                generation,
                3,
                caller,
                ReadOnlyRequest {
                    version: 1,
                    command: ReadOnlyCommand::GetState,
                },
                Some(attachment),
                Some(&"b".repeat(64)),
            )
            .await;
        assert!(response.attachment.is_none());
        assert_eq!(
            state
                .0
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .policy
                .snapshot(&source)
                .unwrap(),
            before
        );
    }
    close(&state).await;
}

#[tokio::test]
async fn source_selection_noop_and_authorization_failure_preserve_the_current_pc() {
    let (state, source, _) = fixture();
    {
        let mut owner = state.0.lock().unwrap();
        let host = owner.as_mut().unwrap();
        let before = host.policy.snapshot(&source).unwrap();
        let revision = host.policy.revision();
        let reply = state.select_source(
            host,
            &source,
            SelectDisplayRequest {
                attach_id: "a".into(),
                display_id: "screen".into(),
                expected_state_revision: "old-ack".into(),
            },
            "cleanup_pending",
        );
        assert!(reply.body.get("error").is_none());
        let reply = state.select_source(
            host,
            &source,
            SelectDisplayRequest {
                attach_id: "a".into(),
                display_id: "not-authorized".into(),
                expected_state_revision: revision.clone(),
            },
            "ready",
        );
        assert_eq!(reply.body["error"]["code"], "device_approval_required");
        let reply = state.select_source(
            host,
            &source,
            SelectDisplayRequest {
                attach_id: "a".into(),
                display_id: "screen-2".into(),
                expected_state_revision: revision.clone(),
            },
            "permission_required",
        );
        assert_eq!(reply.body["error"]["code"], "permission_required");
        assert_eq!(host.policy.snapshot(&source).unwrap(), before);
    }
    assert!(state.1.current(&source, "pc").is_some());
    close(&state).await;
}

#[tokio::test]
async fn a_live_attach_retry_after_pause_does_not_resolve_or_rewind_the_original_display() {
    let (state, source, generation) = fixture();
    {
        let mut owner = state.0.lock().unwrap();
        let host = owner.as_mut().unwrap();
        let effects = host
            .policy
            .select_display(&source, "a", "screen-2", &host.policy.revision())
            .unwrap();
        state.apply_media(effects);
    }
    tokio::time::timeout(Duration::from_secs(2), async {
        while state.1.cleaning() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let reply = state
        .handle(
            generation,
            2,
            &source,
            ReadOnlyRequest {
                version: 1,
                command: ReadOnlyCommand::Attach(AttachRequest {
                    attach_id: "a".into(),
                    expected_state_revision: "boot:0".into(),
                    display_id: "screen".into(),
                    force_relay: true,
                }),
            },
            Some("a"),
            Some(&"a".repeat(64)),
        )
        .await;
    assert!(reply.body.get("error").is_none());
    assert_eq!(reply.body["state"]["attachment"]["display_id"], "screen-2");
    assert_eq!(reply.body["state"]["attachment"]["phase"], "suspended");
    assert!(state.1.retained(&source, "a", "pc").is_ok());
    close(&state).await;
}
