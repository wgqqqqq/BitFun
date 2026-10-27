//! Explicitly authorized display -> production sender -> shared browser receiver.
//! Private file signaling is test-only; no account, grants or OS input.
use super::*;
use serde_json::{json, Value};
use std::{fs::OpenOptions, io::Write, os::unix::fs::OpenOptionsExt, path::Path};

#[derive(Deserialize)]
struct ProbeIceServer {
    urls: Vec<String>,
    username: String,
    credential: String,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct ProbeConfiguration {
    ice_servers: Vec<ProbeIceServer>,
    receiver_ice_servers: Vec<Value>,
    force_relay: bool,
    phone: bool,
}

async fn selected_pair(sender: &Connection) -> Value {
    use libwebrtc::stats::RtcStats;
    let stats = sender.peer.get_stats().await.unwrap();
    let selected = stats
        .iter()
        .find_map(|value| match value {
            RtcStats::Transport(value)
                if !value.transport.selected_candidate_pair_id.is_empty() =>
            {
                Some(value.transport.selected_candidate_pair_id.as_str())
            }
            _ => None,
        })
        .expect("No selected native candidate pair");
    let pair = stats
        .iter()
        .find_map(|value| match value {
            RtcStats::CandidatePair(value) if value.rtc.id == selected => {
                Some(&value.candidate_pair)
            }
            _ => None,
        })
        .unwrap();
    let local = stats
        .iter()
        .find_map(|value| match value {
            RtcStats::LocalCandidate(value) if value.rtc.id == pair.local_candidate_id => {
                Some(&value.local_candidate)
            }
            _ => None,
        })
        .unwrap();
    let remote = stats
        .iter()
        .find_map(|value| match value {
            RtcStats::RemoteCandidate(value) if value.rtc.id == pair.remote_candidate_id => {
                Some(&value.remote_candidate)
            }
            _ => None,
        })
        .unwrap();
    // Keep address, port, URL, ufrag, certificate and SDP out of diagnostics.
    json!({"local_type":local.candidate_type.map(|kind| format!("{kind:?}").to_lowercase()),
        "remote_type":remote.candidate_type.map(|kind| format!("{kind:?}").to_lowercase()),
        "relay_protocol":local.relay_protocol.map(|kind| format!("{kind:?}").to_lowercase()),
        "bytes_sent":pair.bytes_sent,"bytes_received":pair.bytes_received})
}

fn publish(directory: &Path, name: &str, value: Value) {
    let temporary = directory.join(format!(".{name}"));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .unwrap();
    file.write_all(&serde_json::to_vec(&value).unwrap())
        .unwrap();
    std::fs::rename(temporary, directory.join(name)).unwrap();
}

async fn wait_file(directory: &Path, name: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            assert!(!directory.join("cancel").exists(), "Native probe cancelled");
            match std::fs::read(directory.join(name)) {
                Ok(bytes) => return serde_json::from_slice(&bytes).unwrap(),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => panic!("Private probe receipt failed: {error}"),
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("Native probe signaling deadline expired")
}

#[tokio::test]
#[ignore = "Requires explicit selected-display authorization and shared receiver runner"]
async fn native_remote_desktop_capture_to_shared_receiver_and_source_stop() {
    assert_eq!(
        std::env::var("OPENBITFUN_RD_CAPTURE_AUTHORIZED").as_deref(),
        Ok("1")
    );
    assert_eq!(super::super::macos_capture::availability(), "ready");
    let display = std::env::var("OPENBITFUN_RD_CAPTURE_DISPLAY").unwrap();
    let directory = std::env::var("OPENBITFUN_RD_MEDIA_PROBE_DIRECTORY").unwrap();
    let directory = Path::new(&directory);
    let target = super::super::displays::resolve(&display).unwrap();
    let config: ProbeConfiguration = std::env::var("OPENBITFUN_RD_NATIVE_MEDIA_CONFIG")
        .ok()
        .map(|path| serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap())
        .unwrap_or_default();
    let servers = config
        .ice_servers
        .into_iter()
        .map(|server| IceServer {
            urls: server.urls,
            username: server.username,
            password: server.credential,
        })
        .collect();
    let failed = Arc::new(AtomicBool::new(false));
    let failure = failed.clone();
    let engine = Engine::new();
    let mut sender = engine
        .prepare(
            "native-probe-attachment",
            "native-probe-connection",
            servers,
            config.force_relay,
            VideoConfig {
                resolution: VideoResolution {
                    width: target.width,
                    height: target.height,
                },
                quality: QualityPreset::default(),
            },
            move |event| {
                if matches!(
                    event,
                    Event::CaptureFailed | Event::GeometryChanged | Event::HostLocked
                ) {
                    failure.store(true, Ordering::Release);
                }
            },
        )
        .unwrap();
    if config.force_relay {
        // Trial network/allocation budget, not a product quality profile.
        sender
            .peer
            .set_bitrate(BitrateSettings {
                min_bitrate_bps: None,
                start_bitrate_bps: Some(350_000),
                max_bitrate_bps: Some(350_000),
            })
            .unwrap();
    }
    publish(
        directory,
        "offer.json",
        json!({"kind":"start","renderer_id":"native-probe-renderer",
        "attach_id":"native-probe-attachment","connection_id":"native-probe-connection",
        "offer_sdp":sender.offer().await.unwrap(),"ice_servers":config.receiver_ice_servers,"force_relay":config.force_relay}),
    );
    let answer = wait_file(directory, "answer.json").await;
    sender
        .answer(answer["answer_sdp"].as_str().unwrap())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while !sender.bound() {
            assert!(!sender.closed() && !directory.join("cancel").exists());
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(sender.submitted_frames(), 0);
    publish(
        directory,
        "state.json",
        json!({"phase":"awaiting_source","submitted":0}),
    );
    wait_file(directory, "capture.json").await;
    sender = tokio::task::spawn_blocking(move || {
        sender
            .start_capture(target.id, &target.uuid, || true)
            .unwrap();
        sender
    })
    .await
    .unwrap();
    let started = Instant::now();
    let mut samples = Vec::new();
    while started.elapsed() < Duration::from_secs(8) {
        assert!(!failed.load(Ordering::Acquire) && !sender.closed());
        assert!(!directory.join("cancel").exists());
        sender.probe_health();
        let sample = json!({"phase":"capture","elapsed_ms":started.elapsed().as_millis(),
            "submitted":sender.submitted_frames(),"health":sender.health_status()});
        samples.push(sample.clone());
        publish(directory, "state.json", sample);
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(
        sender.submitted_frames() > 0,
        "No actual native source submissions"
    );
    assert!(samples
        .iter()
        .any(|sample| sample["health"]["receiver_observed"] == true));
    assert!(
        samples
            .iter()
            .any(|sample| sample["health"]["candidate"] == true),
        "No positive diagnostic observation from both actual source and receiver"
    );
    let pair = selected_pair(&sender).await;
    if config.force_relay {
        assert_eq!(pair["local_type"], "relay");
        assert_eq!(pair["remote_type"], "relay");
    }
    // Fault injection: drain only the real capture source while keeping the
    // bound PC/DC alive. Silence must expire, never become synthetic idle.
    sender = tokio::task::spawn_blocking(move || {
        assert!(sender.capture.as_mut().unwrap().close());
        sender
    })
    .await
    .unwrap();
    let stopped_frames = sender.submitted_frames();
    let stopped = Instant::now();
    while stopped.elapsed() < Duration::from_secs(9) {
        assert!(!directory.join("cancel").exists());
        assert!(
            sender.bound() && !sender.closed(),
            "Transport did not survive source-only stop"
        );
        assert_eq!(sender.submitted_frames(), stopped_frames);
        sender.probe_health();
        let sample = json!({"phase":"source_stopped","elapsed_ms":started.elapsed().as_millis(),
            "submitted":sender.submitted_frames(),"health":sender.health_status()});
        samples.push(sample.clone());
        publish(directory, "state.json", sample);
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let expired = sender.health_status();
    assert_eq!(expired["source_activity"], "unknown");
    assert_eq!(expired["candidate"], false);
    assert_eq!(
        expired["receiver_observed"], true,
        "Fresh receiver replies must not hide missing source"
    );
    let drained = tokio::task::spawn_blocking(move || sender.close())
        .await
        .unwrap();
    assert!(drained);
    publish(
        directory,
        "result.json",
        json!({"scope":"selected macOS display -> production native sender -> shared receiver; fixture signaling, no account or input",
        "phone":config.phone,"force_relay":config.force_relay,"selected_pair":pair,
        "display_id":display,"submitted":stopped_frames,"drained":drained,"expired_health":expired,"samples":samples}),
    );
    publish(
        directory,
        "state.json",
        json!({"phase":"closed","drained":drained}),
    );
}
