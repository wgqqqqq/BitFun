//! Shared Happy-style Socket.IO RPC adapter for product hosts and controllers.
//! IO, acknowledgement ownership and admission stay below platform adapters.
use anyhow::{anyhow, bail, Result};
use futures::{stream::FuturesUnordered, StreamExt};
use serde_json::{json, Value};
use sioc::prelude::*;
use std::time::Duration;

/// Authentication payload shared by all Rust hosts and controllers.
///
/// Every (re)connect carries the build string and control-contract protocol
/// number so the Relay can gate compatibility instead of treating this device
/// as legacy.
pub fn account_auth_payload(token: &str, machine: bool) -> Value {
    json!({
        "token": token,
        "clientType": if machine { "machine-scoped" } else { "user-scoped" },
        "clientVersion": openbitfun_product_domains::account::client_version(),
        "clientProtocol": openbitfun_product_domains::account::CLIENT_PROTOCOL_VERSION,
    })
}

#[derive(Debug, AckType, SerializePayload, DeserializePayload)]
pub struct JsonAck(pub Value);

macro_rules! json_event {
    ($name:ident, $wire:literal, $ack:ty) => {
        #[derive(Debug, SerializePayload, DeserializePayload)]
        pub struct $name(pub Value);
        impl EventType for $name {
            const NAME: &'static str = $wire;
            type Ack = $ack;
            type Binary = NoBinary;
        }
    };
}
json_event!(RpcCall, "rpc-call", HasAck<JsonAck>);
json_event!(RpcRegister, "rpc-register", HasAck<JsonAck>);
json_event!(RpcRequest, "rpc-request", HasAck<JsonAck>);
json_event!(RemoteDesktopCall, "rd-call", HasAck<JsonAck>);
json_event!(RemoteDesktopRegister, "rd-register", HasAck<JsonAck>);
json_event!(RemoteDesktopRequest, "rd-request", HasAck<JsonAck>);
json_event!(RemoteDesktopNotice, "rd-notice", HasAck<JsonAck>);
json_event!(RemoteDesktopEnd, "rd-end", HasAck<JsonAck>);
json_event!(AuthOk, "auth-ok", NoAck);
json_event!(Update, "update", NoAck);
json_event!(Ephemeral, "ephemeral", NoAck);
json_event!(MachineEvent, "machine-event", HasAck<JsonAck>);
json_event!(Registered, "rpc-registered", NoAck);

#[derive(Debug, EventRouter)]
pub enum Incoming {
    AuthOk(Event<AuthOk>),
    RpcRequest(Event<RpcRequest>),
    RemoteDesktopRequest(Event<RemoteDesktopRequest>),
    RemoteDesktopNotice(Event<RemoteDesktopNotice>),
    Update(Event<Update>),
    Ephemeral(Event<Ephemeral>),
    Registered(Event<Registered>),
}

/// One connection epoch. The owner replaces this entire object on reconnect;
/// outstanding calls never migrate to a new socket or retry automatically.
pub struct RealtimeConnection {
    sender: SocketSender,
    receiver: SocketReceiver,
    downloads: FuturesUnordered<futures::future::BoxFuture<'static, Result<Option<Incoming>>>>,
    client: Client,
    payloads: super::realtime_payload::PayloadClient,
    pub user_id: String,
    pub device_id: String,
}

#[derive(Clone)]
pub struct RealtimeSender {
    sender: SocketSender,
    payloads: super::realtime_payload::PayloadClient,
}

#[derive(Clone, Copy)]
pub(crate) enum RealtimeRole {
    AgentHost,
    Controller,
    RemoteDesktopHost,
}

impl RealtimeConnection {
    pub async fn connect(relay_url: &str, token: &str, machine: bool) -> Result<Self> {
        let role = if machine {
            RealtimeRole::AgentHost
        } else {
            RealtimeRole::Controller
        };
        Self::connect_with_role(relay_url, token, role).await
    }

    pub(crate) async fn connect_with_role(
        relay_url: &str,
        token: &str,
        role: RealtimeRole,
    ) -> Result<Self> {
        super::relay_client::ensure_rustls_crypto_provider();
        let mut base = reqwest::Url::parse(relay_url)?;
        if !matches!(base.scheme(), "http" | "https")
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
        {
            bail!("Invalid Relay URL");
        }
        // url::join treats a final segment as a file unless it ends in '/'.
        // Preserve the official versioned Relay mount as well as local roots.
        base.set_path(&format!("{}/", base.path().trim_end_matches('/')));
        let payloads = super::realtime_payload::PayloadClient::new(&base, token)?;
        let client = ClientBuilder::new(base)
            .path("v1/updates/")
            .transport(TransportStrategy::WebSocket)
            .channels(64usize)
            .http_client(super::relay_http::relay_http_client().clone())
            .open()?;
        let auth =
            account_auth_payload(token, !matches!(role, RealtimeRole::Controller)).to_string();
        let (sender, mut receiver) = client.connect_with("/", auth).await?;
        let identity = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                match receiver
                    .recv()
                    .await
                    .ok_or_else(|| anyhow!("Relay connection closed"))?
                {
                    Signal::Event(event) => {
                        if let Incoming::AuthOk(event) = Incoming::try_from(event)? {
                            return Ok::<_, anyhow::Error>(event.payload.0);
                        }
                    }
                    Signal::Connect(_) => {}
                    Signal::ConnectError(_) => bail!("Relay authentication rejected"),
                    Signal::Disconnect => {
                        bail!("Relay disconnected before authentication completed")
                    }
                }
            }
        })
        .await
        .map_err(|_| anyhow!("Relay authentication timed out"))??;
        let connection = Self {
            sender,
            receiver,
            downloads: FuturesUnordered::new(),
            client,
            payloads,
            user_id: identity["userId"]
                .as_str()
                .ok_or_else(|| anyhow!("Missing account identity"))?
                .into(),
            device_id: identity["deviceId"]
                .as_str()
                .ok_or_else(|| anyhow!("Missing device identity"))?
                .into(),
        };
        // A desktop-only service explicitly refuses Agent RPC. Keep machine
        // presence for its capture host without registering the invoke lane.
        if matches!(role, RealtimeRole::AgentHost) {
            let ack = connection
                .sender
                .emit(RpcRegister(
                    json!({"method":format!("{}:invoke",connection.device_id)}),
                ))
                .await?
                .timeout(Duration::from_secs(10))
                .await?;
            if ack.payload.0["ok"] != true {
                bail!("Relay RPC registration rejected");
            }
        }
        Ok(connection)
    }
    pub fn sender(&self) -> RealtimeSender {
        RealtimeSender {
            sender: self.sender.clone(),
            payloads: self.payloads.clone(),
        }
    }
    pub async fn receive(&mut self) -> Result<Incoming> {
        loop {
            let signal = tokio::select! {
                completed = self.downloads.next(), if !self.downloads.is_empty() => {
                    if let Some(incoming) = completed { if let Some(incoming) = incoming? { return Ok(incoming); } }
                    continue;
                }
                signal = self.receiver.recv() => signal.ok_or_else(|| anyhow!("Relay connection closed"))?,
            };
            match signal {
                Signal::Event(event) => {
                    let incoming = Incoming::try_from(event)?;
                    if let Incoming::RpcRequest(mut request) = incoming {
                        let payloads = self.payloads.clone();
                        let sender = self.sender.clone();
                        self.downloads.push(Box::pin(async move {
                            let params = request
                                .payload
                                .0
                                .get_mut("params")
                                .ok_or_else(|| anyhow!("RPC params missing"))?;
                            match payloads.resolve(params.take()).await {
                                Ok(resolved) => *params = resolved,
                                Err(_) => {
                                    let _ = sender.acknowledge(request.id, JsonAck(json!({"$relayError":"RPC payload unavailable; request was not executed"}))).await;
                                    return Ok(None);
                                }
                            }
                            Ok(Some(Incoming::RpcRequest(request)))
                        }));
                    } else {
                        return Ok(incoming);
                    }
                }
                Signal::Connect(_) => {}
                Signal::ConnectError(_) => bail!("Relay authentication rejected"),
                Signal::Disconnect => bail!("Relay disconnected"),
            }
        }
    }
    pub async fn close(self) {
        // A server-initiated close may already have stopped the Socket.IO
        // manager. Do not let graceful teardown block the reconnect owner.
        let _ = tokio::time::timeout(Duration::from_secs(5), self.sender.disconnect()).await;
        drop(self.sender);
        drop(self.receiver);
        // Joining releases the Engine.IO heartbeat and socket tasks as well as
        // the namespace. A replacement connection has no abandoned owner.
        let _ = tokio::time::timeout(Duration::from_secs(5), self.client.join()).await;
    }
}
impl RealtimeSender {
    /// A caller supplies capabilities from a successful /api/info read. Failed
    /// discovery must remain a transport failure, never an empty capability list.
    pub async fn register_remote_desktop(&self, capabilities: &[String]) -> Result<()> {
        ensure_remote_desktop_route(capabilities)?;
        let ack = self
            .sender
            .emit(RemoteDesktopRegister(json!({"version":1})))
            .await?
            .timeout(Duration::from_secs(10))
            .await?;
        if ack.payload.0["ok"] != true || ack.payload.0["version"] != 1 {
            bail!("Remote desktop registration rejected");
        }
        Ok(())
    }

    /// Dedicated signaling never uploads bulk payloads or falls back to invoke.
    /// The sender is tied to one socket epoch; a lost ACK is not retried.
    pub async fn call_remote_desktop(
        &self,
        target: &str,
        params: Value,
        timeout: Duration,
        capabilities: &[String],
    ) -> Result<Value> {
        ensure_remote_desktop_route(capabilities)?;
        let request = remote_desktop_call(target, params, timeout)?;
        self.submit_remote_desktop(request, timeout).await
    }

    pub async fn call_remote_desktop_attachment(
        &self,
        target: &str,
        attach_id: &str,
        params: Value,
        timeout: Duration,
        capabilities: &[String],
    ) -> Result<Value> {
        ensure_remote_desktop_route(capabilities)?;
        let mut request = remote_desktop_call(target, params, timeout)?;
        validate_remote_desktop_attachment(attach_id)?;
        request["attachId"] = json!(attach_id);
        self.submit_remote_desktop(request, timeout).await
    }

    async fn submit_remote_desktop(&self, request: Value, timeout: Duration) -> Result<Value> {
        let ack = tokio::time::timeout(timeout + Duration::from_secs(2), async {
            self.sender
                .emit(RemoteDesktopCall(request))
                .await?
                .timeout(timeout)
                .await
                .map_err(anyhow::Error::from)
        })
        .await
        .map_err(|_| {
            anyhow!("Remote desktop acknowledgement timed out; delivery outcome is unknown")
        })??;
        let value = ack.payload.0;
        if value["ok"] != true {
            bail!(
                "{}",
                value["error"]
                    .as_str()
                    .unwrap_or("Remote desktop request rejected")
            );
        }
        let result = value
            .get("result")
            .cloned()
            .ok_or_else(|| anyhow!("Remote desktop response missing result"))?;
        validate_remote_desktop_ciphertext(&result)?;
        Ok(result)
    }

    pub async fn respond_remote_desktop_notice(
        &self,
        id: AckId<JsonAck>,
        attach_id: &str,
        handled: bool,
    ) -> Result<()> {
        tokio::time::timeout(
            Duration::from_secs(5),
            self.sender
                .acknowledge(id, JsonAck(json!({"ok":handled,"attachId":attach_id}))),
        )
        .await
        .map_err(|_| anyhow!("Remote desktop notice response timed out"))??;
        Ok(())
    }

    pub async fn respond_remote_desktop(&self, id: AckId<JsonAck>, result: Value) -> Result<()> {
        if result.get("$relayError").and_then(Value::as_str).is_none() {
            validate_remote_desktop_ciphertext(&result)?;
        }
        tokio::time::timeout(
            Duration::from_secs(5),
            self.sender.acknowledge(id, JsonAck(result)),
        )
        .await
        .map_err(|_| anyhow!("Remote desktop response write timed out"))??;
        Ok(())
    }

    pub async fn end_remote_desktop(&self, attach_id: &str) -> Result<()> {
        validate_remote_desktop_attachment(attach_id)?;
        let ack = tokio::time::timeout(Duration::from_secs(5), async {
            self.sender
                .emit(RemoteDesktopEnd(json!({"version":1,"attachId":attach_id})))
                .await?
                .timeout(Duration::from_secs(5))
                .await
                .map_err(anyhow::Error::from)
        })
        .await
        .map_err(|_| anyhow!("Remote desktop cleanup acknowledgement timed out"))??;
        if ack.payload.0["ok"] != true {
            bail!("Remote desktop cleanup rejected");
        }
        Ok(())
    }
    pub async fn event(&self, target: &str, params: Value) -> Result<()> {
        let response = self
            .sender
            .emit(MachineEvent(
                json!({"targetDeviceId":target,"params":params}),
            ))
            .await?
            .timeout(Duration::from_secs(10))
            .await?;
        if response.payload.0["ok"] != true {
            bail!("Relay event rejected");
        }
        Ok(())
    }
    pub async fn call(&self, target: &str, params: Value) -> Result<Value> {
        let params = self.payloads.upload_if_large(params).await?;
        let ack = tokio::time::timeout(Duration::from_secs(125), async {
            self.sender
                .emit(RpcCall(
                    json!({"method":format!("{target}:invoke"),"params":params,"timeoutMs":120_000}),
                ))
                .await?
                .timeout(Duration::from_secs(123))
                .await
                .map_err(anyhow::Error::from)
        })
        .await
        .map_err(|_| anyhow!("Relay RPC timed out; delivery outcome is unknown"))??;
        let result = ack.payload.0;
        if result["ok"] != true {
            bail!("{}", result["error"].as_str().unwrap_or("Relay RPC failed"));
        }
        self.payloads
            .resolve(
                result
                    .get("result")
                    .cloned()
                    .ok_or_else(|| anyhow!("Relay RPC response missing result"))?,
            )
            .await
    }
    pub async fn respond(&self, id: AckId<JsonAck>, result: Value) -> Result<()> {
        let result = self.payloads.upload_if_large(result).await?;
        tokio::time::timeout(
            Duration::from_secs(10),
            self.sender.acknowledge(id, JsonAck(result)),
        )
        .await
        .map_err(|_| anyhow!("Relay response write timed out"))??;
        Ok(())
    }
}

pub(super) fn ensure_remote_desktop_route(capabilities: &[String]) -> Result<()> {
    if !capabilities
        .iter()
        .any(|value| value == "remote_desktop_route_v1")
    {
        bail!("relay_upgrade_required");
    }
    Ok(())
}

fn validate_remote_desktop_ciphertext(value: &Value) -> Result<()> {
    let (Some(data), Some(nonce)) = (value["encrypted_data"].as_str(), value["nonce"].as_str())
    else {
        bail!("Invalid remote desktop encryption envelope");
    };
    if data.is_empty() || data.len() > 128 * 1024 || nonce.is_empty() || nonce.len() > 128 {
        bail!("Remote desktop encryption envelope exceeds signaling bounds");
    }
    Ok(())
}

pub(super) fn validate_remote_desktop_attachment(attach_id: &str) -> Result<()> {
    if attach_id.is_empty()
        || attach_id.len() > 128
        || !attach_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
    {
        bail!("Invalid remote desktop attachment ID");
    }
    Ok(())
}

fn remote_desktop_call(target: &str, params: Value, timeout: Duration) -> Result<Value> {
    if target.is_empty()
        || target.len() > 128
        || !target
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        || timeout.as_millis() == 0
        || timeout > Duration::from_secs(30)
    {
        bail!("Invalid remote desktop target or timeout");
    }
    validate_remote_desktop_ciphertext(&params)?;
    Ok(json!({"version":1,"targetDeviceId":target,"params":params,"timeoutMs":timeout.as_millis()}))
}

#[cfg(test)]
mod remote_desktop_tests {
    use super::*;
    #[test]
    fn signaling_lane_requires_discovery_and_rejects_general_rpc_shapes() {
        assert!(ensure_remote_desktop_route(&[]).is_err());
        assert!(ensure_remote_desktop_route(&["device_metadata_v1".into()]).is_err());
        ensure_remote_desktop_route(&["remote_desktop_route_v1".into()]).unwrap();
        let payload = json!({"encrypted_data":"cipher","nonce":"nonce"});
        let wire =
            remote_desktop_call("desktop", payload.clone(), Duration::from_secs(10)).unwrap();
        assert_eq!(wire["version"], 1);
        assert_eq!(wire["targetDeviceId"], "desktop");
        assert!(wire.get("method").is_none());
        assert!(
            remote_desktop_call("desktop:invoke", payload.clone(), Duration::from_secs(10))
                .is_err()
        );
        assert!(remote_desktop_call("desktop", payload.clone(), Duration::from_secs(31)).is_err());
        assert!(remote_desktop_call("desktop", payload, Duration::ZERO).is_err());
        assert!(validate_remote_desktop_ciphertext(&json!({"op":"attach"})).is_err());
        assert!(validate_remote_desktop_ciphertext(
            &json!({"encrypted_data":"x".repeat(128*1024+1),"nonce":"n"})
        )
        .is_err());
    }
}
