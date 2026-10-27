//! Standalone native PeerConnection provider. No account IO, Relay endpoint,
//! Agent runtime, OS input or authorization decision is implemented here.
use super::capture::{DisplayCapture, NativeFrame};
#[cfg(target_os = "macos")]
use libwebrtc::video_frame::native::NativeBuffer;
use libwebrtc::{
    data_channel::{DataChannel, DataChannelInit, DataChannelState},
    media_stream_track::MediaStreamTrack,
    peer_connection::{
        BitrateSettings, IceGatheringState, OfferOptions, PeerConnection, PeerConnectionState,
    },
    peer_connection_factory::{
        native::PeerConnectionFactoryExt, ContinualGatheringPolicy, IceServer, IceTransportsType,
        PeerConnectionFactory, RtcConfiguration,
    },
    rtp_parameters::RtpEncodingParameters,
    rtp_transceiver::{RtpTransceiverDirection, RtpTransceiverInit},
    session_description::{SdpType, SessionDescription},
    video_frame::{VideoFrame, VideoRotation},
    video_source::{native::NativeVideoSource, VideoResolution},
    MediaType,
};
use openbitfun_product_domains::remote_desktop::health::{MediaHealth, ReceiverHealth};
use openbitfun_product_domains::remote_desktop::QualityPreset;
use serde::Deserialize;
use std::{
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

#[derive(Clone)]
pub(super) enum Event {
    Bound,
    Closed,
    CaptureFailed,
    GeometryChanged,
    HostLocked,
    SourceStarted,
    FirstFrameSubmitted,
}

pub(super) struct VideoConfig {
    pub(super) resolution: VideoResolution,
    pub(super) quality: QualityPreset,
}

struct Callbacks {
    attach_id: String,
    connection_id: String,
    connected: AtomicBool,
    channel_open: AtomicBool,
    bound: AtomicBool,
    notified: AtomicBool,
    stopped: Arc<AtomicBool>,
    event: Box<dyn Fn(Event) + Send + Sync>,
    started: Instant,
    health: Mutex<MediaHealth>,
    control: Mutex<Option<Arc<dyn Fn(&[u8]) + Send + Sync>>>,
}

fn observe_native_sample(health: &Mutex<MediaHealth>, samples: &AtomicU64, now_ms: u64) {
    let observed = samples.fetch_add(1, Ordering::Relaxed).saturating_add(1);
    health.lock().unwrap().source_frame(observed, now_ms);
}

impl Callbacks {
    fn maybe_bound(&self) {
        if !self.stopped.load(Ordering::Acquire)
            && self.connected.load(Ordering::Acquire)
            && self.channel_open.load(Ordering::Acquire)
            && self.bound.load(Ordering::Acquire)
            && !self.notified.swap(true, Ordering::AcqRel)
        {
            (self.event)(Event::Bound);
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Bind {
    version: u32,
    kind: String,
    attach_id: String,
    connection_id: String,
}

pub(super) struct Engine {
    factory: PeerConnectionFactory,
}
impl Engine {
    pub(super) fn new() -> Self {
        let factory = PeerConnectionFactory::default();
        factory.set_adm_recording_enabled(false);
        factory.set_adm_playout_enabled(false);
        Self { factory }
    }
    pub(super) fn codecs(&self) -> Vec<String> {
        let mut codecs: Vec<String> = self
            .factory
            .get_rtp_sender_capabilities(MediaType::Video)
            .codecs
            .into_iter()
            .filter_map(
                |codec| match codec.mime_type.to_ascii_lowercase().as_str() {
                    "video/h264" => Some("H264".into()),
                    "video/vp8" => Some("VP8".into()),
                    _ => None,
                },
            )
            .collect();
        codecs.sort();
        codecs.dedup();
        codecs
    }
    pub(super) fn prepare(
        &self,
        attach_id: &str,
        connection_id: &str,
        mut servers: Vec<IceServer>,
        relay: bool,
        video: VideoConfig,
        event: impl Fn(Event) + Send + Sync + 'static,
    ) -> Result<Connection, String> {
        let VideoConfig {
            resolution,
            quality,
        } = video;
        let settings = quality.settings();
        if attach_id.is_empty()
            || connection_id.is_empty()
            || resolution.width < 2
            || resolution.height < 2
            || resolution.width.max(resolution.height) > settings.long_edge
            || resolution.width.min(resolution.height) > settings.short_edge
            || resolution.width % 2 != 0
            || resolution.height % 2 != 0
            || (relay && servers.is_empty())
        {
            return Err("Invalid media configuration".into());
        }
        if !relay {
            let urls: std::collections::BTreeSet<_> = servers.iter().flat_map(|server| &server.urls)
                .filter_map(|url| openbitfun_services_integrations::remote_connect::remote_desktop_device::stun_url_for_turn_udp(url))
                .collect();
            if !urls.is_empty() {
                servers.push(IceServer {
                    urls: urls.into_iter().collect(),
                    username: String::new(),
                    password: String::new(),
                });
            }
        }
        let mut config = RtcConfiguration::default();
        config.ice_servers = servers;
        config.continual_gathering_policy = ContinualGatheringPolicy::GatherOnce;
        config.ice_transport_type = if relay {
            IceTransportsType::Relay
        } else {
            IceTransportsType::All
        };
        let peer = self
            .factory
            .create_peer_connection(config)
            .map_err(|_| "Peer creation failed")?;
        peer.set_bitrate(BitrateSettings {
            min_bitrate_bps: None,
            start_bitrate_bps: Some(settings.start_bitrate_bps.into()),
            max_bitrate_bps: Some(settings.max_bitrate_bps.into()),
        })
        .map_err(|_| "Bitrate rejected")?;
        // In pinned libwebrtc 0.3.52, `new` starts a 10 fps black-frame
        // keepalive before capture. The no-keepalive constructor is named
        // `new_encoded`, but uses the same raw-capable native source; it does
        // not select the PreEncoded encoder backend. Keep the regular encoder
        // and push borrowed native raw buffers below. This constructor reports
        // is_screencast=false; codec/quality behavior needs its own platform
        // acceptance. The native renderer probe guards both the absence of
        // startup placeholders and actual raw-frame encoding for this SDK pin.
        let source = NativeVideoSource::new_encoded(resolution.clone());
        let track = self
            .factory
            .create_video_track("remote-display", source.clone());
        let transceiver = peer
            .add_transceiver(
                MediaStreamTrack::Video(track),
                RtpTransceiverInit {
                    direction: RtpTransceiverDirection::SendOnly,
                    stream_ids: vec!["remote-display".into()],
                    send_encodings: vec![RtpEncodingParameters {
                        max_bitrate: Some(settings.max_bitrate_bps.into()),
                        max_framerate: Some(settings.max_fps.into()),
                        ..Default::default()
                    }],
                },
            )
            .map_err(|_| "Video transceiver failed")?;
        let codecs = self
            .factory
            .get_rtp_sender_capabilities(MediaType::Video)
            .codecs
            .into_iter()
            .filter(|codec| {
                codec.mime_type.eq_ignore_ascii_case("video/H264")
                    || codec.mime_type.eq_ignore_ascii_case("video/VP8")
            })
            .collect();
        transceiver
            .set_codec_preferences(codecs)
            .map_err(|_| "Codec selection failed")?;
        let channel = peer
            .create_data_channel("rd", DataChannelInit::default())
            .map_err(|_| "DataChannel creation failed")?;
        let stopped = Arc::new(AtomicBool::new(false));
        let callbacks = Arc::new(Callbacks {
            attach_id: attach_id.into(),
            connection_id: connection_id.into(),
            connected: AtomicBool::new(false),
            channel_open: AtomicBool::new(false),
            bound: AtomicBool::new(false),
            notified: AtomicBool::new(false),
            stopped: stopped.clone(),
            event: Box::new(event),
            started: Instant::now(),
            health: Mutex::new(MediaHealth::default()),
            control: Mutex::new(None),
        });
        let state = Arc::downgrade(&callbacks);
        peer.on_connection_state_change(Some(Box::new(move |current| {
            if let Some(state) = state.upgrade() {
                state
                    .connected
                    .store(current == PeerConnectionState::Connected, Ordering::Release);
                if matches!(
                    current,
                    PeerConnectionState::Closed | PeerConnectionState::Failed
                ) {
                    if !state.stopped.swap(true, Ordering::AcqRel) {
                        (state.event)(Event::Closed);
                    }
                } else {
                    state.maybe_bound();
                }
            }
        })));
        let state = Arc::downgrade(&callbacks);
        channel.on_state_change(Some(Box::new(move |current| {
            if let Some(state) = state.upgrade() {
                state
                    .channel_open
                    .store(current == DataChannelState::Open, Ordering::Release);
                if matches!(
                    current,
                    DataChannelState::Closing | DataChannelState::Closed
                ) {
                    if !state.stopped.swap(true, Ordering::AcqRel) {
                        (state.event)(Event::Closed);
                    }
                } else {
                    state.maybe_bound();
                }
            }
        })));
        let state = Arc::downgrade(&callbacks);
        channel.on_message(Some(Box::new(move |data| {
            if data.data.len() > openbitfun_product_domains::remote_desktop::input::MAX_INPUT_BYTES
                || data.binary
            {
                return;
            }
            let Some(state) = state.upgrade() else {
                return;
            };
            if let Ok(bind) = serde_json::from_slice::<Bind>(data.data) {
                if bind.version == 1
                    && bind.kind == "bind"
                    && bind.attach_id == state.attach_id
                    && bind.connection_id == state.connection_id
                {
                    state.bound.store(true, Ordering::Release);
                    state.maybe_bound();
                }
            } else if state.notified.load(Ordering::Acquire)
                && !state.stopped.load(Ordering::Acquire)
            {
                if let Ok(report) = serde_json::from_slice::<ReceiverHealth>(data.data) {
                    state
                        .health
                        .lock()
                        .unwrap()
                        .receive(report, state.started.elapsed().as_millis() as u64);
                } else {
                    let control = state.control.lock().unwrap().clone();
                    if let Some(control) = control {
                        control(data.data);
                    }
                }
            }
        })));
        peer.on_data_channel(Some(Box::new(move |unexpected| {
            unexpected.close();
        })));
        let candidates = Arc::new(Mutex::new(Vec::new()));
        let gathered = candidates.clone();
        peer.on_ice_candidate(Some(Box::new(move |candidate| {
            gathered
                .lock()
                .unwrap()
                .push((candidate.sdp_mline_index(), candidate.to_string()));
        })));
        Ok(Connection {
            peer,
            channel,
            source,
            resolution,
            max_fps: settings.max_fps,
            callbacks,
            stopped,
            candidates,
            answer: None,
            offer: None,
            capture: None,
            forwarded: Arc::new(AtomicU64::new(0)),
        })
    }
}

pub(super) struct Connection {
    peer: PeerConnection,
    channel: DataChannel,
    source: NativeVideoSource,
    resolution: VideoResolution,
    max_fps: u32,
    callbacks: Arc<Callbacks>,
    stopped: Arc<AtomicBool>,
    candidates: Arc<Mutex<Vec<(i32, String)>>>,
    answer: Option<String>,
    offer: Option<String>,
    capture: Option<DisplayCapture>,
    forwarded: Arc<AtomicU64>,
}
impl Connection {
    /// The host owns authority and native IO; the transport exposes only its
    /// bound ordered channel and fresh per-PC media observations.
    pub(super) fn control_endpoint(
        &self,
        receive: impl Fn(&[u8]) + Send + Sync + 'static,
    ) -> (
        impl Fn() -> bool + Send + Sync + 'static,
        impl Fn(serde_json::Value) -> bool + Send + Sync + 'static,
    ) {
        *self.callbacks.control.lock().unwrap() = Some(Arc::new(receive));
        let state = self.callbacks.clone();
        let health = move || {
            let bound = !state.stopped.load(Ordering::Acquire)
                && state.notified.load(Ordering::Acquire)
                && state.connected.load(Ordering::Acquire)
                && state.channel_open.load(Ordering::Acquire);
            state
                .health
                .lock()
                .unwrap()
                .candidate(state.started.elapsed().as_millis() as u64, bound)
        };
        let state = self.callbacks.clone();
        let channel = self.channel.clone();
        let send = move |value: serde_json::Value| {
            if state.stopped.load(Ordering::Acquire)
                || !state.connected.load(Ordering::Acquire)
                || !state.channel_open.load(Ordering::Acquire)
                || channel.buffered_amount() > 64 * 1024
            {
                return false;
            }
            serde_json::to_vec(&value).is_ok_and(|bytes| channel.send(&bytes, false).is_ok())
        };
        (health, send)
    }
    pub(super) fn health_status(&self) -> serde_json::Value {
        // Query SDK state before taking the observation mutex: SDK callbacks
        // may themselves update observations on the network thread.
        let bound = self.bound() && !self.closed() && self.channel.buffered_amount() <= 64 * 1024;
        let now = self.callbacks.started.elapsed().as_millis() as u64;
        let health = self.callbacks.health.lock().unwrap();
        serde_json::json!({"source_activity":health.source_activity(now),"receiver_observed":health.receiver_observed(now),"candidate":health.candidate(now,bound)})
    }
    pub(super) fn probe_health(&self) {
        if !self.bound() || self.closed() || self.channel.buffered_amount() > 64 * 1024 {
            return;
        }
        let probe = self
            .callbacks
            .health
            .lock()
            .unwrap()
            .probe(self.callbacks.started.elapsed().as_millis() as u64);
        if let Some(probe) = probe {
            if let Ok(bytes) = serde_json::to_vec(&probe) {
                let _ = self.channel.send(&bytes, false);
            }
        }
    }
    pub(super) fn connected(&self) -> bool {
        self.callbacks.connected.load(Ordering::Acquire)
    }
    pub(super) fn bound(&self) -> bool {
        self.callbacks.notified.load(Ordering::Acquire)
            && self.connected()
            && self.callbacks.channel_open.load(Ordering::Acquire)
    }
    pub(super) fn closed(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }
    pub(super) fn submitted_frames(&self) -> u64 {
        self.forwarded.load(Ordering::Acquire)
    }
    pub(super) async fn offer(&mut self) -> Result<String, String> {
        if self.stopped.load(Ordering::Acquire) {
            return Err("Media connection is closed".into());
        }
        if let Some(offer) = &self.offer {
            return Ok(offer.clone());
        }
        let offer = self
            .peer
            .create_offer(OfferOptions::default())
            .await
            .map_err(|_| "Offer creation failed")?;
        self.peer
            .set_local_description(offer.clone())
            .await
            .map_err(|_| "Local description failed")?;
        let start = Instant::now();
        while self.peer.ice_gathering_state() != IceGatheringState::Complete {
            if self.stopped.load(Ordering::Acquire) || start.elapsed() > Duration::from_secs(20) {
                return Err("ICE gathering failed or timed out".into());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if self.stopped.load(Ordering::Acquire) {
            return Err("Media connection is closed".into());
        }
        let sdp = gathered_sdp(&offer.to_string(), &self.candidates.lock().unwrap())?;
        if sdp.len() > 90 * 1024 {
            return Err("Offer exceeds signaling limit".into());
        }
        self.offer = Some(sdp.clone());
        Ok(sdp)
    }
    pub(super) async fn answer(&mut self, sdp: &str) -> Result<(), String> {
        if self.stopped.load(Ordering::Acquire) || self.offer.is_none() {
            return Err("Media connection is closed or has no offer".into());
        }
        if sdp.len() > 90 * 1024 {
            return Err("Answer exceeds signaling limit".into());
        }
        if let Some(previous) = &self.answer {
            return if previous == sdp {
                Ok(())
            } else {
                Err("Answer already bound".into())
            };
        }
        let description =
            SessionDescription::parse(sdp, SdpType::Answer).map_err(|_| "Invalid answer")?;
        self.peer
            .set_remote_description(description)
            .await
            .map_err(|_| "Remote description failed")?;
        self.answer = Some(sdp.into());
        Ok(())
    }
    /// Caller has verified the fixed-key answer, Relay association and local
    /// grant, and has opened the pure policy's frame gate for this connection.
    pub(super) fn start_capture(
        &mut self,
        display: u32,
        uuid: &str,
        permitted: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Result<(), String> {
        if self.stopped.load(Ordering::Acquire)
            || self.answer.is_none()
            || !self.callbacks.notified.load(Ordering::Acquire)
            || !self.callbacks.connected.load(Ordering::Acquire)
            || !self.callbacks.channel_open.load(Ordering::Acquire)
            || !permitted()
        {
            return Err("Media binding is not authorized".into());
        }
        if self.capture.is_some() {
            return Ok(());
        }
        let source = self.source.clone();
        let stopped = self.stopped.clone();
        let binding = Arc::downgrade(&self.callbacks);
        let count = self.forwarded.clone();
        let samples = AtomicU64::new(0);
        let offset = AtomicI64::new(0);
        let state = Arc::downgrade(&self.callbacks);
        self.capture = Some(DisplayCapture::open(
            display,
            uuid,
            self.resolution.width,
            self.resolution.height,
            self.max_fps,
            move |frame: NativeFrame<'_>| {
                let Some(binding) = binding.upgrade() else {
                    return;
                };
                if stopped.load(Ordering::Acquire)
                    || !binding.connected.load(Ordering::Acquire)
                    || !binding.channel_open.load(Ordering::Acquire)
                    || !binding.bound.load(Ordering::Acquire)
                    || !permitted()
                {
                    return;
                }
                if offset.load(Ordering::Relaxed) == 0 {
                    let wall = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_micros() as i64;
                    offset.store(wall - frame.timestamp_us, Ordering::Relaxed);
                }
                // New source content invalidates the static exemption even if
                // the SDK drops this frame. Accepted submissions are counted
                // separately and remain the first-frame signaling witness.
                observe_native_sample(
                    &binding.health,
                    &samples,
                    binding.started.elapsed().as_millis() as u64,
                );
                // Pinned webrtc-sys consumes +1; retain the borrowed CVPixelBuffer.
                #[cfg(target_os = "macos")]
                let buffer = unsafe {
                    NativeBuffer::from_cv_pixel_buffer(CVPixelBufferRetain(frame.buffer))
                };
                #[cfg(not(target_os = "macos"))]
                let buffer = frame.buffer;
                if source.capture_frame(&VideoFrame {
                    rotation: VideoRotation::VideoRotation0,
                    timestamp_us: frame.timestamp_us + offset.load(Ordering::Relaxed),
                    frame_metadata: None,
                    buffer,
                }) {
                    let previous = count.fetch_add(1, Ordering::Relaxed);
                    if previous == 0 {
                        // Submission is not proof of encoding, decoding or presentation.
                        (binding.event)(Event::FirstFrameSubmitted);
                    }
                }
            },
            move |code| {
                if let Some(state) = state.upgrade() {
                    match code {
                        1 => (state.event)(Event::SourceStarted),
                        2 => state
                            .health
                            .lock()
                            .unwrap()
                            .source_idle(state.started.elapsed().as_millis() as u64),
                        3 => state.health.lock().unwrap().source_unavailable(),
                        -4 => {
                            state.stopped.store(true, Ordering::Release);
                            (state.event)(Event::HostLocked);
                        }
                        -2 => {
                            state.stopped.store(true, Ordering::Release);
                            (state.event)(Event::GeometryChanged);
                        }
                        _ => {
                            state.stopped.store(true, Ordering::Release);
                            (state.event)(Event::CaptureFailed);
                        }
                    }
                }
            },
        )?);
        Ok(())
    }
    pub(super) fn close(&mut self) -> bool {
        self.stopped.store(true, Ordering::Release);
        self.channel.close();
        self.peer.close();
        if let Some(capture) = self.capture.as_mut() {
            if !capture.close() {
                return false;
            }
        }
        self.capture = None;
        true
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.close();
    }
}
#[cfg(target_os = "macos")]
#[link(name = "CoreVideo", kind = "framework")]
extern "C" {
    fn CVPixelBufferRetain(buffer: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
}

pub(super) fn gathered_sdp(original: &str, candidates: &[(i32, String)]) -> Result<String, String> {
    let count = original
        .lines()
        .filter(|line| line.starts_with("m="))
        .count() as i32;
    if candidates.is_empty()
        || candidates.iter().any(|(index, candidate)| {
            *index < 0
                || *index >= count
                || !candidate.starts_with("candidate:")
                || candidate.contains(['\r', '\n'])
        })
    {
        return Err("Invalid gathered candidates".into());
    }
    let mut output = String::new();
    let mut section = -1;
    for line in original.lines() {
        if line.starts_with("m=") {
            section += 1;
        }
        if line.starts_with("a=candidate:") || line == "a=end-of-candidates" {
            continue;
        }
        output.push_str(line);
        output.push_str("\r\n");
        if line.starts_with("a=mid:") {
            for (_, candidate) in candidates.iter().filter(|(index, _)| *index == section) {
                output.push_str("a=");
                output.push_str(candidate);
                output.push_str("\r\n");
            }
            output.push_str("a=end-of-candidates\r\n");
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests;

#[cfg(all(test, target_os = "macos"))]
mod native_renderer_tests;
