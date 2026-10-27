use super::*;

#[test]
fn native_quality_presets_reach_sdk_encoding_and_capture_configuration_without_pixels() {
    let engine = Engine::new();
    for (quality, bitrate, fps, size) in [
        (QualityPreset::DataSaver, 1_200_000, 15, (1280, 720)),
        (QualityPreset::DataSaver, 1_200_000, 15, (720, 1280)),
        (QualityPreset::Balanced, 4_000_000, 30, (1920, 1080)),
        (QualityPreset::Balanced, 4_000_000, 30, (1080, 1920)),
        (QualityPreset::Clear, 8_000_000, 30, (2560, 1440)),
        (QualityPreset::Clear, 8_000_000, 30, (1440, 2560)),
    ] {
        super::super::capture::DisplayCapture::validate_output_geometry(size.0, size.1, fps)
            .expect(
                "Negotiated quality must reach the native capture boundary in either orientation",
            );
        let mut sender = engine
            .prepare(
                "quality-attachment",
                "quality-pc",
                vec![],
                false,
                VideoConfig {
                    resolution: VideoResolution {
                        width: size.0,
                        height: size.1,
                    },
                    quality,
                },
                |_| {},
            )
            .unwrap();
        let senders = sender.peer.senders();
        assert_eq!(senders.len(), 1);
        let parameters = senders[0].parameters();
        assert_eq!(parameters.encodings.len(), 1);
        assert_eq!(parameters.encodings[0].max_bitrate, Some(bitrate));
        assert_eq!(parameters.encodings[0].max_framerate, Some(f64::from(fps)));
        assert_eq!(sender.max_fps, fps);
        assert!(sender.capture.is_none());
        assert_eq!(sender.submitted_frames(), 0);
        assert!(sender.close());
    }
    assert!(engine
        .prepare(
            "quality-attachment",
            "quality-pc",
            vec![],
            false,
            VideoConfig {
                resolution: VideoResolution {
                    width: 3840,
                    height: 2160
                },
                quality: QualityPreset::DataSaver
            },
            |_| {}
        )
        .is_err());
}

#[test]
fn dropped_native_sample_cannot_extend_idle_beyond_the_resume_budget() {
    let health = Mutex::new(MediaHealth::default());
    let samples = AtomicU64::new(0);
    observe_native_sample(&health, &samples, 0);
    let receive = |health: &mut MediaHealth, now| {
        let probe = health.probe(now).unwrap();
        assert!(health.receive(
            ReceiverHealth {
                version: 1,
                kind: "health_reply".into(),
                echo: probe.echo,
                first_frame: true,
                visible: true,
                focused: true,
                receiving: true,
                decoded: 1,
                presented: 1,
            },
            now + 1
        ));
    };
    {
        let mut health = health.lock().unwrap();
        receive(&mut health, 0);
        health.source_idle(6000);
        receive(&mut health, 6000);
        assert!(health.candidate(6001, true));
    }
    // A newly captured sample exists, but it was not encoded/delivered. Its
    // bounded resume budget cannot be extended by further idle observations.
    observe_native_sample(&health, &samples, 8000);
    let mut health = health.lock().unwrap();
    health.source_idle(8000);
    receive(&mut health, 8000);
    assert_eq!(samples.load(Ordering::Relaxed), 2);
    assert!(health.candidate(8001, true));
    for now in [10000, 12000, 14000] {
        health.source_idle(now);
        receive(&mut health, now);
    }
    assert!(!health.candidate(14001, true));
}
use libwebrtc::peer_connection::AnswerOptions;

#[test]
fn gathered_candidates_cannot_inject_sdp_or_cross_media_sections() {
    let original = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\na=candidate:old\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:1\r\n";
    for candidate in [
        (-1, "candidate:a"),
        (2, "candidate:a"),
        (0, "candidate:a\r\na=sendrecv"),
        (0, "a=candidate:a"),
    ] {
        assert!(gathered_sdp(original, &[(candidate.0, candidate.1.into())]).is_err());
    }
    let result = gathered_sdp(
        original,
        &[(0, "candidate:video".into()), (1, "candidate:data".into())],
    )
    .unwrap();
    assert!(!result.contains("candidate:old"));
    let sections: Vec<_> = result.split("m=").collect();
    assert!(sections[1].contains("candidate:video"));
    assert!(!sections[1].contains("candidate:data"));
    assert!(sections[2].contains("candidate:data"));
}

// Real native PeerConnections over host ICE only. No OS capture, TURN, account
// credentials, private pixels or input. This establishes transport binding,
// not product authorization or phone/compositor media evidence.
#[tokio::test]
async fn native_connection_requires_exact_channel_binding_and_local_frame_gate() {
    native_connection_roundtrip().await;
}

#[tokio::test]
#[ignore = "Run through the SDK stdout/stderr privacy runner in an isolated process"]
async fn native_datachannel_payloads_stay_out_of_sdk_logs() {
    // Exercise the SDK with diagnostics enabled, as in the Desktop debug host.
    // Without a logger, upstream can hide textual payloads and the regression
    // would pass without covering the actual application logging path.
    struct SdkDiagnostics;
    impl log::Log for SdkDiagnostics {
        fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
            metadata.target() == "libwebrtc"
        }
        fn log(&self, record: &log::Record<'_>) {
            if self.enabled(record.metadata()) {
                println!("SDK {}", record.args());
            }
        }
        fn flush(&self) {}
    }
    static SDK_DIAGNOSTICS: SdkDiagnostics = SdkDiagnostics;
    log::set_logger(&SDK_DIAGNOSTICS).expect("SDK fixture requires an isolated logger");
    log::set_max_level(log::LevelFilter::Trace);
    native_connection_roundtrip().await;
}

async fn native_connection_roundtrip() {
    let engine = Engine::new();
    let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
    let mut sender = engine
        .prepare(
            "attachment",
            "connection",
            vec![],
            false,
            VideoConfig {
                resolution: VideoResolution {
                    width: 1280,
                    height: 720,
                },
                quality: QualityPreset::default(),
            },
            move |event| {
                let _ = events.send(event);
            },
        )
        .unwrap();
    assert!(sender.start_capture(0, "not-a-display", || true).is_err());
    assert!(sender.capture.is_none());
    let (control_messages, mut controls) = tokio::sync::mpsc::unbounded_channel();
    let (control_health, control_send) = sender.control_endpoint(move |bytes| {
        if openbitfun_product_domains::remote_desktop::control::ControlMessage::parse(bytes).is_ok()
        {
            let _ = control_messages.send(bytes.to_vec());
        }
    });
    let offer = sender.offer().await.unwrap();
    assert_eq!(sender.offer().await.unwrap(), offer);
    assert_eq!(offer.matches("m=video ").count(), 1);
    assert_eq!(offer.matches("m=application ").count(), 1);
    assert!(!offer.contains("m=audio "));

    let factory = PeerConnectionFactory::default();
    factory.set_adm_recording_enabled(false);
    factory.set_adm_playout_enabled(false);
    let mut config = RtcConfiguration::default();
    config.continual_gathering_policy = ContinualGatheringPolicy::GatherOnce;
    let receiver = factory.create_peer_connection(config).unwrap();
    let candidates = Arc::new(Mutex::new(Vec::new()));
    let gathered = candidates.clone();
    receiver.on_ice_candidate(Some(Box::new(move |candidate| {
        gathered
            .lock()
            .unwrap()
            .push((candidate.sdp_mline_index(), candidate.to_string()));
    })));
    let (channels, mut channel_receiver) = tokio::sync::mpsc::unbounded_channel();
    receiver.on_data_channel(Some(Box::new(move |channel| {
        let _ = channels.send(channel);
    })));
    receiver
        .set_remote_description(SessionDescription::parse(&offer, SdpType::Offer).unwrap())
        .await
        .unwrap();
    let answer = receiver
        .create_answer(AnswerOptions::default())
        .await
        .unwrap();
    receiver
        .set_local_description(answer.clone())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while receiver.ice_gathering_state() != IceGatheringState::Complete {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let answer = gathered_sdp(&answer.to_string(), &candidates.lock().unwrap()).unwrap();
    sender.answer(&answer).await.unwrap();
    sender.answer(&answer).await.unwrap();
    assert!(sender
        .answer(&(answer.clone() + "a=unexpected:change\r\n"))
        .await
        .is_err());
    let channel = tokio::time::timeout(Duration::from_secs(10), channel_receiver.recv())
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while channel.state() != DataChannelState::Open {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(channel.label(), "rd");
    let valid =
        br#"{"version":1,"kind":"bind","attach_id":"attachment","connection_id":"connection"}"#;
    channel.send(valid, true).unwrap(); // binary is not a valid bind
    let acquire = br#"{"version":1,"request_id":"r1","kind":"acquire_control","body":{"expected_state_revision":"boot:1"}}"#;
    channel.send(acquire, false).unwrap(); // Before binding: no control endpoint.
    channel.send(br#"{"version":1,"kind":"bind","attach_id":"attachment","connection_id":"old-connection"}"#, false).unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(!sender.callbacks.notified.load(Ordering::Acquire));
    assert!(controls.try_recv().is_err());
    channel.send(valid, false).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if matches!(received.recv().await, Some(Event::Bound)) {
                break;
            }
        }
    })
    .await
    .unwrap();
    channel.send(acquire, false).unwrap();
    tokio::time::timeout(Duration::from_secs(5), controls.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        !control_health(),
        "a bound channel without actual source/presentation is not control health"
    );
    assert!(sender.start_capture(0, "not-a-display", || false).is_err());
    assert!(sender.capture.is_none());
    assert_eq!(sender.forwarded.load(Ordering::Relaxed), 0);
    // This is a transport-only canary: the fixture callback is an in-memory
    // sink and never instantiates a lease worker or OS input provider.
    let private_input = br#"{"control_generation":"1","kind":"text_commit","body":{"text":"rd-private-client-payload"}}"#;
    channel.send(private_input, false).unwrap();
    let delivered = tokio::time::timeout(Duration::from_secs(5), controls.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(delivered, private_input);
    let (probes, mut health_probes) = tokio::sync::mpsc::unbounded_channel();
    channel.on_message(Some(Box::new(move |data| {
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(data.data) {
            let _ = probes.send(value);
        }
    })));
    assert!(control_send(
        serde_json::json!({"version":1,"kind":"control_result","request_id":"rd-private-host-payload","code":"control_not_ready"})
    ));
    let result = tokio::time::timeout(Duration::from_secs(5), health_probes.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result["code"], "control_not_ready");
    assert_eq!(result["request_id"], "rd-private-host-payload");
    println!("RD_LOG_PRIVACY_PAYLOADS_DELIVERED");
    sender.probe_health();
    let probe = tokio::time::timeout(Duration::from_secs(5), health_probes.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(probe["kind"], "health_probe");
    let response = serde_json::json!({"version":1,"kind":"health_reply","echo":probe["echo"],
        "first_frame":false,"visible":true,"focused":true,"receiving":false,"decoded":"0","presented":"0"});
    channel
        .send(&serde_json::to_vec(&response).unwrap(), false)
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while sender.health_status()["receiver_observed"] != true {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(sender.health_status()["source_activity"], "unknown");
    assert_eq!(
        sender.health_status()["candidate"],
        false,
        "live transport alone cannot grant input health"
    );
    assert!(sender.close());
    assert!(!control_send(serde_json::json!({"kind":"control_result"})));
    assert!(sender.close());
    assert!(sender.offer().await.is_err());
    assert!(sender.answer(&answer).await.is_err());
    receiver.close();
}
