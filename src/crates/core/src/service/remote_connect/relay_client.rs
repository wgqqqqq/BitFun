//! WebSocket client for connecting to the Relay Server.
//!
//! Manages the desktop-side WebSocket connection, sends/receives relay protocol messages,
//! and dispatches events to the pairing and session bridge layers.
//!
//! Supports automatic reconnect: when the connection drops, it retries with exponential
//! backoff and re-creates the same room (same room_id + public_key) so that in-flight
//! QR codes remain valid.

use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use log::{debug, error, info, warn};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use tokio_tungstenite::tungstenite::Message;

type WsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

/// Messages in the relay protocol (both directions).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RelayMessage {
    CreateRoom {
        room_id: Option<String>,
        device_id: String,
        device_type: String,
        public_key: String,
    },
    RoomCreated {
        room_id: String,
    },
    JoinRoom {
        room_id: String,
        device_id: String,
        device_type: String,
        public_key: String,
    },
    PeerJoined {
        device_id: String,
        device_type: String,
        public_key: String,
    },
    Relay {
        room_id: String,
        encrypted_data: String,
        nonce: String,
    },
    Heartbeat,
    HeartbeatAck,
    PeerDisconnected {
        device_id: String,
    },
    Error {
        message: String,
    },
}

/// Events emitted by the relay client to the upper layers.
#[derive(Debug, Clone)]
pub enum RelayEvent {
    Connected,
    RoomCreated { room_id: String },
    PeerJoined { public_key: String, device_id: String },
    MessageReceived { encrypted_data: String, nonce: String },
    PeerDisconnected { device_id: String },
    /// Emitted after a successful automatic reconnect + room recreation.
    Reconnected,
    Disconnected,
    Error { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
}

/// Information kept to rebuild the room after a reconnect.
#[derive(Debug, Clone, Default)]
struct ReconnectCtx {
    ws_url: String,
    device_id: String,
    room_id: String,
    public_key: String,
}

pub struct RelayClient {
    state: Arc<RwLock<ConnectionState>>,
    event_tx: mpsc::UnboundedSender<RelayEvent>,
    cmd_tx: Arc<RwLock<Option<mpsc::UnboundedSender<RelayMessage>>>>,
    room_id: Arc<RwLock<Option<String>>>,
    reconnect_ctx: Arc<RwLock<Option<ReconnectCtx>>>,
}

impl RelayClient {
    pub fn new() -> (Self, mpsc::UnboundedReceiver<RelayEvent>) {
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let client = Self {
            state: Arc::new(RwLock::new(ConnectionState::Disconnected)),
            event_tx,
            cmd_tx: Arc::new(RwLock::new(None)),
            room_id: Arc::new(RwLock::new(None)),
            reconnect_ctx: Arc::new(RwLock::new(None)),
        };
        (client, event_rx)
    }

    pub async fn connection_state(&self) -> ConnectionState {
        self.state.read().await.clone()
    }

    /// Connect to the relay server WebSocket endpoint and start background tasks.
    pub async fn connect(&self, ws_url: &str) -> Result<()> {
        *self.state.write().await = ConnectionState::Connecting;

        let ws_stream = dial(ws_url).await?;

        info!("Connected to relay server at {ws_url}");
        *self.state.write().await = ConnectionState::Connected;

        // Record the ws_url for future reconnect
        *self.reconnect_ctx.write().await = Some(ReconnectCtx {
            ws_url: ws_url.to_string(),
            ..Default::default()
        });

        let _ = self.event_tx.send(RelayEvent::Connected);
        self.launch_tasks(ws_stream).await;
        Ok(())
    }

    /// Wire up read / write / heartbeat tasks for a live stream.
    async fn launch_tasks(&self, ws_stream: WsStream) {
        let (mut ws_write, ws_read) = ws_stream.split();
        let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<RelayMessage>();

        // Share cmd_tx so `send()` / `create_room()` / heartbeat can enqueue messages
        let cmd_tx_arc = self.cmd_tx.clone();
        let state_arc = self.state.clone();
        let room_id_arc = self.room_id.clone();
        let event_tx = self.event_tx.clone();
        let reconnect_arc = self.reconnect_ctx.clone();

        // Store cmd_tx immediately (before spawning tasks, to avoid race with create_room)
        *cmd_tx_arc.write().await = Some(cmd_tx);

        // ── Write task ────────────────────────────────────────────────────────
        tokio::spawn(async move {
            while let Some(msg) = cmd_rx.recv().await {
                if let Ok(json) = serde_json::to_string(&msg) {
                    if ws_write.send(Message::Text(json)).await.is_err() {
                        break;
                    }
                }
            }
            debug!("Write task exited");
        });

        // ── Read task with reconnect loop ─────────────────────────────────────
        let mut ws_read = ws_read;
        tokio::spawn(async move {
            'outer: loop {
                // Read messages until connection drops
                while let Some(res) = ws_read.next().await {
                    match res {
                        Ok(Message::Text(text)) => {
                            match serde_json::from_str::<RelayMessage>(&text) {
                                Ok(msg) => {
                                    Self::dispatch(msg, &event_tx, &room_id_arc).await;
                                }
                                Err(e) => {
                                    warn!("Unparseable relay msg: {e}");
                                }
                            }
                        }
                        Ok(Message::Ping(_)) => {}
                        Ok(Message::Close(_)) => {
                            info!("Relay server closed connection");
                            break;
                        }
                        Err(e) => {
                            error!("WebSocket read error: {e}");
                            break;
                        }
                        _ => {}
                    }
                }

                // Drop detected — enter reconnect loop
                *state_arc.write().await = ConnectionState::Reconnecting;
                info!("Relay connection dropped; will attempt reconnect");

                let ctx = reconnect_arc.read().await.clone();
                let Some(ctx) = ctx else {
                    info!("No reconnect ctx — giving up");
                    break 'outer;
                };

                if ctx.ws_url.is_empty() {
                    break 'outer;
                }

                let mut backoff = 2u64;
                loop {
                    if *state_arc.read().await == ConnectionState::Disconnected {
                        break 'outer;
                    }

                    info!("Reconnect in {backoff}s (url={})", &ctx.ws_url);
                    tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;

                    match dial(&ctx.ws_url).await {
                        Ok(new_stream) => {
                            info!("Reconnected to relay server at {}", &ctx.ws_url);
                            *state_arc.write().await = ConnectionState::Connected;

                            let (mut new_write, new_read) = new_stream.split();
                            let (new_cmd_tx, mut new_cmd_rx) =
                                mpsc::unbounded_channel::<RelayMessage>();
                            *cmd_tx_arc.write().await = Some(new_cmd_tx.clone());

                            // New write task
                            tokio::spawn(async move {
                                while let Some(msg) = new_cmd_rx.recv().await {
                                    if let Ok(json) = serde_json::to_string(&msg) {
                                        if new_write.send(Message::Text(json)).await.is_err()
                                        {
                                            break;
                                        }
                                    }
                                }
                            });

                            // Re-create the room so existing QR codes remain valid
                            if !ctx.room_id.is_empty() {
                                let recreate = RelayMessage::CreateRoom {
                                    room_id: Some(ctx.room_id.clone()),
                                    device_id: ctx.device_id.clone(),
                                    device_type: "desktop".to_string(),
                                    public_key: ctx.public_key.clone(),
                                };
                                let _ = new_cmd_tx.send(recreate);
                                info!("Room '{}' recreated after reconnect", &ctx.room_id);
                            }

                            let _ = event_tx.send(RelayEvent::Reconnected);
                            ws_read = new_read;
                            continue 'outer;
                        }
                        Err(e) => {
                            warn!("Reconnect attempt failed: {e}");
                            backoff = std::cmp::min(backoff * 2, 30);
                        }
                    }
                }
            }

            *state_arc.write().await = ConnectionState::Disconnected;
            let _ = event_tx.send(RelayEvent::Disconnected);
        });

        // ── Heartbeat task ────────────────────────────────────────────────────
        let hb_state = self.state.clone();
        let hb_cmd = self.cmd_tx.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                let st = hb_state.read().await.clone();
                if st == ConnectionState::Disconnected {
                    break;
                }
                if st != ConnectionState::Connected {
                    continue; // Don't heartbeat while reconnecting
                }
                if let Some(tx) = hb_cmd.read().await.as_ref() {
                    let _ = tx.send(RelayMessage::Heartbeat);
                }
            }
        });
    }

    async fn dispatch(
        msg: RelayMessage,
        event_tx: &mpsc::UnboundedSender<RelayEvent>,
        room_id_store: &Arc<RwLock<Option<String>>>,
    ) {
        match msg {
            RelayMessage::RoomCreated { room_id } => {
                debug!("Room created/restored: {room_id}");
                *room_id_store.write().await = Some(room_id.clone());
                let _ = event_tx.send(RelayEvent::RoomCreated { room_id });
            }
            RelayMessage::PeerJoined { device_id, public_key, .. } => {
                info!("Peer joined: {device_id}");
                let _ = event_tx.send(RelayEvent::PeerJoined { public_key, device_id });
            }
            RelayMessage::Relay { encrypted_data, nonce, .. } => {
                let _ = event_tx.send(RelayEvent::MessageReceived { encrypted_data, nonce });
            }
            RelayMessage::PeerDisconnected { device_id } => {
                info!("Peer disconnected: {device_id}");
                let _ = event_tx.send(RelayEvent::PeerDisconnected { device_id });
            }
            RelayMessage::HeartbeatAck => {
                debug!("Heartbeat acknowledged");
            }
            RelayMessage::Error { message } => {
                error!("Relay error: {message}");
                let _ = event_tx.send(RelayEvent::Error { message });
            }
            _ => {}
        }
    }

    /// Send a protocol message to the relay server.
    pub async fn send(&self, msg: RelayMessage) -> Result<()> {
        let guard = self.cmd_tx.read().await;
        let tx = guard.as_ref().ok_or_else(|| anyhow!("not connected"))?;
        tx.send(msg).map_err(|e| anyhow!("send failed: {e}"))?;
        Ok(())
    }

    /// Create a room on the relay server.
    ///
    /// Also records the device_id / room_id / public_key in the reconnect context
    /// so the room is automatically recreated after a transient disconnect.
    pub async fn create_room(
        &self,
        device_id: &str,
        public_key: &str,
        room_id: Option<&str>,
    ) -> Result<()> {
        // Update reconnect context with room params
        if let Some(rid) = room_id {
            let mut guard = self.reconnect_ctx.write().await;
            if let Some(ref mut ctx) = *guard {
                ctx.device_id = device_id.to_string();
                ctx.room_id = rid.to_string();
                ctx.public_key = public_key.to_string();
            }
        }

        self.send(RelayMessage::CreateRoom {
            room_id: room_id.map(|s| s.to_string()),
            device_id: device_id.to_string(),
            device_type: "desktop".to_string(),
            public_key: public_key.to_string(),
        })
        .await
    }

    /// Send an E2E-encrypted relay message.
    pub async fn send_encrypted(
        &self,
        room_id: &str,
        encrypted_data: &str,
        nonce: &str,
    ) -> Result<()> {
        self.send(RelayMessage::Relay {
            room_id: room_id.to_string(),
            encrypted_data: encrypted_data.to_string(),
            nonce: nonce.to_string(),
        })
        .await
    }

    pub async fn disconnect(&self) {
        // Signal reconnect loop to stop by clearing the context and setting state
        *self.state.write().await = ConnectionState::Disconnected;
        *self.reconnect_ctx.write().await = None;
        *self.cmd_tx.write().await = None;
        info!("Relay client disconnected");
    }

    pub fn room_id(&self) -> &Arc<RwLock<Option<String>>> {
        &self.room_id
    }
}

/// Open a plain WebSocket connection (no TLS negotiation needed — nginx handles TLS).
async fn dial(ws_url: &str) -> Result<WsStream> {
    let (stream, _) = tokio_tungstenite::connect_async(ws_url)
        .await
        .map_err(|e| anyhow!("dial {ws_url}: {e}"))?;
    Ok(stream)
}
