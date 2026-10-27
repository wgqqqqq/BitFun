use super::*;
use serde_json::{json, Value};

fn fixture() -> (ReadOnlyHost, ControllerIdentity) {
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
                display_ids: vec!["screen".into()],
                control_display_ids: vec!["screen".into()],
            }],
            ..Default::default()
        },
    )
    .unwrap();
    host.attach(
        &source,
        &AttachRequest {
            attach_id: "a".into(),
            expected_state_revision: host.revision(),
            display_id: "screen".into(),
            force_relay: false,
        },
        "old-pc",
    )
    .unwrap();
    host.bound(&source, "old-pc").unwrap();
    (host, source)
}

fn request(host: &ReadOnlyHost, quality: QualityPreset) -> SetQualityRequest {
    SetQualityRequest {
        attach_id: "a".into(),
        expected_state_revision: host.revision(),
        quality,
    }
}

#[test]
fn quality_change_requires_suspension_and_confirmed_drain_then_new_binding() {
    let (mut host, source) = fixture();
    assert_eq!(
        host.set_quality(&source, &request(&host, QualityPreset::Clear)),
        Err(ReadOnlyError::InvalidRequest)
    );
    host.suspend(&source, "a", &host.revision()).unwrap();
    let pending = host.snapshot(&source).unwrap();
    assert_eq!(
        host.set_quality(&source, &request(&host, QualityPreset::Clear)),
        Err(ReadOnlyError::CleanupPending)
    );
    assert_eq!(host.snapshot(&source).unwrap(), pending);
    host.media_closed("old-pc").unwrap();
    let before = host.revision();
    let change = request(&host, QualityPreset::Clear);
    host.set_quality(&source, &change).unwrap();
    assert_ne!(host.revision(), before);
    let changed = host.snapshot(&source).unwrap();
    let attachment = changed.attachment.as_ref().unwrap();
    assert_eq!(attachment.quality, QualityPreset::Clear);
    assert_eq!(attachment.connection_id, "old-pc");
    assert_eq!(attachment.phase, ViewPhase::Suspended);
    assert!(!host.may_send_frame(&source, "old-pc", 0));
    host.set_quality(&source, &change).unwrap(); // same preference is idempotent before CAS
    assert_eq!(host.snapshot(&source).unwrap(), changed);
    host.attach(
        &source,
        &AttachRequest {
            attach_id: "a".into(),
            expected_state_revision: before,
            display_id: "screen".into(),
            force_relay: false,
        },
        "ignored-retry-pc",
    )
    .unwrap();
    assert_eq!(
        host.snapshot(&source).unwrap(),
        changed,
        "Legacy attach retry cannot reset a selected quality or resume media"
    );
    assert_eq!(
        host.set_quality(
            &source,
            &SetQualityRequest {
                quality: QualityPreset::Balanced,
                ..change
            }
        ),
        Err(ReadOnlyError::StaleRevision)
    );
    host.resume(&source, "a", &host.revision(), "new-pc")
        .unwrap();
    assert_eq!(
        host.snapshot(&source).unwrap().attachment.unwrap().quality,
        QualityPreset::Clear
    );
    assert!(!host.may_send_frame(&source, "new-pc", 0));
    assert_eq!(
        host.bound(&source, "old-pc"),
        Err(ReadOnlyError::StaleConnection)
    );
    host.media_closed("old-pc").unwrap();
    assert_eq!(
        host.snapshot(&source)
            .unwrap()
            .attachment
            .unwrap()
            .connection_id,
        "new-pc"
    );
    host.bound(&source, "new-pc").unwrap();
    assert!(host.may_send_frame(&source, "new-pc", 0));
}

#[test]
fn quality_mutations_cannot_cross_account_key_attachment_or_relay_authority() {
    let (mut host, source) = fixture();
    host.suspend(&source, "a", &host.revision()).unwrap();
    host.media_closed("old-pc").unwrap();
    let before = host.snapshot(&source).unwrap();
    for other in [
        ControllerIdentity {
            account_id: "other".into(),
            ..source.clone()
        },
        ControllerIdentity {
            device_id: "other".into(),
            ..source.clone()
        },
        ControllerIdentity {
            public_key_fingerprint: "b".repeat(64),
            ..source.clone()
        },
    ] {
        assert_eq!(
            host.set_quality(&other, &request(&host, QualityPreset::Clear)),
            Err(ReadOnlyError::StaleConnection)
        );
        assert_eq!(host.snapshot(&source).unwrap(), before);
    }
    assert_eq!(
        host.set_quality(
            &source,
            &SetQualityRequest {
                attach_id: "old-attachment".into(),
                ..request(&host, QualityPreset::Clear)
            }
        ),
        Err(ReadOnlyError::StaleConnection)
    );
    host.relay_lost(0);
    assert_eq!(
        host.set_quality(&source, &request(&host, QualityPreset::Clear)),
        Err(ReadOnlyError::RelayUnavailable)
    );
}

#[test]
fn legacy_snapshot_and_attach_round_trip_keep_defaults_and_old_reader_fields() {
    let old =
        json!({"attach_id":"a", "connection_id":"pc", "display_id":"screen", "phase":"streaming"});
    let parsed: AttachmentSnapshot = serde_json::from_value(old.clone()).unwrap();
    assert_eq!(parsed.quality, QualityPreset::DataSaver);
    #[derive(Serialize, Deserialize)]
    struct LegacyAttachment {
        attach_id: String,
        connection_id: String,
        display_id: String,
        phase: String,
    }
    let current = serde_json::to_value(&parsed).unwrap();
    let legacy: LegacyAttachment = serde_json::from_value(current).unwrap();
    assert_eq!(serde_json::to_value(legacy).unwrap(), old);
    let attach = json!({"version":1,"op":"attach","body":{"attach_id":"a","expected_state_revision":"boot:0","display_id":"screen"}});
    let parsed: ReadOnlyRequest = serde_json::from_value(attach.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), attach);
}

#[test]
fn quality_wire_is_closed_and_scoped_to_the_authenticated_outer_attachment() {
    for quality in ["data_saver", "balanced", "clear"] {
        let body = json!({"version":1,"op":"set_quality","body":{"attach_id":"a","expected_state_revision":"boot:3","quality":quality}});
        let parsed: ReadOnlyRequest = serde_json::from_value(body.clone()).unwrap();
        assert!(parsed.matches_route_attachment(Some("a")));
        assert!(!parsed.matches_route_attachment(None));
        assert!(!parsed.matches_route_attachment(Some("other")));
        assert_eq!(serde_json::to_value(parsed).unwrap(), body);
    }
    for quality in [
        Value::Null,
        json!("ultra"),
        json!(12),
        json!({"max_bitrate":u64::MAX}),
    ] {
        assert!(serde_json::from_value::<ReadOnlyRequest>(json!({"version":1,"op":"set_quality","body":{"attach_id":"a","expected_state_revision":"boot:3","quality":quality}})).is_err());
    }
}

#[test]
fn capture_limits_preserve_orientation_round_even_and_do_not_upscale_or_overflow() {
    assert_eq!(
        QualityPreset::DataSaver.capture_size(3840, 2160),
        Some((1280, 720))
    );
    assert_eq!(
        QualityPreset::Balanced.capture_size(3840, 2160),
        Some((1920, 1080))
    );
    assert_eq!(
        QualityPreset::Clear.capture_size(3840, 2160),
        Some((2560, 1440))
    );
    assert_eq!(
        QualityPreset::Clear.capture_size(2160, 3840),
        Some((1440, 2560))
    );
    assert_eq!(
        QualityPreset::Clear.capture_size(801, 601),
        Some((800, 600))
    );
    assert_eq!(
        QualityPreset::Balanced.capture_size(3840, 1080),
        Some((1920, 540))
    );
    assert_eq!(
        QualityPreset::DataSaver.capture_size(u64::MAX, u64::MAX),
        Some((1080, 1080))
    );
    assert_eq!(QualityPreset::Clear.capture_size(0, 1), None);
    for quality in [
        QualityPreset::DataSaver,
        QualityPreset::Balanced,
        QualityPreset::Clear,
    ] {
        let settings = quality.settings();
        assert!(settings.start_bitrate_bps <= settings.max_bitrate_bps);
        for (w, h) in [
            (1512, 982),
            (982, 1512),
            (2, u64::MAX),
            (u64::MAX, 2),
            (2, 2),
        ] {
            let (cw, ch) = quality.capture_size(w, h).unwrap();
            assert!(u64::from(cw) <= w && u64::from(ch) <= h);
            assert_eq!((cw % 2, ch % 2), (0, 0));
            assert!(cw.max(ch) <= settings.long_edge && cw.min(ch) <= settings.short_edge);
        }
    }
}
