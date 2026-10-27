//! Isolated macOS media risk probe. Never links account state or OS input.
#[cfg(not(target_os = "macos"))]
compile_error!("The isolated native media probe currently supports macOS only");
use libwebrtc::{
    data_channel::{DataChannel, DataChannelInit, DataChannelState},
    media_stream_track::MediaStreamTrack,
    peer_connection::{BitrateSettings, IceGatheringState, OfferOptions, PeerConnection},
    peer_connection_factory::{
        native::PeerConnectionFactoryExt, ContinualGatheringPolicy, IceServer, IceTransportsType,
        PeerConnectionFactory, RtcConfiguration,
    },
    rtp_parameters::RtpEncodingParameters,
    rtp_sender::VideoEncoderBackend,
    rtp_transceiver::{RtpTransceiverDirection, RtpTransceiverInit},
    session_description::{SdpType, SessionDescription},
    video_frame::{native::NativeBuffer, VideoFrame, VideoRotation},
    video_source::{native::NativeVideoSource, VideoResolution},
    MediaType,
};
use serde_json::{json, Value};
use std::{
    ffi::{c_char, c_void, CStr},
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::runtime::Runtime;

const API: &str = "http://127.0.0.1:18765/api/";
fn gathered_sdp(original: &str, candidates: &[(i32, String)]) -> Result<String, String> {
    let sections = original
        .lines()
        .filter(|line| line.starts_with("m="))
        .count() as i32;
    if candidates.is_empty()
        || candidates.iter().any(|(i, s)| {
            *i < 0 || *i >= sections || !s.starts_with("candidate:") || s.contains(['\r', '\n'])
        })
    {
        return Err("Invalid or missing gathered candidates".into());
    }
    let mut result = String::new();
    let mut section = -1;
    for line in original.lines() {
        if line.starts_with("m=") {
            section += 1;
        }
        // Some SDK revisions may update the original description while gathering.
        if line.starts_with("a=candidate:") || line == "a=end-of-candidates" {
            continue;
        }
        result.push_str(line);
        result.push_str("\r\n");
        if line.starts_with("a=mid:") {
            for (_, candidate) in candidates.iter().filter(|(i, _)| *i == section) {
                result.push_str("a=");
                result.push_str(candidate);
                result.push_str("\r\n");
            }
            result.push_str("a=end-of-candidates\r\n");
        }
    }
    Ok(result)
}
#[link(name = "CoreVideo", kind = "framework")]
extern "C" {
    fn CVPixelBufferRetain(buffer: *mut c_void) -> *mut c_void;
}
struct Probe {
    runtime: Runtime,
    peer: PeerConnection,
    channel: DataChannel,
    source: NativeVideoSource,
    captured: Arc<AtomicU64>,
    forwarded: AtomicU64,
    capture_clock_offset: AtomicI64,
    stopped: Arc<AtomicBool>,
}
async fn api(
    client: &reqwest::Client,
    key: &str,
    route: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let request = if let Some(body) = body {
        client.post(format!("{API}{route}")).json(&body)
    } else {
        client.get(format!("{API}{route}"))
    };
    request
        .bearer_auth(key)
        .send()
        .await
        .map_err(|_| "Probe transport failed")?
        .error_for_status()
        .map_err(|_| "Probe HTTP rejected")?
        .json()
        .await
        .map_err(|_| "Invalid probe response".into())
}
fn create(
    config_path: &str,
    relay: bool,
    codec: &str,
    width: u32,
    height: u32,
) -> Result<Probe, String> {
    let config: Value =
        serde_json::from_slice(&std::fs::read(config_path).map_err(|_| "Config unreadable")?)
            .map_err(|_| "Invalid config")?;
    let key = config["accessKey"]
        .as_str()
        .ok_or("Config key missing")?
        .to_owned();
    let servers = config["iceServers"]
        .as_array()
        .ok_or("ICE servers missing")?
        .iter()
        .map(|server| {
            let urls = if let Some(url) = server["urls"].as_str() {
                vec![url.to_owned()]
            } else {
                server["urls"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            };
            IceServer {
                urls,
                username: server["username"].as_str().unwrap_or_default().to_owned(),
                password: server["credential"].as_str().unwrap_or_default().to_owned(),
            }
        })
        .collect();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .map_err(|_| "Runtime failed")?;
    let _scope = runtime.enter();
    let factory = PeerConnectionFactory::default();
    factory.set_adm_recording_enabled(false);
    factory.set_adm_playout_enabled(false);
    let mut rtc = RtcConfiguration::default();
    rtc.ice_servers = servers;
    // This bounded fixture publishes a fully gathered offer, without trickle ICE.
    // The SDK default gathers continually and never reaches Complete.
    rtc.continual_gathering_policy = ContinualGatheringPolicy::GatherOnce;
    rtc.ice_transport_type = if relay {
        IceTransportsType::Relay
    } else {
        IceTransportsType::All
    };
    let peer = factory
        .create_peer_connection(rtc)
        .map_err(|_| "Peer creation failed")?;
    peer.set_bitrate(BitrateSettings {
        min_bitrate_bps: None,
        start_bitrate_bps: Some(250_000),
        max_bitrate_bps: Some(350_000),
    })
    .map_err(|_| "Bitrate rejected")?;
    let source = NativeVideoSource::new(VideoResolution { width, height }, true);
    let track = factory.create_video_track("native-display", source.clone());
    let transceiver = peer
        .add_transceiver(
            MediaStreamTrack::Video(track),
            RtpTransceiverInit {
                direction: RtpTransceiverDirection::SendOnly,
                stream_ids: vec!["native-display".into()],
                send_encodings: vec![RtpEncodingParameters {
                    max_bitrate: Some(350_000),
                    max_framerate: Some(15.0),
                    ..Default::default()
                }],
            },
        )
        .map_err(|_| "Video transceiver failed")?;
    match std::env::var("RD_PROBE_ENCODER").as_deref() {
        Ok("videotoolbox") if codec.eq_ignore_ascii_case("H264") => transceiver
            .sender()
            .set_video_encoder_backend(VideoEncoderBackend::VideoToolbox),
        Ok("software") => transceiver
            .sender()
            .set_video_encoder_backend(VideoEncoderBackend::Software),
        Err(std::env::VarError::NotPresent) => {}
        _ => return Err("Unsupported probe encoder preference".into()),
    }
    let codecs = factory
        .get_rtp_sender_capabilities(MediaType::Video)
        .codecs
        .into_iter()
        .filter(|c| c.mime_type.eq_ignore_ascii_case(&format!("video/{codec}")))
        .collect::<Vec<_>>();
    if codecs.is_empty() {
        peer.close();
        return Err("Codec unavailable".into());
    }
    transceiver
        .set_codec_preferences(codecs)
        .map_err(|_| "Codec preference rejected")?;
    let channel = peer
        .create_data_channel("rd", DataChannelInit::default())
        .map_err(|_| "DataChannel creation failed")?;
    let run = libwebrtc::native::create_random_uuid();
    let captured = Arc::new(AtomicU64::new(0));
    let stopped = Arc::new(AtomicBool::new(false));
    let start = Instant::now();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .no_proxy()
        .build()
        .map_err(|_| "HTTP client failed")?;
    let echo_client = client.clone();
    let echo_key = key.clone();
    let echo_run = run.clone();
    let executor = runtime.handle().clone();
    channel.on_message(Some(Box::new(move |data| {
        if let Ok(msg) = serde_json::from_slice::<Value>(data.data) {
            if let Some(sent) = msg["sentAt"].as_f64() {
                let event = json!({"type":"native-echo", "runId":echo_run, "rttMs":start.elapsed().as_secs_f64()*1000.0-sent});
                let (client, key) = (echo_client.clone(), echo_key.clone());
                executor.spawn(async move { let _ = api(&client, &key, "event", Some(event)).await; });
            }
        }
    })));
    let candidates = Arc::new(std::sync::Mutex::new(Vec::new()));
    let gathered = candidates.clone();
    peer.on_ice_candidate(Some(Box::new(move |candidate| {
        gathered.lock().unwrap().push(candidate);
    })));
    let task_peer = peer.clone();
    let task_channel = channel.clone();
    let task_captured = captured.clone();
    let task_stopped = stopped.clone();
    let codec = codec.to_owned();
    runtime.spawn(async move {
        let result = async {
            // NativeVideoSource has startup black keepalive. Do not publish before actual SCStream pixels.
            while task_captured.load(Ordering::Acquire) == 0 {
                if start.elapsed() > Duration::from_secs(10) { return Err("No native source frame".to_owned()); }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            let offer = task_peer.create_offer(OfferOptions::default()).await.map_err(|_| "Offer failed")?;
            task_peer.set_local_description(offer.clone()).await.map_err(|_| "Local description failed")?;
            while task_peer.ice_gathering_state() != IceGatheringState::Complete {
                if start.elapsed() > Duration::from_secs(25) { return Err("ICE gathering timeout".into()); }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            // The binding exposes only current description (absent before answer),
            // so gather once and insert callback candidates into their media sections.
            let gathered = candidates.lock().unwrap().iter().map(|c| (c.sdp_mline_index(), c.to_string())).collect::<Vec<_>>();
            let sdp = gathered_sdp(&offer.to_string(), &gathered)?;
            api(&client, &key, "offer", Some(json!({"runId":run,"policy":if relay {"relay"} else {"all"},"codec":codec,"source":"ScreenCaptureKit-display","offer":{"type":"offer","sdp":sdp}}))).await?;
            loop {
                if start.elapsed() > Duration::from_secs(45) { return Err("Answer timeout".into()); }
                let answer = api(&client, &key, &format!("answer?runId={run}"), None).await?;
                if let Some(sdp) = answer["sdp"].as_str() {
                    task_peer.set_remote_description(SessionDescription::parse(sdp, SdpType::Answer).map_err(|_| "Invalid answer")?).await.map_err(|_| "Remote description failed")?;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
            while !task_stopped.load(Ordering::Acquire) && start.elapsed() < Duration::from_secs(60) {
                if task_channel.state() == DataChannelState::Open {
                    let payload = json!({"sentAt":start.elapsed().as_secs_f64()*1000.0}).to_string();
                    let _ = task_channel.send(payload.as_bytes(), false);
                }
                let mut event = json!({"type":"native-stats","runId":run,"state":format!("{:?}",task_peer.connection_state()),"nativeFrames":task_captured.load(Ordering::Acquire)});
                if let Ok(stats) = task_peer.get_stats().await {
                    let filtered: Vec<Value> = stats.iter().filter_map(|s| {
                        if let libwebrtc::stats::RtcStats::OutboundRtp(s) = s {
                            Some(json!({"type":"outbound-rtp","kind":s.stream.kind,"framesEncoded":s.outbound.frames_encoded,"bytesSent":s.sent.bytes_sent,"totalEncodeTime":s.outbound.total_encode_time,"encoderImplementation":s.outbound.encoder_implementation,"frameWidth":s.outbound.frame_width,"frameHeight":s.outbound.frame_height,"framesPerSecond":s.outbound.frames_per_second}))
                        } else { None }
                    }).collect(); event["outbound"] = json!(filtered);
                }
                api(&client, &key, "event", Some(event)).await?;
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            Ok::<(), String>(())
        }.await;
        if let Err(error) = result { eprintln!("Native probe: {error}"); let _ = api(&client, &key, "event", Some(json!({"type":"native-error","runId":run,"message":error}))).await; }
        task_stopped.store(true, Ordering::Release); task_channel.close(); task_peer.close();
    });
    drop(_scope);
    Ok(Probe {
        runtime,
        peer,
        channel,
        source,
        captured,
        forwarded: AtomicU64::new(0),
        capture_clock_offset: AtomicI64::new(0),
        stopped,
    })
}

// The Swift adapter exclusively owns this opaque handle. Capture callbacks must
// be drained before stop; native CVPixelBuffer must remain alive during push.
/// Creates one isolated media sender.
/// # Safety
/// Non-null strings must be valid NUL-terminated UTF-8 for this call. The caller
/// owns the returned handle and must drain all callbacks before exactly one stop.
#[no_mangle]
pub unsafe extern "C" fn rd_probe_create(
    path: *const c_char,
    codec: *const c_char,
    relay: bool,
    width: u32,
    height: u32,
) -> *mut c_void {
    if path.is_null() || codec.is_null() || width == 0 || height == 0 {
        return std::ptr::null_mut();
    }
    let result = std::panic::catch_unwind(|| {
        create(
            CStr::from_ptr(path).to_str().unwrap_or(""),
            relay,
            CStr::from_ptr(codec).to_str().unwrap_or(""),
            width,
            height,
        )
    });
    match result {
        Ok(Ok(p)) => Box::into_raw(Box::new(p)).cast(),
        Ok(Err(e)) => {
            eprintln!("Native probe: {e}");
            std::ptr::null_mut()
        }
        Err(_) => std::ptr::null_mut(),
    }
}
/// Borrows one complete native display sample synchronously.
/// # Safety
/// Handle must be live; pixel_buffer must be a live CVPixelBufferRef throughout
/// the call. Stop must not race push. Timestamp is the source monotonic PTS.
#[no_mangle]
pub unsafe extern "C" fn rd_probe_push(
    handle: *mut c_void,
    pixel_buffer: *mut c_void,
    timestamp_us: i64,
) -> bool {
    if handle.is_null() || pixel_buffer.is_null() {
        return false;
    }
    let probe = &*handle.cast::<Probe>();
    if probe.stopped.load(Ordering::Acquire) {
        return false;
    }
    // webrtc-sys 0.3.49 consumes one CVPixelBuffer retain in its ObjC bridge.
    // Swift lends the CMSampleBuffer's image; give the bridge a separate +1.
    let buffer = NativeBuffer::from_cv_pixel_buffer(CVPixelBufferRetain(pixel_buffer));
    // SCStream PTS is monotonic host time; SDK startup keepalive uses wall time.
    // Map once while preserving source intervals, avoiding mixed timestamp epochs.
    if probe.capture_clock_offset.load(Ordering::Relaxed) == 0 {
        let wall = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros() as i64;
        probe
            .capture_clock_offset
            .store(wall - timestamp_us, Ordering::Relaxed);
    }
    probe.captured.fetch_add(1, Ordering::Release);
    let forwarded = probe.source.capture_frame(&VideoFrame {
        rotation: VideoRotation::VideoRotation0,
        timestamp_us: timestamp_us + probe.capture_clock_offset.load(Ordering::Relaxed),
        frame_metadata: None,
        buffer,
    });
    if forwarded {
        probe.forwarded.fetch_add(1, Ordering::Relaxed);
    }
    forwarded
}
/// Reads the bounded sender's terminal flag.
/// # Safety
/// A non-null handle must be live; stop must not race this read.
#[no_mangle]
pub unsafe extern "C" fn rd_probe_stopped(handle: *mut c_void) -> bool {
    handle.is_null() || (&*handle.cast::<Probe>()).stopped.load(Ordering::Acquire)
}
/// Closes and releases the opaque media sender.
/// # Safety
/// A non-null handle must come from create, be stopped exactly once, and have no
/// concurrent or future push/stopped calls. The Swift capture queue enforces this.
#[no_mangle]
pub unsafe extern "C" fn rd_probe_stop(handle: *mut c_void) {
    if handle.is_null() {
        return;
    }
    let p = *Box::from_raw(handle.cast::<Probe>());
    p.stopped.store(true, Ordering::Release);
    p.channel.close();
    p.peer.close();
    eprintln!(
        "Native probe stopped: captured={}, forwarded={}",
        p.captured.load(Ordering::Acquire),
        p.forwarded.load(Ordering::Relaxed)
    );
    drop(p.source);
    drop(p.channel);
    drop(p.peer);
    p.runtime.shutdown_timeout(Duration::from_secs(2));
}

#[cfg(test)]
mod tests {
    use super::gathered_sdp;
    const OFFER: &str = "v=0\r\na=group:BUNDLE video data\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:video\r\na=candidate:stale\r\na=end-of-candidates\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:data\r\n";
    #[test]
    fn candidates_stay_in_their_media_section_and_stale_candidates_are_removed() {
        let sdp = gathered_sdp(
            OFFER,
            &[(0, "candidate:video".into()), (1, "candidate:data".into())],
        )
        .unwrap();
        let (video, data) = sdp.split_once("m=application").unwrap();
        assert!(video.contains("a=candidate:video\r\n"));
        assert!(!video.contains("candidate:data"));
        assert!(data.contains("a=candidate:data\r\n"));
        assert!(!data.contains("candidate:video"));
        assert!(!sdp.contains("candidate:stale"));
        assert_eq!(sdp.matches("a=end-of-candidates").count(), 2);
    }
    #[test]
    fn empty_out_of_range_and_injected_candidates_are_rejected() {
        for candidates in [
            vec![],
            vec![(2, "candidate:wrong".into())],
            vec![(-1, "candidate:wrong".into())],
            vec![(0, "candidate:x\r\na=mid:data".into())],
        ] {
            assert!(gathered_sdp(OFFER, &candidates).is_err());
        }
    }
}
