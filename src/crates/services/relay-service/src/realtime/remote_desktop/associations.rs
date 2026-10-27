//! Ephemeral authorization links, not media/session storage. Socket IDs and
//! credentials never leave the Relay. Notifications use the existing ACK lane.
use super::*;
use socketioxide::socket::Sid;
use tokio::time::Instant;

type Key = (String, String, String); // account, host device, attachment
const NOTICE_TIMEOUT: Duration = Duration::from_secs(5);
// Metadata cleanup follows the v1 bounded recovery window; this never grants
// permission to send pixels (the host owns its independent frame gate).
const GRACE: Duration = Duration::from_secs(30);
// Retain the old credential identity beyond transport detection + host grace.
// This is bounded metadata retention, never an extension of video authority.
const RETENTION: Duration = Duration::from_secs(120);

#[derive(Clone, PartialEq, Eq)]
struct Credential {
    account: String,
    device: String,
    token: String,
    public_key: String,
}
impl Credential {
    async fn read(state: &AppState, identity: &Identity) -> Result<Self, &'static str> {
        if !authorized_device(state, identity).await {
            return Err("authorization_expired");
        }
        let public_key = sqlx::query_scalar::<_, Option<String>>(
            "SELECT public_key FROM devices WHERE user_id=? AND device_id=?",
        )
        .bind(&identity.account)
        .bind(&identity.device)
        .fetch_optional(&*state.db)
        .await
        .map_err(|_| "authorization_unknown")?
        .flatten()
        .filter(|key| !key.is_empty())
        .ok_or("authorization_expired")?;
        Ok(Self {
            account: identity.account.clone(),
            device: identity.device.clone(),
            token: identity.token.clone(),
            public_key,
        })
    }
    async fn current(&self, state: &AppState) -> Result<bool, ()> {
        self.valid_until(state)
            .await
            .map(|expires| expires.is_some())
    }
    async fn valid_until(&self, state: &AppState) -> Result<Option<i64>, ()> {
        let auth = AuthToken::find(&state.db, &self.token)
            .await
            .map_err(|_| ())?;
        let Some(auth) = auth.filter(|auth| {
            auth.is_device_token() && auth.user_id == self.account && auth.device_id == self.device
        }) else {
            return Ok(None);
        };
        let key = sqlx::query_scalar::<_, Option<String>>(
            "SELECT public_key FROM devices WHERE user_id=? AND device_id=?",
        )
        .bind(&self.account)
        .bind(&self.device)
        .fetch_optional(&*state.db)
        .await
        .map_err(|_| ())?
        .flatten();
        Ok((key.as_deref() == Some(self.public_key.as_str())).then_some(auth.expires_at))
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Pending,
    Ready,
    Unknown(Instant),
    Ended,
}
struct Route {
    source: Sid,
    host: Sid,
    phase: Phase,
}
struct Binding {
    key: Key,
    source: Credential,
    host: Credential,
    route: Mutex<Route>,
    // Live links retain their own small permits; a completed RPC returns its
    // larger request/reply reservation independently.
    _permits: Vec<OwnedSemaphorePermit>,
}
#[derive(Default)]
pub(crate) struct Associations {
    bindings: Mutex<HashMap<Key, Arc<Binding>>>,
}

pub(super) struct Pending {
    registry: Weak<Associations>,
    binding: Arc<Binding>,
    created: bool,
}
impl Drop for Pending {
    fn drop(&mut self) {
        if self.created && self.binding.route.lock().unwrap().phase == Phase::Pending {
            if let Some(registry) = self.registry.upgrade() {
                registry.remove(&self.binding);
            }
        }
    }
}

impl Associations {
    /// HTTP credentials require the exact live link and original device token.
    /// Online presence or a replacement token for the same device is insufficient.
    pub(crate) async fn turn_authority(
        &self,
        state: &AppState,
        auth: &AuthToken,
        host: &str,
        attachment: &str,
    ) -> Result<i64, &'static str> {
        if !auth.is_device_token() {
            return Err("forbidden");
        }
        let binding = self
            .bindings
            .lock()
            .unwrap()
            .get(&(auth.user_id.clone(), host.into(), attachment.into()))
            .cloned()
            .ok_or("attachment_unavailable")?;
        if binding.route.lock().unwrap().phase != Phase::Ready {
            return Err("attachment_unavailable");
        }
        let participant = |credential: &Credential| {
            credential.account == auth.user_id
                && credential.device == auth.device_id
                && credential.token == auth.token
        };
        if !participant(&binding.source) && !participant(&binding.host) {
            return Err("forbidden");
        }
        let source_expiry = binding
            .source
            .valid_until(state)
            .await
            .map_err(|_| "authorization_unknown")?
            .ok_or("authorization_expired")?;
        let host_expiry = binding
            .host
            .valid_until(state)
            .await
            .map_err(|_| "authorization_unknown")?
            .ok_or("authorization_expired")?;
        if binding.route.lock().unwrap().phase != Phase::Ready {
            return Err("attachment_unavailable");
        }
        Ok(source_expiry.min(host_expiry))
    }
    fn remove(&self, binding: &Arc<Binding>) {
        let mut bindings = self.bindings.lock().unwrap();
        if bindings
            .get(&binding.key)
            .is_some_and(|current| Arc::ptr_eq(current, binding))
        {
            bindings.remove(&binding.key);
        }
    }

    pub(super) async fn begin(
        self: &Arc<Self>,
        state: &AppState,
        io: &SocketIo,
        source: &SocketRef,
        host: &SocketRef,
        attach_id: &str,
    ) -> Result<Pending, &'static str> {
        let source_identity = source.extensions.get::<Identity>().ok_or("forbidden")?;
        let host_identity = host.extensions.get::<Identity>().ok_or("forbidden")?;
        let source_credential = Credential::read(state, &source_identity).await?;
        let host_credential = Credential::read(state, &host_identity).await?;
        let key = (
            host_identity.account.clone(),
            host_identity.device.clone(),
            attach_id.to_owned(),
        );
        let cost = (8192
            + 4 * (source_credential.token.len()
                + host_credential.token.len()
                + source_credential.public_key.len()
                + host_credential.public_key.len()
                + key.0.len()
                + key.1.len()
                + key.2.len())) as u32;
        let existing = self.bindings.lock().unwrap().get(&key).cloned();
        if let Some(binding) = existing {
            if binding.source != source_credential || binding.host != host_credential {
                return Err("attachment_identity_changed");
            }
            let changed = {
                let route = binding.route.lock().unwrap();
                if route.phase == Phase::Ended {
                    return Err("attachment_binding_changed");
                }
                if (route.source != source.id
                    && io
                        .get_socket(route.source)
                        .is_some_and(|socket| socket.connected()))
                    || (route.host != host.id
                        && io
                            .get_socket(route.host)
                            .is_some_and(|socket| socket.connected()))
                {
                    return Err("attachment_binding_changed");
                }
                route.source != source.id || route.host != host.id
            };
            if changed {
                self.notify(io, &binding, "unknown").await;
            }
            {
                let mut route = binding.route.lock().unwrap();
                if route.phase == Phase::Ended
                    || matches!(route.phase, Phase::Unknown(first) if first.elapsed() >= GRACE)
                {
                    return Err("attachment_binding_changed");
                }
                if (route.source != source.id
                    && io
                        .get_socket(route.source)
                        .is_some_and(|socket| socket.connected()))
                    || (route.host != host.id
                        && io
                            .get_socket(route.host)
                            .is_some_and(|socket| socket.connected()))
                {
                    return Err("attachment_binding_changed");
                }
                route.source = source.id;
                route.host = host.id;
            }
            return Ok(Pending {
                registry: Arc::downgrade(self),
                binding,
                created: false,
            });
        }
        let mut bindings = self.bindings.lock().unwrap();
        if bindings.contains_key(&key) {
            tracing::debug!(
                reason = "attachment_creation_raced",
                "Remote desktop signaling target unavailable"
            );
            return Err("target_unavailable");
        }
        let mut permits = Vec::new();
        for budget in [
            &source_identity.remote_desktop_calls,
            &source_identity.remote_desktop_server_calls,
            &source_identity.account_calls,
            &source_identity.server_calls,
        ] {
            permits.push(
                budget
                    .clone()
                    .try_acquire_many_owned(cost)
                    .map_err(|_| "capacity_exceeded")?,
            );
        }
        let binding = Arc::new(Binding {
            key: key.clone(),
            source: source_credential,
            host: host_credential,
            route: Mutex::new(Route {
                source: source.id,
                host: host.id,
                phase: Phase::Pending,
            }),
            _permits: permits,
        });
        bindings.insert(key, binding.clone());
        Ok(Pending {
            registry: Arc::downgrade(self),
            binding,
            created: true,
        })
    }

    /// Reuses the socket owner's existing five-second authentication task.
    pub(in crate::realtime) async fn check_host(
        &self,
        state: &AppState,
        io: &SocketIo,
        identity: &Identity,
    ) {
        let bindings: Vec<_> = self
            .bindings
            .lock()
            .unwrap()
            .values()
            .filter(|binding| {
                binding.host.account == identity.account && binding.host.device == identity.device
            })
            .cloned()
            .collect();
        for binding in bindings {
            let expired = matches!(binding.route.lock().unwrap().phase, Phase::Unknown(first) if first.elapsed() >= RETENTION);
            if expired {
                self.remove(&binding);
                continue;
            }
            match (
                binding.source.current(state).await,
                binding.host.current(state).await,
            ) {
                (Ok(true), Ok(true)) => {}
                (Ok(false), _) | (_, Ok(false)) => self.notify(io, &binding, "revoked").await,
                _ => self.notify(io, &binding, "unknown").await,
            }
        }
    }

    pub(in crate::realtime) async fn socket_lost(
        self: &Arc<Self>,
        io: &SocketIo,
        socket: Sid,
        revoked: bool,
    ) {
        let bindings: Vec<_> = self
            .bindings
            .lock()
            .unwrap()
            .values()
            .filter(|binding| {
                let route = binding.route.lock().unwrap();
                route.source == socket || route.host == socket
            })
            .cloned()
            .collect();
        for binding in bindings {
            self.notify(io, &binding, if revoked { "revoked" } else { "unknown" })
                .await;
            if !revoked {
                let registry = Arc::downgrade(self);
                let binding = Arc::downgrade(&binding);
                // One bounded grace cleanup, not another authentication poll.
                tokio::spawn(async move {
                    tokio::time::sleep(RETENTION).await;
                    if let (Some(registry), Some(binding)) = (registry.upgrade(), binding.upgrade())
                    {
                        let route = binding.route.lock().unwrap();
                        if matches!(route.phase, Phase::Unknown(first) if first.elapsed() >= RETENTION)
                        {
                            drop(route);
                            registry.remove(&binding);
                        }
                    }
                });
            }
        }
    }

    pub(super) async fn end_host(&self, io: &SocketIo, socket: Sid, attach_id: Option<&str>) {
        let bindings: Vec<_> = self
            .bindings
            .lock()
            .unwrap()
            .values()
            .filter(|binding| {
                binding.route.lock().unwrap().host == socket
                    && attach_id.is_none_or(|id| binding.key.2 == id)
            })
            .cloned()
            .collect();
        for binding in bindings {
            self.notify(io, &binding, "ended").await;
        }
    }

    pub(in crate::realtime) async fn account_unknown(&self, io: &SocketIo, account: &str) {
        let bindings: Vec<_> = self
            .bindings
            .lock()
            .unwrap()
            .values()
            .filter(|binding| binding.host.account == account)
            .cloned()
            .collect();
        for binding in bindings {
            self.notify(io, &binding, "unknown").await;
        }
    }

    async fn notify(&self, io: &SocketIo, binding: &Arc<Binding>, kind: &str) {
        let pending = {
            let mut route = binding.route.lock().unwrap();
            if route.phase == Phase::Ended
                || (kind == "unknown" && matches!(route.phase, Phase::Unknown(_)))
            {
                return;
            }
            route.phase = if kind == "unknown" {
                Phase::Unknown(Instant::now())
            } else {
                Phase::Ended
            };
            // Enqueue while holding the route lock so ready/invalidation cannot
            // reorder on the same host socket. Never hold it across ACK IO.
            io.get_socket(route.host)
                .filter(|host| host.connected())
                .map(|host| {
                    let pending = host.timeout(NOTICE_TIMEOUT).emit_with_ack::<_, Value>(
                        "rd-notice",
                        &json!({"version":VERSION,"attachId":binding.key.2,"kind":kind}),
                    );
                    (host, pending)
                })
        };
        if let Some((host, pending)) = pending {
            let acknowledged = match pending {
                Ok(pending) => pending
                    .await
                    .is_ok_and(|value| value["ok"] == true && value["attachId"] == binding.key.2),
                Err(_) => false,
            };
            if !acknowledged {
                let _ = host.disconnect();
            }
        }
        if kind != "unknown" {
            self.remove(binding);
        }
    }
}

impl Pending {
    /// Stable across Relay restarts, but specific to this attachment and its
    /// original credentials. Tokens never cross the host boundary.
    pub(super) fn credential_binding(&self) -> String {
        use sha2::{Digest, Sha256};
        let mut digest = Sha256::new();
        digest.update(b"openbitfun-rd-credential-binding-v1\0");
        for value in [
            self.binding.key.2.as_str(),
            &self.binding.source.account,
            &self.binding.source.device,
            &self.binding.source.token,
            &self.binding.source.public_key,
            &self.binding.host.account,
            &self.binding.host.device,
            &self.binding.host.token,
            &self.binding.host.public_key,
        ] {
            digest.update((value.len() as u64).to_be_bytes());
            digest.update(value.as_bytes());
        }
        digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    pub(super) async fn accept(
        &self,
        state: &AppState,
        io: &SocketIo,
        timeout: Duration,
    ) -> Result<(), &'static str> {
        let registry = self.registry.upgrade().ok_or_else(|| {
            tracing::debug!(
                reason = "attachment_registry_retired",
                "Remote desktop signaling target unavailable"
            );
            "target_unavailable"
        })?;
        match (
            self.binding.source.current(state).await,
            self.binding.host.current(state).await,
        ) {
            (Ok(true), Ok(true)) => {}
            (Ok(false), _) | (_, Ok(false)) => {
                registry.notify(io, &self.binding, "revoked").await;
                return Err("delivery_unknown");
            }
            _ => {
                registry.notify(io, &self.binding, "unknown").await;
                return Err("authorization_unknown");
            }
        }
        let pending = {
            let bindings = registry.bindings.lock().unwrap();
            if !bindings
                .get(&self.binding.key)
                .is_some_and(|current| Arc::ptr_eq(current, &self.binding))
            {
                return Err("delivery_unknown");
            }
            if bindings.values().any(|other| {
                other.key.0 == self.binding.key.0
                    && other.key.1 == self.binding.key.1
                    && !Arc::ptr_eq(other, &self.binding)
                    && matches!(
                        other.route.lock().unwrap().phase,
                        Phase::Ready | Phase::Unknown(_)
                    )
            }) {
                return Err("attachment_busy");
            }
            let mut route = self.binding.route.lock().unwrap();
            if !matches!(route.phase, Phase::Pending | Phase::Ready)
                && !matches!(route.phase, Phase::Unknown(first) if first.elapsed() < GRACE)
            {
                return Err("delivery_unknown");
            }
            let source = io
                .get_socket(route.source)
                .filter(|socket| socket.connected())
                .ok_or("delivery_unknown")?;
            let host = io
                .get_socket(route.host)
                .filter(|socket| socket.connected())
                .ok_or("delivery_unknown")?;
            drop(source); // Authentication above is bound to this exact socket.
            route.phase = Phase::Ready;
            let pending = host
                .timeout(timeout.min(NOTICE_TIMEOUT))
                .emit_with_ack::<_, Value>(
                    "rd-notice",
                    &json!({"version":VERSION,"attachId":self.binding.key.2,"kind":"ready"}),
                );
            (host, pending)
        };
        let accepted = match pending.1 {
            Ok(pending) => pending
                .await
                .is_ok_and(|value| value["ok"] == true && value["attachId"] == self.binding.key.2),
            Err(_) => false,
        };
        if !accepted {
            let _ = pending.0.disconnect();
            registry.remove(&self.binding);
            return Err("delivery_unknown");
        }
        Ok(())
    }
    pub(super) async fn end(&self, io: &SocketIo) {
        if let Some(registry) = self.registry.upgrade() {
            registry.notify(io, &self.binding, "ended").await;
        }
    }
}
