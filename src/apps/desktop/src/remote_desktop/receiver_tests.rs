use super::*;
use libwebrtc::{
    data_channel::DataChannelInit,
    peer_connection::OfferOptions,
    rtp_transceiver::{RtpTransceiverDirection, RtpTransceiverInit},
    video_frame::{I420Buffer, VideoFrame},
    video_source::{native::NativeVideoSource, VideoResolution},
};

/// Real local native encode/decode, ordered DC and binary IPC; no screen,
/// account service, external ICE server, GTK or OS input is started.
#[tokio::test]
async fn native_receiver_decodes_bounded_frames_and_closes_the_exact_peer() {
    let factory = PeerConnectionFactory::default();
    factory.set_adm_recording_enabled(false);
    factory.set_adm_playout_enabled(false);
    let mut config = RtcConfiguration::default();
    config.continual_gathering_policy = ContinualGatheringPolicy::GatherOnce;
    let sender = factory.create_peer_connection(config).unwrap();
    let source = NativeVideoSource::new_encoded(VideoResolution {
        width: 64,
        height: 32,
    });
    let track = factory.create_video_track("native-receiver-fixture", source.clone());
    sender
        .add_transceiver(
            MediaStreamTrack::Video(track),
            RtpTransceiverInit {
                direction: RtpTransceiverDirection::SendOnly,
                stream_ids: vec![],
                send_encodings: vec![],
            },
        )
        .unwrap();
    let channel = sender
        .create_data_channel("rd", DataChannelInit::default())
        .unwrap();
    let candidates = Arc::new(Mutex::new(Vec::new()));
    let output = candidates.clone();
    sender.on_ice_candidate(Some(Box::new(move |c| {
        output
            .lock()
            .unwrap()
            .push((c.sdp_mline_index(), c.to_string()))
    })));
    let offer = sender.create_offer(OfferOptions::default()).await.unwrap();
    sender.set_local_description(offer.clone()).await.unwrap();
    let start = Instant::now();
    while sender.ice_gathering_state() != IceGatheringState::Complete {
        assert!(start.elapsed() < Duration::from_secs(5));
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let offer_sdp =
        super::super::media::gathered_sdp(&offer.to_string(), &candidates.lock().unwrap()).unwrap();
    let packets = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
    let output = packets.clone();
    let events = Channel::new(move |value| {
        if let InvokeResponseBody::Raw(packet) = value {
            output.lock().unwrap().push(packet);
        }
        Ok(())
    });
    let id = "native-receiver-local-fixture";
    let answer = open(
        super::super::connection::generation(),
        id.into(),
        Config {
            offer_sdp,
            ice_servers: vec![],
            force_relay: false,
        },
        events,
    )
    .await
    .unwrap();
    sender
        .set_remote_description(
            SessionDescription::parse(answer["sdp"].as_str().unwrap(), SdpType::Answer).unwrap(),
        )
        .await
        .unwrap();
    let start = Instant::now();
    // The sender's open callback can precede delivery of the receiver's
    // on_data_channel callback. Production waits for its own bridge event;
    // this fixture must observe that same local readiness before sending.
    while channel.state() != DataChannelState::Open
        || !lookup(id).is_ok_and(|receiver| {
            receiver
                .channel
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|channel| channel.state() == DataChannelState::Open)
        })
    {
        assert!(start.elapsed() < Duration::from_secs(5));
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let received = Arc::new(Mutex::new(Vec::new()));
    let output = received.clone();
    channel.on_message(Some(Box::new(move |body| {
        output.lock().unwrap().push(body.data.to_vec())
    })));
    send(
        id,
        r#"{"version":1,"kind":"bind","attach_id":"fixture","connection_id":"pc"}"#,
    )
    .unwrap();
    let mut frame = I420Buffer::new(64, 32);
    let (y, u, v) = frame.data_mut();
    y.fill(82);
    u.fill(90);
    v.fill(240);
    let start = Instant::now();
    let mut timestamp = 1_000_000;
    while packets.lock().unwrap().is_empty() {
        assert!(start.elapsed() < Duration::from_secs(8));
        timestamp += 50_000;
        source.capture_frame(&VideoFrame {
            rotation: VideoRotation::VideoRotation0,
            timestamp_us: timestamp,
            frame_metadata: None,
            buffer: &frame,
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let packet = packets.lock().unwrap()[0].clone();
    assert_eq!(&packet[..4], b"RDF1");
    let sequence = u64::from_le_bytes(packet[4..12].try_into().unwrap()).to_string();
    assert_eq!(u32::from_le_bytes(packet[12..16].try_into().unwrap()), 64);
    assert_eq!(packet.len(), 32 + 64 * 32 * 4);
    assert!(packet[32] > 170 && packet[33] < 80 && packet[34] < 80);
    assert_eq!(received.lock().unwrap().len(), 1);
    for _ in 0..5 {
        timestamp += 50_000;
        source.capture_frame(&VideoFrame {
            rotation: VideoRotation::VideoRotation0,
            timestamp_us: timestamp,
            frame_metadata: None,
            buffer: &frame,
        });
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    assert_eq!(
        packets.lock().unwrap().len(),
        1,
        "only one binary frame may wait for presentation ACK"
    );
    acknowledge(id, &sequence).unwrap();
    assert!(acknowledge(id, &sequence).is_err());
    assert!(stats(id)
        .await
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["type"] == "inbound-rtp" && s["framesDecoded"].as_u64().unwrap_or(0) > 0));
    close("retired-other-peer");
    assert!(lookup(id).is_ok());
    close(id);
    assert!(lookup(id).is_err());
    assert!(send(
        id,
        r#"{"kind":"key","control_generation":"1","body":{"usage":4,"down":true}}"#
    )
    .is_err());
    sender.close();
}
