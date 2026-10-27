//! Real native channels only; no account, external ICE server, capture or input.
#![cfg(not(target_arch = "wasm32"))]
use libwebrtc::{
    data_channel::{DataChannel, DataChannelInit, DataChannelReliability, DataChannelState},
    peer_connection::{AnswerOptions, IceGatheringState, OfferOptions, PeerConnection},
    peer_connection_factory::{ContinualGatheringPolicy, PeerConnectionFactory, RtcConfiguration},
};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::mpsc;

struct Pair {
    peers: Vec<PeerConnection>,
    channels: Vec<DataChannel>,
}
impl Drop for Pair {
    fn drop(&mut self) {
        for peer in &self.peers {
            peer.on_data_channel(None);
            peer.on_ice_candidate(None);
        }
        for channel in &self.channels {
            channel.on_message(None);
            channel.on_state_change(None);
            channel.on_buffered_amount_change(None);
            channel.close();
        }
        for peer in &self.peers {
            peer.close();
        }
    }
}
fn config() -> RtcConfiguration {
    let mut config = RtcConfiguration::default();
    config.continual_gathering_policy = ContinualGatheringPolicy::GatherOnce;
    config
}
#[cfg(target_os = "linux")]
fn count(path: &str) -> usize {
    std::fs::read_dir(path).unwrap().count()
}
async fn workload() {
    let factory = PeerConnectionFactory::default();
    // Partially initialized and invalid-signaling paths must release too.
    {
        let mut pair = Pair {
            peers: vec![factory.create_peer_connection(config()).unwrap()],
            channels: vec![],
        };
        let channel = pair.peers[0]
            .create_data_channel("partial", DataChannelInit::default())
            .unwrap();
        assert_eq!(
            channel.reliability(),
            DataChannelReliability {
                ordered: true,
                max_packet_lifetime: None,
                max_retransmits: None
            }
        );
        pair.channels.push(channel);
        assert!(pair.peers[0]
            .create_answer(AnswerOptions::default())
            .await
            .is_err());
    }
    let mut pair = Pair {
        peers: vec![
            factory.create_peer_connection(config()).unwrap(),
            factory.create_peer_connection(config()).unwrap(),
        ],
        channels: vec![],
    };
    let cases = [
        ("ordered", true, None, None),
        ("unordered", false, None, None),
        ("zero-retransmits", true, None, Some(0)),
        ("zero-lifetime", true, Some(0), None),
        ("limited-retransmits", true, None, Some(7)),
        ("limited-lifetime", true, Some(1250), None),
    ];
    for (label, ordered, lifetime, retransmits) in cases {
        pair.channels.push(
            pair.peers[0]
                .create_data_channel(
                    label,
                    DataChannelInit {
                        ordered,
                        max_retransmit_time: lifetime,
                        max_retransmits: retransmits,
                        ..Default::default()
                    },
                )
                .unwrap(),
        );
    }
    let (tx, mut rx) = mpsc::channel::<DataChannel>(8);
    pair.peers[1].on_data_channel(Some(Box::new(move |channel| {
        if let Err(error) = tx.try_send(channel) {
            error.into_inner().close();
        }
    })));
    let candidates: Vec<_> = (0..2).map(|_| Arc::new(Mutex::new(Vec::new()))).collect();
    for (index, peer) in pair.peers.iter().enumerate() {
        let saved = candidates[index].clone();
        peer.on_ice_candidate(Some(Box::new(move |candidate| {
            saved.lock().unwrap().push(candidate);
        })));
    }
    let offer = pair.peers[0]
        .create_offer(OfferOptions::default())
        .await
        .unwrap();
    pair.peers[0]
        .set_local_description(offer.clone())
        .await
        .unwrap();
    pair.peers[1].set_remote_description(offer).await.unwrap();
    let answer = pair.peers[1]
        .create_answer(AnswerOptions::default())
        .await
        .unwrap();
    pair.peers[1]
        .set_local_description(answer.clone())
        .await
        .unwrap();
    pair.peers[0].set_remote_description(answer).await.unwrap();
    tokio::time::timeout(Duration::from_secs(8), async {
        while pair
            .peers
            .iter()
            .any(|p| p.ice_gathering_state() != IceGatheringState::Complete)
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    for index in 0..2 {
        let ready = std::mem::take(&mut *candidates[index].lock().unwrap());
        assert!(!ready.is_empty());
        for candidate in ready {
            pair.peers[1 - index]
                .add_ice_candidate(candidate)
                .await
                .unwrap();
        }
    }
    for _ in 0..cases.len() {
        let channel = tokio::time::timeout(Duration::from_secs(8), rx.recv())
            .await
            .unwrap()
            .unwrap();
        let label = channel.label();
        let (_, ordered, lifetime, retransmits) =
            cases.iter().find(|case| case.0 == label).unwrap();
        assert_eq!(
            channel.reliability(),
            DataChannelReliability {
                ordered: *ordered,
                max_packet_lifetime: *lifetime,
                max_retransmits: *retransmits
            },
            "received channel properties differ: {label}"
        );
        pair.channels.push(channel);
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        while pair
            .channels
            .iter()
            .any(|channel| channel.state() != DataChannelState::Open)
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(rx.try_recv().is_err());
    for channel in &pair.channels {
        channel.close();
    }
    for peer in &pair.peers {
        peer.close();
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        while pair
            .channels
            .iter()
            .any(|channel| channel.state() != DataChannelState::Closed)
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    drop(pair);
    drop(rx);
    drop(factory);
}
#[test]
fn native_received_reliability_and_repeated_teardown() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_time()
        .build()
        .unwrap();
    // Warm lazy process facilities before measuring repeated factory workloads.
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(30), workload())
            .await
            .unwrap()
    });
    #[cfg(target_os = "linux")]
    let baseline = (count("/proc/self/fd"), count("/proc/self/task"));
    for _ in 0..3 {
        runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(30), workload())
                .await
                .unwrap()
        });
        #[cfg(target_os = "linux")]
        {
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            loop {
                let current = (count("/proc/self/fd"), count("/proc/self/task"));
                if current.0 <= baseline.0 && current.1 <= baseline.1 {
                    break;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "native teardown grew fd/thread counts: {baseline:?} -> {current:?}"
                );
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
    runtime.shutdown_timeout(Duration::from_secs(2));
}
