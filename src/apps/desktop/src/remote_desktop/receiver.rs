//! Native receive/decode for WebViews without WebRTC. Only bounded decoded
//! pixels and channel messages cross the local IPC channel; no account keys.
use futures::StreamExt;
use libwebrtc::{
    data_channel::{DataChannel, DataChannelState},
    media_stream_track::MediaStreamTrack,
    peer_connection::{AnswerOptions, IceGatheringState, PeerConnection, PeerConnectionState},
    peer_connection_factory::{
        native::PeerConnectionFactoryExt, ContinualGatheringPolicy, IceServer, IceTransportsType,
        PeerConnectionFactory, RtcConfiguration,
    },
    session_description::{SdpType, SessionDescription},
    stats::RtcStats,
    video_frame::{VideoFormatType, VideoRotation},
    video_stream::native::NativeVideoStream,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::ipc::{Channel, InvokeResponseBody};

#[derive(Deserialize)]
pub(crate) struct Ice {
    urls: Vec<String>,
    #[serde(default)]
    username: String,
    #[serde(default)]
    credential: String,
}
#[derive(Deserialize)]
pub(crate) struct Config {
    offer_sdp: String,
    ice_servers: Vec<Ice>,
    force_relay: bool,
}
#[derive(Default)]
struct Registry {
    receiver: Option<Arc<Receiver>>,
    pending: Option<(String, Arc<AtomicBool>)>,
}
static OWNER: OnceLock<Mutex<Registry>> = OnceLock::new();
static FACTORY: OnceLock<Arc<PeerConnectionFactory>> = OnceLock::new();
fn owner() -> &'static Mutex<Registry> {
    OWNER.get_or_init(|| Mutex::new(Registry::default()))
}
fn lookup(id: &str) -> Result<Arc<Receiver>, String> {
    owner()
        .lock()
        .unwrap()
        .receiver
        .clone()
        .filter(|r| r.id == id && r.current())
        .ok_or_else(|| "renderer_reloaded".into())
}

struct Receiver {
    id: String,
    generation: u64,
    peer: PeerConnection,
    channel: Mutex<Option<DataChannel>>,
    events: Channel<InvokeResponseBody>,
    closed: AtomicBool,
    stopping: tokio::sync::Notify,
    sequence: AtomicU64,
    inflight: AtomicU64,
    track: AtomicBool,
    last_ui: Mutex<Instant>,
}
impl Receiver {
    fn current(&self) -> bool {
        !self.closed.load(Ordering::Acquire) && super::connection::is_current(self.generation)
    }
    fn event(&self, value: Value) {
        if self.current()
            && self
                .events
                .send(InvokeResponseBody::Json(value.to_string()))
                .is_err()
        {
            self.close();
        }
    }
    fn close(&self) {
        if !self.closed.swap(true, Ordering::AcqRel) {
            self.stopping.notify_waiters();
            let channel = self.channel.lock().unwrap().take();
            let peer = self.peer.clone();
            // Never synchronously close SDK network threads from an SDK callback.
            tauri::async_runtime::spawn_blocking(move || {
                if let Some(channel) = channel {
                    channel.close();
                }
                peer.close();
            });
        }
    }
}
pub(crate) fn close(id: &str) {
    let mut registry = owner().lock().unwrap();
    if let Some((pending, canceled)) = &registry.pending {
        if pending == id {
            canceled.store(true, Ordering::Release);
        }
    }
    let previous = if registry.receiver.as_ref().is_some_and(|r| r.id == id) {
        registry.receiver.take()
    } else {
        None
    };
    drop(registry);
    if let Some(receiver) = previous {
        receiver.close();
    }
}
pub(crate) fn send(id: &str, body: &str) -> Result<(), String> {
    let r = lookup(id)?;
    if body.len() > 32 * 1024 {
        return Err("input_backpressure".into());
    }
    let value: Value = serde_json::from_str(body).map_err(|_| "invalid_request")?;
    let protocol = value["version"] == 1
        && matches!(
            value["kind"].as_str(),
            Some("bind" | "health_reply" | "acquire_control" | "renew_control" | "release_control")
        );
    let input = openbitfun_product_domains::remote_desktop::input::InputMessage::parse(
        body.as_bytes(),
        true,
    )
    .is_ok();
    if !protocol && !input {
        return Err("invalid_request".into());
    }
    let channel = r
        .channel
        .lock()
        .unwrap()
        .clone()
        .ok_or("media_unreachable")?;
    if channel.state() != DataChannelState::Open || channel.buffered_amount() > 64 * 1024 {
        return Err("input_backpressure".into());
    }
    if !r.current() {
        return Err("renderer_reloaded".into());
    }
    channel
        .send(body.as_bytes(), false)
        .map_err(|_| "media_unreachable".into())
}
pub(crate) fn acknowledge(id: &str, sequence: &str) -> Result<(), String> {
    let r = lookup(id)?;
    let sequence = sequence.parse::<u64>().map_err(|_| "invalid_request")?;
    if sequence == 0
        || r.inflight
            .compare_exchange(sequence, 0, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
    {
        return Err("invalid_frame_ack".into());
    }
    *r.last_ui.lock().unwrap() = Instant::now();
    Ok(())
}
pub(crate) async fn open(
    generation: u64,
    id: String,
    config: Config,
    events: Channel<InvokeResponseBody>,
) -> Result<Value, String> {
    if id.len() > 128
        || id.is_empty()
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
        || config.offer_sdp.len() > 90 * 1024
        || config.ice_servers.len() > 16
    {
        return Err("invalid_request".into());
    }
    let mut servers = Vec::new();
    for ice in config.ice_servers {
        if ice.urls.len() > 8
            || ice.urls.is_empty()
            || ice.username.len() > 1024
            || ice.credential.len() > 1024
            || ice.urls.iter().any(|s| {
                s.len() > 1024
                    || !(s.starts_with("turn:")
                        || s.starts_with("turns:")
                        || s.starts_with("stun:"))
            })
        {
            return Err("invalid_request".into());
        }
        servers.push(IceServer {
            urls: ice.urls,
            username: ice.username,
            password: ice.credential,
        });
    }
    if config.force_relay && servers.is_empty() {
        return Err("turn_unavailable".into());
    }
    if !config.force_relay {
        let urls:std::collections::BTreeSet<_>=servers.iter().flat_map(|s|&s.urls).filter_map(|s|openbitfun_services_integrations::remote_connect::remote_desktop_device::stun_url_for_turn_udp(s)).collect();
        if !urls.is_empty() {
            servers.push(IceServer {
                urls: urls.into_iter().collect(),
                username: String::new(),
                password: String::new(),
            });
        }
    }
    let canceled = Arc::new(AtomicBool::new(false));
    let previous = {
        let mut registry = owner().lock().unwrap();
        if let Some((_, old)) = registry.pending.take() {
            old.store(true, Ordering::Release);
        }
        registry.pending = Some((id.clone(), canceled.clone()));
        registry.receiver.take()
    };
    if let Some(previous) = previous {
        previous.close();
    }
    let factory = tauri::async_runtime::spawn_blocking(|| {
        FACTORY
            .get_or_init(|| {
                let factory = PeerConnectionFactory::default();
                factory.set_adm_recording_enabled(false);
                factory.set_adm_playout_enabled(false);
                Arc::new(factory)
            })
            .clone()
    })
    .await
    .map_err(|_| "media_backend_unavailable")?;
    let mut rtc = RtcConfiguration::default();
    rtc.ice_servers = servers;
    rtc.ice_transport_type = if config.force_relay {
        IceTransportsType::Relay
    } else {
        IceTransportsType::All
    };
    rtc.continual_gathering_policy = ContinualGatheringPolicy::GatherOnce;
    let peer = factory
        .create_peer_connection(rtc)
        .map_err(|_| "media_backend_unavailable")?;
    let receiver = Arc::new(Receiver {
        id: id.clone(),
        generation,
        peer,
        channel: Mutex::new(None),
        events,
        closed: AtomicBool::new(false),
        stopping: tokio::sync::Notify::new(),
        sequence: AtomicU64::new(0),
        inflight: AtomicU64::new(0),
        track: AtomicBool::new(false),
        last_ui: Mutex::new(Instant::now()),
    });
    let previous = {
        let mut registry = owner().lock().unwrap();
        if canceled.load(Ordering::Acquire) || !super::connection::is_current(generation) {
            if registry
                .pending
                .as_ref()
                .is_some_and(|(_, flag)| Arc::ptr_eq(flag, &canceled))
            {
                registry.pending = None;
            }
            drop(registry);
            receiver.close();
            return Err("renderer_reloaded".into());
        }
        registry.pending = None;
        registry.receiver.replace(receiver.clone())
    };
    if let Some(previous) = previous {
        previous.close();
    }
    let watchdog = Arc::downgrade(&receiver);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let Some(r) = watchdog.upgrade() else {
                break;
            };
            if !r.current() || r.last_ui.lock().unwrap().elapsed() > Duration::from_secs(30) {
                r.close();
                break;
            }
        }
    });
    let weak = Arc::downgrade(&receiver);
    receiver
        .peer
        .on_connection_state_change(Some(Box::new(move |state| {
            if let Some(receiver) = weak.upgrade() {
                let state = match state {
                    PeerConnectionState::Connected => "connected",
                    PeerConnectionState::Disconnected => "disconnected",
                    PeerConnectionState::Failed => "failed",
                    PeerConnectionState::Closed => "closed",
                    _ => "connecting",
                };
                receiver.event(json!({"kind":"connection", "state":state}));
            }
        })));
    let weak = Arc::downgrade(&receiver);
    receiver.peer.on_data_channel(Some(Box::new(move |channel| {
        let Some(receiver) = weak.upgrade() else { channel.close(); return; };
        let properties = channel.reliability();
        if !receiver.current() || channel.label() != "rd" || !properties.ordered
            || properties.max_packet_lifetime.is_some() || properties.max_retransmits.is_some()
        {
            channel.close();
            return;
        }
        {
            let mut owned = receiver.channel.lock().unwrap();
            if owned.is_some() { drop(owned); channel.close(); return; }
            *owned = Some(channel.clone());
        }
        let weak = Arc::downgrade(&receiver);
        channel.on_message(Some(Box::new(move |message| {
            if let Some(receiver) = weak.upgrade() {
                if message.binary || message.data.len() > 32 * 1024 {
                    receiver.close();
                    return;
                }
                if let Ok(body) = std::str::from_utf8(message.data) {
                    receiver.event(json!({"kind":"message", "data":body}));
                }
            }
        })));
        let weak = Arc::downgrade(&receiver);
        channel.on_state_change(Some(Box::new(move |state| {
            if let Some(receiver) = weak.upgrade() {
                let state = match state {
                    DataChannelState::Open => "open",
                    DataChannelState::Closed => "closed",
                    DataChannelState::Closing => "closing",
                    _ => "connecting",
                };
                receiver.event(json!({"kind":"channel", "state":state}));
            }
        })));
        receiver.event(json!({"kind":"channel", "state": if channel.state() == DataChannelState::Open {"open"} else {"connecting"}}));
    })));
    let weak = Arc::downgrade(&receiver);
    let runtime = tokio::runtime::Handle::current();
    receiver.peer.on_track(Some(Box::new(move |event| {
        let Some(receiver) = weak.upgrade() else {
            return;
        };
        let MediaStreamTrack::Video(track) = event.track else {
            receiver.close();
            return;
        };
        if !receiver.current() || receiver.track.swap(true, Ordering::AcqRel) {
            receiver.close();
            return;
        }
        receiver.event(json!({"kind":"track"}));
        let mut stream = NativeVideoStream::new(track);
        runtime.spawn(async move {
            loop {
                if !receiver.current() {
                    break;
                }
                let frame = tokio::select! {
                    _ = receiver.stopping.notified() => break,
                    _ = tokio::time::sleep(Duration::from_millis(100)) => continue,
                    frame = stream.next() => match frame { Some(frame) => frame, None => break },
                };
                if !receiver.current() {
                    break;
                }
                let (width, height) = (frame.buffer.width(), frame.buffer.height());
                if width < 2 || height < 2 || width.max(height) > 3840 || width.min(height) > 2160 {
                    receiver.close();
                    break;
                }
                let sequence = receiver.sequence.fetch_add(1, Ordering::Relaxed) + 1;
                if receiver
                    .inflight
                    .compare_exchange(0, sequence, Ordering::AcqRel, Ordering::Acquire)
                    .is_err()
                {
                    continue;
                }
                let mut packet = vec![0; 32 + width as usize * height as usize * 4];
                packet[..4].copy_from_slice(b"RDF1");
                packet[4..12].copy_from_slice(&sequence.to_le_bytes());
                packet[12..16].copy_from_slice(&width.to_le_bytes());
                packet[16..20].copy_from_slice(&height.to_le_bytes());
                let rotation = match frame.rotation {
                    VideoRotation::VideoRotation0 => 0u32,
                    VideoRotation::VideoRotation90 => 90,
                    VideoRotation::VideoRotation180 => 180,
                    VideoRotation::VideoRotation270 => 270,
                };
                packet[20..24].copy_from_slice(&rotation.to_le_bytes());
                packet[24..32].copy_from_slice(&frame.timestamp_us.to_le_bytes());
                frame.buffer.to_argb(
                    VideoFormatType::ABGR,
                    &mut packet[32..],
                    width * 4,
                    width as i32,
                    height as i32,
                );
                if receiver
                    .events
                    .send(InvokeResponseBody::Raw(packet))
                    .is_err()
                {
                    receiver.close();
                    break;
                }
            }
            stream.close();
            if receiver.current() {
                receiver.event(json!({"kind":"ended"}));
                receiver.close();
            }
        });
    })));
    let candidates = Arc::new(Mutex::new(Vec::new()));
    let collected = candidates.clone();
    receiver
        .peer
        .on_ice_candidate(Some(Box::new(move |candidate| {
            collected
                .lock()
                .unwrap()
                .push((candidate.sdp_mline_index(), candidate.to_string()));
        })));
    let result = async {
        let offer = SessionDescription::parse(&config.offer_sdp, SdpType::Offer)
            .map_err(|_| "invalid_request")?;
        receiver
            .peer
            .set_remote_description(offer)
            .await
            .map_err(|_| "media_unreachable")?;
        if !receiver.current() {
            return Err("renderer_reloaded".into());
        }
        let answer = receiver
            .peer
            .create_answer(AnswerOptions::default())
            .await
            .map_err(|_| "media_unreachable")?;
        receiver
            .peer
            .set_local_description(answer.clone())
            .await
            .map_err(|_| "media_unreachable")?;
        let started = Instant::now();
        while receiver.peer.ice_gathering_state() != IceGatheringState::Complete {
            if !receiver.current() || started.elapsed() > Duration::from_secs(20) {
                return Err("media_unreachable".into());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        if !receiver.current() {
            return Err("renderer_reloaded".into());
        }
        let answer = super::media::gathered_sdp(&answer.to_string(), &candidates.lock().unwrap())?;
        if answer.len() > 90 * 1024 {
            return Err("invalid_response".into());
        }
        Ok(json!({"sdp":answer}))
    }
    .await;
    if result.is_err() {
        receiver.close();
    } else {
        *receiver.last_ui.lock().unwrap() = Instant::now();
    }
    // Keep factory alive until SDK setup has finished; the peer retains it.
    drop(factory);
    result
}
pub(crate) async fn stats(id: &str) -> Result<Value, String> {
    let r = lookup(id)?;
    let stats = r.peer.get_stats().await.map_err(|_| "media_unreachable")?;
    if !r.current() {
        return Err("renderer_reloaded".into());
    }
    *r.last_ui.lock().unwrap() = Instant::now();
    let mut reports = Vec::new();
    for report in stats {
        let report = match report {
            RtcStats::InboundRtp(s) => {
                json!({"id":s.rtc.id, "type":"inbound-rtp", "kind":s.stream.kind, "framesDecoded":s.inbound.frames_decoded})
            }
            RtcStats::Transport(s) => {
                json!({"id":s.rtc.id, "type":"transport", "selectedCandidatePairId":s.transport.selected_candidate_pair_id})
            }
            RtcStats::CandidatePair(s) => {
                json!({"id":s.rtc.id, "type":"candidate-pair", "state":s.candidate_pair.state.map(|v|format!("{v:?}").to_lowercase()), "localCandidateId":s.candidate_pair.local_candidate_id, "remoteCandidateId":s.candidate_pair.remote_candidate_id})
            }
            RtcStats::LocalCandidate(s) => {
                json!({"id":s.rtc.id, "type":"local-candidate", "candidateType":s.local_candidate.candidate_type.map(|v|format!("{v:?}").to_lowercase()), "protocol":s.local_candidate.protocol, "relayProtocol":s.local_candidate.relay_protocol.map(|v|format!("{v:?}").to_lowercase())})
            }
            RtcStats::RemoteCandidate(s) => {
                json!({"id":s.rtc.id, "type":"remote-candidate", "candidateType":s.remote_candidate.candidate_type.map(|v|format!("{v:?}").to_lowercase())})
            }
            _ => continue,
        };
        reports.push(report);
    }
    Ok(json!(reports))
}

#[cfg(test)]
#[path = "receiver_tests.rs"]
mod tests;
