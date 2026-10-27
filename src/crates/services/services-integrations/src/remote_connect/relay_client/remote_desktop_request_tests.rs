//! Real Socket.IO requests/ACKs with a deliberately delayed server response.
//! This exercises connection fencing, not the Relay's authorization policy.
use super::*;
use crate::remote_connect::{device_crypto, encryption, remote_desktop_device::encrypt_signal};
use futures::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

struct Call {
    wire: Value,
    reply: oneshot::Sender<Value>,
}

#[tokio::test]
async fn remote_desktop_host_authenticates_without_registering_agent_rpc() {
    for desktop_only in [false, true] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server =
            tokio::spawn(async move {
                let (tcp, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
                socket
                    .send(Message::Text(
                        format!(
                            "0{}",
                            json!({
                                "sid":"desktop-only", "upgrades":[], "pingInterval":30000,
                                "pingTimeout":30000, "maxPayload":1000000
                            })
                        )
                        .into(),
                    ))
                    .await
                    .unwrap();
                let auth = socket.next().await.unwrap().unwrap().into_text().unwrap();
                assert!(auth.starts_with("40"));
                let auth: Value = serde_json::from_str(&auth[2..]).unwrap();
                assert_eq!(auth["clientType"], "machine-scoped");
                socket
                    .send(Message::Text("40{\"sid\":\"desktop-only\"}".into()))
                    .await
                    .unwrap();
                socket.send(Message::Text(format!("42{}", json!([
                "auth-ok", {"userId":"remote-desktop-self-hosted", "deviceId":"host"}
            ])).into())).await.unwrap();
                let packet = socket.next().await.unwrap().unwrap().into_text().unwrap();
                assert!(packet.starts_with("42"));
                let body = packet.find('[').unwrap();
                let ack: u64 = packet[2..body].parse().unwrap();
                let event: Value = serde_json::from_str(&packet[body..]).unwrap();
                assert_eq!(
                    event[0],
                    if desktop_only {
                        "rd-register"
                    } else {
                        "rpc-register"
                    }
                );
                let reply = if desktop_only {
                    assert_eq!(event[1]["version"], 1);
                    json!({"ok":true,"version":1})
                } else {
                    json!({"ok":false,"error":"remote_desktop_only"})
                };
                socket
                    .send(Message::Text(format!("43{ack}{}", json!([reply])).into()))
                    .await
                    .unwrap();
                // Keep the actual socket alive until the client relinquishes it.
                while let Some(Ok(packet)) = socket.next().await {
                    if packet.is_close() || packet.to_text().is_ok_and(|text| text == "41") {
                        break;
                    }
                }
            });
        let (client, _events) = if desktop_only {
            RelayClient::new_remote_desktop()
        } else {
            RelayClient::new()
        };
        client.connect(&format!("http://{address}")).await.unwrap();
        let authenticated = client.connect_authenticated("fixture-token", "Host").await;
        if desktop_only {
            authenticated.unwrap();
            client
                .register_remote_desktop(&capabilities())
                .await
                .unwrap();
        } else {
            assert!(
                authenticated.is_err(),
                "Agent hosts still require their RPC registration"
            );
        }
        client.disconnect().await;
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
    }
}

struct Fixture {
    client: Arc<RelayClient>,
    calls: mpsc::UnboundedReceiver<Call>,
    _events: mpsc::Receiver<super::super::RelayEvent>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl Fixture {
    async fn new() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (sent, calls) = mpsc::unbounded_channel();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
            socket
                .send(Message::Text(
                    format!(
                        "0{}",
                        json!({
                            "sid":"fixture", "upgrades":[], "pingInterval":30000,
                            "pingTimeout":30000, "maxPayload":1000000
                        })
                    )
                    .into(),
                ))
                .await
                .unwrap();
            let auth = socket.next().await.unwrap().unwrap().into_text().unwrap();
            assert!(auth.starts_with("40"));
            let auth: Value = serde_json::from_str(&auth[2..]).unwrap();
            assert_eq!(auth["clientType"], "user-scoped");
            socket
                .send(Message::Text("40{\"sid\":\"fixture\"}".into()))
                .await
                .unwrap();
            socket
                .send(Message::Text(
                    format!(
                        "42{}",
                        json!([
                            "auth-ok", {"userId":"account", "deviceId":"controller"}
                        ])
                    )
                    .into(),
                ))
                .await
                .unwrap();
            while let Some(Ok(Message::Text(packet))) = socket.next().await {
                if packet == "3" {
                    continue;
                }
                if packet == "41" {
                    break;
                }
                assert!(packet.starts_with("42"));
                let body = packet.find('[').unwrap();
                let ack: u64 = packet[2..body].parse().unwrap();
                let value: Value = serde_json::from_str(&packet[body..]).unwrap();
                // A controller never registers a capture provider or invokes
                // a generic Agent command as a signaling fallback.
                assert_eq!(value[0], "rd-call");
                let (reply, received) = oneshot::channel();
                if sent
                    .send(Call {
                        wire: value[1].clone(),
                        reply,
                    })
                    .is_err()
                {
                    break;
                }
                let Ok(response) = received.await else {
                    break;
                };
                if socket
                    .send(Message::Text(
                        format!("43{ack}{}", json!([response])).into(),
                    ))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        let (client, events) = RelayClient::new_controller();
        client.connect(&format!("http://{address}")).await.unwrap();
        client
            .connect_authenticated("public-test-token", "Controller")
            .await
            .unwrap();
        Self {
            client: Arc::new(client),
            calls,
            _events: events,
            server,
        }
    }

    async fn next(&mut self) -> Call {
        tokio::time::timeout(Duration::from_secs(3), self.calls.recv())
            .await
            .unwrap()
            .unwrap()
    }
}

fn capabilities() -> Vec<String> {
    vec!["remote_desktop_route_v1".into()]
}

fn encrypted() -> EncryptedSignal {
    encrypt_signal(
        &[7; 32],
        &device_crypto::public_key(&[11; 32]),
        r#"{"version":1,"op":"capabilities"}"#,
    )
    .unwrap()
}

fn start(
    client: &Arc<RelayClient>,
    ticket: RemoteDesktopConnection,
    attachment: Option<&str>,
) -> tokio::task::JoinHandle<Result<EncryptedSignal>> {
    let client = client.clone();
    let attachment = attachment.map(str::to_owned);
    tokio::spawn(async move {
        client
            .request_remote_desktop(
                &ticket,
                "desktop",
                attachment.as_deref(),
                &encrypted(),
                &capabilities(),
            )
            .await
    })
}

#[tokio::test]
async fn remote_desktop_controller_uses_encrypted_dedicated_lane_without_host_registration() {
    let mut fixture = Fixture::new().await;
    let ticket = fixture.client.remote_desktop_connection().unwrap();
    let call = start(&fixture.client, ticket.clone(), None);
    let request = fixture.next().await;
    assert_eq!(request.wire["version"], 1);
    assert_eq!(request.wire["targetDeviceId"], "desktop");
    assert_eq!(request.wire["timeoutMs"], 10000);
    assert!(request.wire.get("attachId").is_none());
    assert!(request.wire.get("method").is_none());
    assert!(request.wire["params"].get("op").is_none());
    let key =
        device_crypto::derive_message_key(&[11; 32], &device_crypto::public_key(&[7; 32])).unwrap();
    assert_eq!(
        encryption::decrypt_from_base64(
            &key,
            request.wire["params"]["encrypted_data"].as_str().unwrap(),
            request.wire["params"]["nonce"].as_str().unwrap()
        )
        .unwrap(),
        r#"{"version":1,"op":"capabilities"}"#
    );
    let response = encrypt_signal(
        &[11; 32],
        &device_crypto::public_key(&[7; 32]),
        r#"{"protocol_versions":[1]}"#,
    )
    .unwrap();
    request
        .reply
        .send(json!({"ok":true,"result":response}))
        .unwrap();
    let reply = call.await.unwrap().unwrap();
    assert_eq!(
        encryption::decrypt_from_base64(&key, &reply.encrypted_data, &reply.nonce).unwrap(),
        r#"{"protocol_versions":[1]}"#
    );
    assert!(fixture.client.remote_desktop_connection_is_current(&ticket));
    {
        let owner = fixture.client.owner.lock().unwrap();
        assert!(!owner.remote_desktop_requested && !owner.remote_desktop_registered);
    }

    let call = start(&fixture.client, ticket, Some("attachment"));
    let request = fixture.next().await;
    assert_eq!(request.wire["attachId"], "attachment");
    request
        .reply
        .send(json!({"ok":false,"error":"device_approval_required"}))
        .unwrap();
    assert_eq!(
        call.await.unwrap().err().unwrap().to_string(),
        "device_approval_required"
    );
    assert!(fixture.calls.try_recv().is_err());
    fixture.client.disconnect().await;
}

#[tokio::test]
async fn remote_desktop_controller_rejects_unsupported_invalid_and_foreign_connections_before_send()
{
    let fixture = Fixture::new().await;
    let mut other = Fixture::new().await;
    let ticket = fixture.client.remote_desktop_connection().unwrap();
    // Both counters match; owner identity must still reject a foreign token.
    let other_ticket = other.client.remote_desktop_connection().unwrap();
    assert_eq!(ticket.epoch, other_ticket.epoch);
    assert_eq!(ticket.socket_generation, other_ticket.socket_generation);
    assert!(!other.client.remote_desktop_connection_is_current(&ticket));
    assert_eq!(
        start(&other.client, ticket, None)
            .await
            .unwrap()
            .err()
            .unwrap()
            .to_string(),
        "remote_desktop_connection_changed"
    );
    for (target, attachment, caps) in [
        ("desktop", None, vec![]),
        ("desktop:invoke", None, capabilities()),
        ("desktop", Some(""), capabilities()),
    ] {
        assert!(other
            .client
            .request_remote_desktop(&other_ticket, target, attachment, &encrypted(), &caps)
            .await
            .is_err());
    }
    let invalid = EncryptedSignal {
        encrypted_data: String::new(),
        nonce: "nonce".into(),
    };
    assert!(other
        .client
        .request_remote_desktop(&other_ticket, "desktop", None, &invalid, &capabilities())
        .await
        .is_err());
    assert!(other.calls.try_recv().is_err());
    other.client.disconnect().await;
    assert!(other.client.remote_desktop_connection().is_err());
    assert!(!other
        .client
        .remote_desktop_connection_is_current(&other_ticket));
    fixture.client.disconnect().await;
}

#[tokio::test]
async fn remote_desktop_controller_discards_delayed_success_and_error_after_owner_changes() {
    let mut fixture = Fixture::new().await;
    for (change, success) in [("epoch", true), ("socket", true), ("state", false)] {
        let ticket = fixture.client.remote_desktop_connection().unwrap();
        let call = start(&fixture.client, ticket.clone(), Some("attachment"));
        let request = fixture.next().await;
        // Exercise the real outstanding Socket.IO ACK while changing exactly
        // the owner's account/socket/liveness facts; keep the old transport
        // alive so an otherwise-valid late ACK actually arrives.
        {
            let mut owner = fixture.client.owner.lock().unwrap();
            match change {
                "epoch" => owner.epoch += 1,
                "socket" => owner.socket_generation += 1,
                _ => owner.state = ConnectionState::Reconnecting,
            }
        }
        let response = if success {
            json!({"ok":true,"result":encrypted()})
        } else {
            json!({"ok":false,"error":"target_offline"})
        };
        request.reply.send(response).unwrap();
        assert_eq!(
            call.await.unwrap().err().unwrap().to_string(),
            "remote_desktop_connection_changed"
        );
        assert!(!fixture.client.remote_desktop_connection_is_current(&ticket));
        assert_eq!(
            start(&fixture.client, ticket, None)
                .await
                .unwrap()
                .err()
                .unwrap()
                .to_string(),
            "remote_desktop_connection_changed"
        );
        assert!(fixture.calls.try_recv().is_err());
        fixture.client.owner.lock().unwrap().state = ConnectionState::Connected;
    }
    fixture.client.disconnect().await;
}
