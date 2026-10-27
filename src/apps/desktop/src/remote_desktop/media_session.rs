//! One app-wide media slot survives account replacement until native drainage.
//! The existing account connection owns routing; this task owns only its PC/source.
mod expiry;
mod retained;

use super::{displays::CaptureTarget, media, ControllerIdentity, Host, RelayContext};
use expiry::CredentialLifetime;
use libwebrtc::{peer_connection_factory::IceServer, video_source::VideoResolution};
use openbitfun_product_domains::remote_desktop::{AnswerRequest, MediaEffect, QualityPreset};
use openbitfun_services_integrations::remote_connect::{
    account::AccountClient, remote_desktop_device::TurnIssuanceError,
};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock, Weak,
    },
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, oneshot, Notify};

type Owner = Weak<Mutex<Option<Host>>>;
#[derive(Default)]
pub(super) struct Sessions {
    active: Arc<Mutex<Option<Arc<Slot>>>>,
    engine: Arc<OnceLock<media::Engine>>,
}
pub(super) struct PendingMedia {
    pub(super) generation: u64,
    pub(super) socket_generation: u64,
    pub(super) relay: RelayContext,
    pub(super) source: ControllerIdentity,
    pub(super) attach_id: String,
    pub(super) connection_id: String,
    pub(super) target: CaptureTarget,
    pub(super) force_relay: bool,
    pub(super) quality: QualityPreset,
    pub(super) owner: Owner,
}
enum Command {
    Answer(AnswerRequest, oneshot::Sender<Result<(), &'static str>>),
}
pub(super) struct Slot {
    pub(super) control: Arc<super::control_worker::Shared>,
    pending: PendingMedia,
    canceled: AtomicBool,
    relay_ready: AtomicBool,
    socket_generation: AtomicU64,
    wake: Notify,
    commands: mpsc::Sender<Command>,
    offer: Mutex<Option<String>>,
    negotiated: AtomicBool,
    first_submitted: AtomicBool,
    submitted: AtomicU64,
    health: Mutex<Value>,
    credentials: OnceLock<CredentialLifetime>,
    retained_until: OnceLock<Instant>,
    created: Instant,
}
impl Slot {
    fn cancel(&self) {
        self.control.invalidate(true);
        self.canceled.store(true, Ordering::Release);
        self.wake.notify_one();
    }
    fn canceled(&self) -> bool {
        self.canceled.load(Ordering::Acquire)
    }
    pub(super) fn source(&self) -> &ControllerIdentity {
        &self.pending.source
    }
    pub(super) fn connection_id(&self) -> &str {
        &self.pending.connection_id
    }
    pub(super) fn attach_id(&self) -> &str {
        &self.pending.attach_id
    }
    pub(super) fn ready(&self, socket_generation: u64) {
        self.socket_generation
            .store(socket_generation, Ordering::Release);
        self.relay_ready.store(true, Ordering::Release);
        self.wake.notify_one();
    }
    pub(super) fn lost(&self) {
        self.relay_ready.store(false, Ordering::Release);
        self.control.invalidate(false);
        self.wake.notify_one();
    }
    pub(super) async fn answer(&self, answer: AnswerRequest) -> Result<(), &'static str> {
        if self.canceled()
            || !self.credentials_valid()
            || !self.binding_allowed()
            || !answer.valid()
        {
            return Err("stale_connection");
        }
        let (response, result) = oneshot::channel();
        self.commands
            .try_send(Command::Answer(answer, response))
            .map_err(|_| "media_busy")?;
        tokio::time::timeout(Duration::from_secs(10), result)
            .await
            .map_err(|_| "delivery_unknown")?
            .map_err(|_| "delivery_unknown")?
    }
    pub(super) fn status(&self) -> Value {
        json!({"offer_sdp":self.offer.lock().unwrap().as_ref(),
            "answer_accepted":self.negotiated.load(Ordering::Acquire), "source_first_frame":self.first_submitted.load(Ordering::Acquire), "source_frames_submitted":self.submitted.load(Ordering::Acquire), "force_relay":self.pending.force_relay,"quality":self.pending.quality,"credentials_remaining_ms":self.credentials.get().map(CredentialLifetime::remaining_ms),"health":self.health.lock().unwrap().clone()})
    }
    pub(super) fn elapsed_ms(&self) -> u64 {
        self.created.elapsed().as_millis() as u64
    }
    pub(super) fn display_id(&self) -> String {
        #[cfg(target_os = "macos")]
        {
            format!("macos:{}", self.pending.target.uuid)
        }
        #[cfg(not(target_os = "macos"))]
        {
            self.pending.target.uuid.clone()
        }
    }
    pub(super) fn force_relay(&self) -> bool {
        self.pending.force_relay
    }
    pub(super) fn live_control_transport(&self, health: &impl Fn() -> bool) -> bool {
        !self.canceled()
            && self.credentials_valid()
            && self.relay_ready.load(Ordering::Acquire)
            && crate::remote_desktop::connection::is_current(self.pending.generation)
            && health()
    }
    pub(super) fn with_control_authority<T>(
        &self,
        health: &impl Fn() -> bool,
        f: impl FnOnce(&mut Host, &super::control_worker::Shared) -> Result<T, &'static str>,
    ) -> Result<T, &'static str> {
        if !super::control_worker::CONTROL_AVAILABLE {
            return Err("control_not_available");
        }
        let owner = self.pending.owner.upgrade().ok_or("stale_connection")?;
        let mut owner = owner.lock().unwrap();
        let host = owner
            .as_mut()
            .filter(|host| host.account_generation == self.pending.generation)
            .ok_or("stale_connection")?;
        if !self.live_control_transport(health) {
            return Err("control_not_ready");
        }
        let bound = host
            .policy
            .connection_for(self.source(), self.attach_id(), self.connection_id())
            .map_err(|_| "stale_connection")?;
        if bound.phase != openbitfun_product_domains::remote_desktop::ViewPhase::Streaming
            || !host.policy.allows_control(self.source(), &bound.display_id)
        {
            return Err("control_authorization_required");
        }
        f(host, &self.control)
    }
    pub(super) fn control_allowed(&self, health: &impl Fn() -> bool) -> bool {
        self.with_control_authority(health, |_, _| Ok(())).is_ok()
    }
    pub(super) fn control_revision(&self) -> Option<String> {
        self.pending.owner.upgrade().and_then(|owner| {
            owner
                .lock()
                .unwrap()
                .as_ref()
                .filter(|host| host.account_generation == self.pending.generation)
                .map(|host| host.policy.revision())
        })
    }
    pub(super) fn control_revision_changed(&self) {
        if let Some(owner) = self.pending.owner.upgrade() {
            if let Some(host) = owner
                .lock()
                .unwrap()
                .as_mut()
                .filter(|host| host.account_generation == self.pending.generation)
            {
                let _ = host
                    .policy
                    .control_changed(self.source(), self.connection_id());
            }
        }
    }
    fn binding_allowed(&self) -> bool {
        if self.canceled()
            || !self.relay_ready.load(Ordering::Acquire)
            || !crate::remote_desktop::connection::is_current(self.pending.generation)
        {
            return false;
        }
        self.pending.owner.upgrade().is_some_and(|owner| {
            owner
                .lock()
                .unwrap()
                .as_ref()
                .filter(|host| host.account_generation == self.pending.generation)
                .is_some_and(|host| {
                    host.policy
                        .connection_for(
                            &self.pending.source,
                            self.attach_id(),
                            self.connection_id(),
                        )
                        .is_ok()
                })
        })
    }
    fn frame_allowed(&self) -> bool {
        if self.canceled()
            || !self.credentials_valid()
            || !crate::remote_desktop::connection::is_current(self.pending.generation)
        {
            return false;
        }
        self.pending.owner.upgrade().is_some_and(|owner| {
            owner
                .lock()
                .unwrap()
                .as_ref()
                .filter(|host| host.account_generation == self.pending.generation)
                .is_some_and(|host| {
                    host.policy.may_send_frame(
                        &self.pending.source,
                        self.connection_id(),
                        host.started.elapsed().as_millis() as u64,
                    )
                })
        })
    }
    fn record_submitted_frames(&self, count: u64) {
        self.submitted.store(count, Ordering::Release);
        if count > 0 {
            self.first_submitted.store(true, Ordering::Release);
        }
    }
    fn tick(&self, now: Instant) {
        if self.credentials.get().is_some_and(|value| !value.valid()) {
            self.fail("turn_credentials_expired");
            return;
        }
        // A running capture API is not evidence that any pixels reached the
        // SDK. Keep the original attachment budget through first submission.
        if !self.first_submitted.load(Ordering::Acquire)
            && now.saturating_duration_since(self.created) >= Duration::from_secs(60)
        {
            self.fail("media_unreachable");
            return;
        }
        let current = self.pending.owner.upgrade().is_some_and(|owner| {
            let mut guard = owner.lock().unwrap();
            let Some(host) = guard.as_mut().filter(|host| {
                host.account_generation == self.pending.generation
                    && crate::remote_desktop::connection::is_current(self.pending.generation)
            }) else {
                return false;
            };
            let _ = host
                .policy
                .expire_relay_grace(host.started.elapsed().as_millis() as u64);
            host.policy
                .snapshot(&self.pending.source)
                .is_ok_and(|snapshot| {
                    snapshot.attachment.is_some_and(|attachment| {
                        attachment.connection_id == self.pending.connection_id
                    })
                })
        });
        if !current {
            self.cancel();
        }
    }
    fn credentials_valid(&self) -> bool {
        self.credentials
            .get()
            .is_some_and(CredentialLifetime::valid)
    }
    fn fail(&self, code: &'static str) {
        self.cancel();
        if let Some(owner) = self.pending.owner.upgrade() {
            if let Some(host) = owner
                .lock()
                .unwrap()
                .as_mut()
                .filter(|host| host.account_generation == self.pending.generation)
            {
                if host
                    .policy
                    .snapshot(&self.pending.source)
                    .ok()
                    .and_then(|snapshot| snapshot.attachment)
                    .is_some_and(|attachment| {
                        attachment.connection_id == self.pending.connection_id
                            && (attachment.phase
                                != openbitfun_product_domains::remote_desktop::ViewPhase::Suspended
                                || code == "cleanup_failed")
                    })
                {
                    host.failure = Some((self.pending.source.clone(), code));
                    let _ = host.policy.stop();
                }
            }
        }
    }
}
impl Sessions {
    pub(super) fn occupied(&self) -> bool {
        self.active.lock().unwrap().is_some()
    }
    pub(super) fn cleaning(&self) -> bool {
        self.active
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|slot| slot.canceled() && slot.retained_until.get().is_none())
    }
    pub(super) fn codecs(&self) -> Vec<String> {
        self.engine.get_or_init(media::Engine::new).codecs()
    }
    pub(super) fn current(
        &self,
        source: &ControllerIdentity,
        connection: &str,
    ) -> Option<Arc<Slot>> {
        self.active
            .lock()
            .unwrap()
            .as_ref()
            .filter(|slot| {
                slot.source() == source && slot.connection_id() == connection && !slot.canceled()
            })
            .cloned()
    }
    pub(super) fn for_attachment(&self, attachment: &str) -> Option<Arc<Slot>> {
        self.for_relay_notice(attachment)
            .filter(|slot| slot.route_visible(Instant::now()))
    }
    /// Identity lookup only. A Relay notice can race suspended source drainage;
    /// the caller must validate the policy snapshot before acknowledging it.
    /// This is not evidence of live media or successful native cleanup.
    pub(super) fn for_relay_notice(&self, attachment: &str) -> Option<Arc<Slot>> {
        self.active
            .lock()
            .unwrap()
            .as_ref()
            .filter(|slot| slot.attach_id() == attachment)
            .cloned()
    }
    pub(super) fn retained(
        &self,
        source: &ControllerIdentity,
        attachment: &str,
        connection: &str,
    ) -> Result<Arc<Slot>, &'static str> {
        let active = self.active.lock().unwrap();
        let slot = active
            .as_ref()
            .filter(|slot| {
                slot.source() == source
                    && slot.attach_id() == attachment
                    && slot.connection_id() == connection
                    && slot.canceled()
            })
            .ok_or("stale_connection")?;
        match slot.retained_until.get() {
            Some(until) if Instant::now() < *until => Ok(slot.clone()),
            Some(_) => Err("sharing_ended"),
            None => Err("cleanup_pending"),
        }
    }
    pub(super) fn cancel(&self) {
        if let Some(slot) = self.active.lock().unwrap().as_ref() {
            slot.cancel();
        }
    }
    pub(super) fn cancel_device(&self, account: &str, device: &str) {
        if let Some(slot) =
            self.active.lock().unwrap().as_ref().filter(|slot| {
                slot.source().account_id == account && slot.source().device_id == device
            })
        {
            slot.cancel();
        }
    }
    pub(super) fn lost(&self) {
        if let Some(slot) = self.active.lock().unwrap().as_ref() {
            slot.lost();
        }
    }
    pub(super) fn apply(&self, effects: Vec<MediaEffect>) {
        for effect in effects {
            if let MediaEffect::Close { connection_id } = effect {
                if let Some(slot) = self
                    .active
                    .lock()
                    .unwrap()
                    .as_ref()
                    .filter(|slot| slot.connection_id() == connection_id)
                {
                    slot.cancel();
                }
            }
        }
    }
    pub(super) fn reserve(&self, pending: PendingMedia) -> Result<(), &'static str> {
        let mut active = self.active.lock().unwrap();
        let previous = active.as_ref().cloned();
        if let Some(previous) = &previous {
            previous.replacement_allowed(&pending, Instant::now())?;
        }
        let (commands, receiver) = mpsc::channel(4);
        let slot = Arc::new(Slot {
            control: Arc::new(super::control_worker::Shared::default()),
            socket_generation: AtomicU64::new(pending.socket_generation),
            pending,
            canceled: AtomicBool::new(false),
            relay_ready: AtomicBool::new(false),
            wake: Notify::new(),
            commands,
            offer: Mutex::new(None),
            negotiated: AtomicBool::new(false),
            first_submitted: AtomicBool::new(false),
            submitted: AtomicU64::new(0),
            health: Mutex::new(json!({"source_activity":"unknown","candidate":false})),
            credentials: OnceLock::new(),
            retained_until: OnceLock::new(),
            created: Instant::now(),
        });
        *active = Some(slot.clone());
        if let Some(previous) = previous {
            previous.wake.notify_one();
        }
        tokio::spawn(run(
            slot,
            receiver,
            Arc::downgrade(&self.active),
            self.engine.clone(),
        ));
        Ok(())
    }
}

async fn run(
    slot: Arc<Slot>,
    mut commands: mpsc::Receiver<Command>,
    active: Weak<Mutex<Option<Arc<Slot>>>>,
    engine: Arc<OnceLock<media::Engine>>,
) {
    let mut timer = tokio::time::interval(Duration::from_millis(250));
    while !slot.canceled() && !slot.relay_ready.load(Ordering::Acquire) {
        tokio::select! { _ = slot.wake.notified() => {}, _ = timer.tick() => slot.tick(Instant::now()) }
    }
    let (events, mut received) = mpsc::channel(16);
    let prepared = async {
        // Ready ACK receipt and HTTP dispatch may race. Retry only this scoped
        // idempotent read while the accepted binding remains locally valid.
        let client = AccountClient::new();
        let mut credentials = None;
        for attempt in 0..3 {
            if !slot.binding_allowed() {
                return Err("stale_connection");
            }
            match client
                .remote_desktop_turn(
                    &slot.pending.relay.relay_url,
                    &slot.pending.relay.session,
                    &slot.pending.relay.host_device_id,
                    slot.attach_id(),
                    &slot.pending.relay.capabilities,
                )
                .await
            {
                Ok(value) => {
                    credentials = Some(value);
                    break;
                }
                Err(error)
                    if attempt < 2
                        && error
                            .downcast_ref::<TurnIssuanceError>()
                            .is_some_and(|error| error.code == "attachment_unavailable") =>
                {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Err(_) => return Err("turn_unavailable"),
            }
        }
        let credentials = credentials.ok_or("turn_unavailable")?;
        // Freeze this PC's budget before media preparation. Renewed credentials
        // require the expected rebuild path, never an extension of this binding.
        let lifetime =
            CredentialLifetime::new(credentials.expires_at).ok_or("turn_credentials_expired")?;
        slot.credentials
            .set(lifetime)
            .map_err(|_| "turn_unavailable")?;
        let servers = credentials
            .ice_servers
            .into_iter()
            .map(|server| IceServer {
                urls: server.urls,
                username: server.username,
                password: server.credential,
            })
            .collect();
        let weak = Arc::downgrade(&slot);
        let mut connection = engine
            .get_or_init(media::Engine::new)
            .prepare(
                slot.attach_id(),
                slot.connection_id(),
                servers,
                slot.pending.force_relay,
                media::VideoConfig {
                    resolution: VideoResolution {
                        width: slot.pending.target.width,
                        height: slot.pending.target.height,
                    },
                    quality: slot.pending.quality,
                },
                move |event| {
                    if events.try_send(event).is_err() {
                        if let Some(slot) = weak.upgrade() {
                            slot.cancel();
                        }
                    }
                },
            )
            .map_err(|_| "media_backend_unavailable")?;
        let offer = connection.offer().await.map_err(|_| "media_unreachable")?;
        if !slot.credentials_valid() {
            return Err("turn_credentials_expired");
        }
        if !slot.binding_allowed() {
            return Err("stale_connection");
        }
        *slot.offer.lock().unwrap() = Some(offer);
        Ok(connection)
    };
    let mut preparation = Box::pin(prepared);
    let prepared = loop {
        if slot.canceled() {
            break Err("stale_connection");
        }
        tokio::select! {
            result = &mut preparation => break result,
            _ = slot.wake.notified() => {},
            _ = timer.tick() => slot.tick(Instant::now()),
        }
    };
    drop(preparation);
    let mut input_worker = None;
    let mut connection = match prepared {
        Ok(mut connection) => {
            let shared = slot.control.clone();
            let created = slot.created;
            // Capture host receipt before parsing/queueing, using the lease's
            // slot origin. No controller-supplied timestamp is accepted.
            let (health, send) = connection.control_endpoint(move |bytes| {
                shared.receive(bytes, created.elapsed().as_millis() as u64)
            });
            let input_slot = slot.clone();
            input_worker = Some(tokio::task::spawn_blocking(move || {
                super::control_worker::run(input_slot, health, send)
            }));
            let mut capturing = false;
            let mut disconnected = None;
            while !slot.canceled() {
                tokio::select! {
                    _ = slot.wake.notified() => {},
                    _ = timer.tick() => {
                        // Observe the SDK count before expiry: the first-frame
                        // event may still be waiting in the actor mailbox.
                        slot.record_submitted_frames(connection.submitted_frames());
                        slot.tick(Instant::now());
                        connection.probe_health();
                        *slot.health.lock().unwrap() = connection.health_status();
                        if connection.closed() { slot.fail("media_unreachable"); }
                        if slot.negotiated.load(Ordering::Acquire) && !connection.connected() {
                            if disconnected.get_or_insert_with(Instant::now).elapsed() > Duration::from_secs(15) { slot.fail("media_unreachable"); }
                        } else { disconnected = None; }
                    },
                    command = commands.recv() => match command {
                        Some(Command::Answer(answer, result)) => {
                            let accepted = if slot.credentials_valid() && slot.binding_allowed() && answer.attach_id == slot.attach_id() && answer.connection_id == slot.connection_id() {
                                match tokio::time::timeout(Duration::from_secs(5), connection.answer(&answer.answer_sdp)).await {
                                    Ok(result)=>result.map_err(|_| "invalid_answer"),
                                    Err(_)=>{slot.fail("media_unreachable");Err("delivery_unknown")},
                                }
                            } else { Err("stale_connection") };
                            let accepted = if !slot.credentials_valid() {
                                slot.fail("turn_credentials_expired");
                                Err("turn_credentials_expired")
                            } else { accepted };
                            if accepted.is_ok() { slot.negotiated.store(true, Ordering::Release); }
                            let _ = result.send(accepted);
                        },
                        None => slot.cancel(),
                    },
                    event = received.recv() => match event {
                        Some(media::Event::Bound) => {},
                        Some(media::Event::Closed) => slot.fail("media_unreachable"),
                        Some(media::Event::CaptureFailed) => slot.fail(if super::capture::availability()=="permission_required" {"permission_required"} else {"media_unreachable"}),
                        Some(media::Event::GeometryChanged) => slot.fail("target_lost"),
                        Some(media::Event::HostLocked) => slot.fail("host_locked"),
                        Some(media::Event::FirstFrameSubmitted) => { slot.first_submitted.store(true, Ordering::Release); },
                        Some(media::Event::SourceStarted) => {},
                        None => slot.cancel(),
                    }
                }
                if !capturing
                    && !slot.canceled()
                    && slot.credentials_valid()
                    && slot.binding_allowed()
                    && slot.negotiated.load(Ordering::Acquire)
                    && connection.bound()
                {
                    let allowed = slot.pending.owner.upgrade().is_some_and(|owner| {
                        owner
                            .lock()
                            .unwrap()
                            .as_mut()
                            .filter(|host| host.account_generation == slot.pending.generation)
                            .is_some_and(|host| {
                                host.policy
                                    .bound(&slot.pending.source, slot.connection_id())
                                    .is_ok()
                            })
                    });
                    if !allowed {
                        slot.fail("stale_connection");
                        continue;
                    }
                    let source = slot.clone();
                    let id = slot.pending.target.id;
                    let uuid = slot.pending.target.uuid.clone();
                    let worker = tokio::task::spawn_blocking(move || {
                        let result =
                            connection.start_capture(id, &uuid, move || source.frame_allowed());
                        (connection, result)
                    })
                    .await;
                    match worker {
                        Ok((current, result)) => {
                            connection = current;
                            if result.is_err() {
                                slot.fail("permission_required");
                            } else {
                                capturing = true;
                            }
                        }
                        Err(_) => {
                            slot.fail("cleanup_failed");
                            std::future::pending::<()>().await;
                            unreachable!();
                        }
                    }
                }
            }
            Some(connection)
        }
        Err(code) => {
            if !slot.canceled() {
                slot.fail(code);
            }
            None
        }
    };
    slot.cancel();
    if let Some(worker) = input_worker {
        if !matches!(worker.await, Ok(true)) {
            slot.fail("cleanup_failed");
            // Failed input cleanup is part of this slot's drainage barrier.
            // Retain PC and source as well; a new account cannot bypass it.
            let _quarantined = connection;
            std::future::pending::<()>().await;
            unreachable!();
        }
    }
    if let Some(mut current) = connection.take() {
        let worker = tokio::task::spawn_blocking(move || {
            let drained = current.close();
            (current, drained)
        })
        .await;
        match worker {
            Ok((current, true)) => drop(current),
            Ok((current, false)) => {
                slot.fail("cleanup_failed");
                // The app-wide slot remains occupied. Keep the opaque source
                // alive rather than freeing callbacks or allowing another PC.
                let _quarantined = current;
                std::future::pending::<()>().await;
            }
            Err(_) => {
                slot.fail("cleanup_failed");
                std::future::pending::<()>().await;
            }
        }
    }
    if slot.confirm_drained(Instant::now()).is_err() {
        slot.fail("cleanup_failed");
        std::future::pending::<()>().await;
        unreachable!();
    }
    // The same owner also bounds a suspended attachment after all native IO
    // has drained. Ready notifications never extend this fixed budget.
    while slot.retain(Instant::now()) {
        tokio::select! { _ = slot.wake.notified() => {}, _ = timer.tick() => {} }
    }
    let attachment_continues = slot.attachment_continues();
    if let Some(active) = active.upgrade() {
        let mut current = active.lock().unwrap();
        if current
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &slot))
        {
            *current = None;
        }
    }
    if !attachment_continues {
        crate::remote_desktop::connection::end_media(
            slot.pending.generation,
            slot.pending.relay.service_connection_id,
            slot.socket_generation.load(Ordering::Acquire),
            slot.attach_id(),
        )
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::super::RemoteDesktopState;
    use super::*;
    use openbitfun_product_domains::remote_desktop::{
        AttachRequest, ReadOnlyHost, ViewGrant, ViewGrantFile,
    };

    pub(super) fn fixture() -> (RemoteDesktopState, PendingMedia) {
        let generation = crate::remote_desktop::connection::generation();
        let source = ControllerIdentity {
            account_id: "account".into(),
            device_id: "phone".into(),
            public_key_fingerprint: "a".repeat(64),
        };
        let grant = ViewGrant {
            account_id: source.account_id.clone(),
            device_id: source.device_id.clone(),
            public_key_fingerprint: source.public_key_fingerprint.clone(),
            display_ids: vec!["screen".into()],
            control_display_ids: Vec::new(),
        };
        let mut policy = ReadOnlyHost::new(
            "account".into(),
            "boot".into(),
            ViewGrantFile {
                version: 1,
                grants: vec![grant],
            },
        )
        .unwrap();
        policy
            .attach(
                &source,
                &AttachRequest {
                    attach_id: "a".into(),
                    expected_state_revision: policy.revision(),
                    display_id: "screen".into(),
                    force_relay: false,
                },
                "pc",
            )
            .unwrap();
        let state = RemoteDesktopState::default();
        *state.0.lock().unwrap() = Some(Host {
            account_generation: generation,
            policy,
            store: None,
            started: Instant::now(),
            credential_binding: Some("a".repeat(64)),
            relay: None,
            failure: None,
        });
        let pending = PendingMedia {
            generation,
            socket_generation: 1,
            relay: RelayContext {
                relay_url: "http://127.0.0.1:1".into(),
                session:
                    openbitfun_services_integrations::remote_connect::account::AccountSession::new(
                        "fixture".into(),
                        "account".into(),
                        [7; 32],
                    ),
                host_device_id: "host".into(),
                service_connection_id: 1,
                capabilities: vec!["remote_desktop_turn_v1".into()],
            },
            source,
            attach_id: "a".into(),
            connection_id: "pc".into(),
            target: CaptureTarget {
                id: 0,
                uuid: "not-a-real-display".into(),
                width: 1280,
                height: 720,
            },
            force_relay: false,
            quality: QualityPreset::default(),
            owner: Arc::downgrade(&state.0),
        };
        (state, pending)
    }
    pub(super) async fn drained(state: &RemoteDesktopState) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while state.1.occupied() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }

    fn supply_credentials(slot: &Slot) {
        let expiry = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 300;
        assert!(slot
            .credentials
            .set(CredentialLifetime::new(expiry).unwrap())
            .is_ok());
    }

    #[tokio::test]
    async fn startup_without_a_real_submission_expires_before_or_after_transport_binding() {
        for bound in [false, true] {
            let (state, pending) = fixture();
            let source = pending.source.clone();
            state.1.reserve(pending).unwrap();
            let slot = state.1.current(&source, "pc").unwrap();
            supply_credentials(&slot);
            if bound {
                state
                    .0
                    .lock()
                    .unwrap()
                    .as_mut()
                    .unwrap()
                    .policy
                    .bound(&source, "pc")
                    .unwrap();
                slot.negotiated.store(true, Ordering::Release);
            }
            // Model an API that returned success but never submitted a frame.
            // Routing stays unready, so the real actor starts no SDK/capture.
            slot.record_submitted_frames(0);
            slot.tick(slot.created + Duration::from_millis(59_999));
            assert!(!slot.canceled());
            assert_eq!(slot.frame_allowed(), bound);
            slot.tick(slot.created + Duration::from_secs(60));
            assert!(slot.canceled());
            assert!(!slot.frame_allowed());
            assert!(!slot.live_control_transport(&|| panic!("expired startup sampled health")));
            assert!(state.1.occupied(), "Timeout cannot bypass native drainage");
            {
                let mut owner = state.0.lock().unwrap();
                let host = owner.as_mut().unwrap();
                assert_eq!(host.failure.as_ref().unwrap().1, "media_unreachable");
                let snapshot = host.policy.snapshot(&source).unwrap();
                assert!(!snapshot.busy && snapshot.cleanup_pending);
                let retry = AttachRequest {
                    attach_id: "next".into(),
                    expected_state_revision: host.policy.revision(),
                    display_id: "screen".into(),
                    force_relay: false,
                };
                assert_eq!(
                    host.policy.attach(&source, &retry, "next-pc"),
                    Err(openbitfun_product_domains::remote_desktop::ReadOnlyError::CleanupPending)
                );
            }
            drained(&state).await;
            let mut owner = state.0.lock().unwrap();
            let host = owner.as_mut().unwrap();
            let snapshot = host.policy.snapshot(&source).unwrap();
            assert!(!snapshot.busy && !snapshot.cleanup_pending);
            assert!(snapshot.attachment.is_none());
            let retry = AttachRequest {
                attach_id: "next".into(),
                expected_state_revision: host.policy.revision(),
                display_id: "screen".into(),
                force_relay: false,
            };
            assert!(host.policy.attach(&source, &retry, "next-pc").is_ok());
        }
    }

    #[tokio::test]
    async fn accepted_submission_ends_startup_budget_before_its_event_is_consumed() {
        let (state, pending) = fixture();
        let source = pending.source.clone();
        state.1.reserve(pending).unwrap();
        let slot = state.1.current(&source, "pc").unwrap();
        supply_credentials(&slot);
        state
            .0
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .policy
            .bound(&source, "pc")
            .unwrap();
        assert!(!slot.first_submitted.load(Ordering::Acquire));
        // The accepted SDK count is authoritative even when its event is still
        // queued. Neither API startup nor receiver stats supplies this count.
        slot.record_submitted_frames(1);
        slot.tick(slot.created + Duration::from_secs(61));
        assert!(!slot.canceled());
        assert!(slot.frame_allowed());
        assert_eq!(slot.status()["source_first_frame"], true);
        assert_eq!(slot.status()["source_frames_submitted"], 1);
        state.retire();
        drained(&state).await;
    }

    #[tokio::test]
    async fn remote_desktop_account_retirement_closes_gate_before_draining_the_global_slot() {
        let (state, pending) = fixture();
        let source = pending.source.clone();
        state.1.reserve(pending).unwrap();
        let slot = state.1.current(&source, "pc").unwrap();
        assert!(!slot.frame_allowed());
        supply_credentials(&slot);
        state
            .0
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .policy
            .bound(&source, "pc")
            .unwrap();
        assert!(slot.frame_allowed()); // pure gate only; no SDK/capture starts without ready
        state.retire();
        assert!(!slot.frame_allowed());
        assert!(state.1.occupied());
        assert!(state.1.cleaning());
        drained(&state).await;
        assert!(slot.canceled());
    }

    #[tokio::test]
    async fn remote_desktop_frame_gate_enforces_grace_and_device_scoped_cancel_without_a_timer() {
        let (state, pending) = fixture();
        let source = pending.source.clone();
        state.1.reserve(pending).unwrap();
        let slot = state.1.current(&source, "pc").unwrap();
        supply_credentials(&slot);
        state
            .0
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .policy
            .bound(&source, "pc")
            .unwrap();
        state.1.cancel_device("account", "other-device");
        assert!(slot.frame_allowed());
        {
            let mut guard = state.0.lock().unwrap();
            let host = guard.as_mut().unwrap();
            host.started = Instant::now() - Duration::from_secs(31);
            host.policy.relay_lost(0);
        }
        assert!(!slot.frame_allowed());
        assert!(!slot.binding_allowed());
        state.1.cancel_device("account", "phone");
        assert!(slot.canceled());
        drained(&state).await;
    }

    #[tokio::test]
    async fn remote_desktop_frame_and_answer_gates_expire_without_actor_tick() {
        let (state, pending) = fixture();
        let source = pending.source.clone();
        state.1.reserve(pending).unwrap();
        let slot = state.1.current(&source, "pc").unwrap();
        state
            .0
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .policy
            .bound(&source, "pc")
            .unwrap();
        assert!(!slot.frame_allowed()); // Missing credentials never authorize pixels.
        let expiry = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 300;
        let wall = std::time::UNIX_EPOCH + Duration::from_secs(expiry - 1);
        // Wall time is still before expiry. Only the original monotonic budget
        // has elapsed, as after a clock rollback. No timer has run.
        let lifetime =
            CredentialLifetime::at(expiry, wall, Instant::now() - Duration::from_secs(2)).unwrap();
        assert!(slot.credentials.set(lifetime).is_ok());
        assert!(!slot.frame_allowed());
        assert!(!slot.live_control_transport(&|| panic!("expired transport sampled input health")));
        assert!(!slot.canceled()); // The submission barrier precedes actor cleanup.
        assert_eq!(
            slot.answer(AnswerRequest {
                attach_id: "a".into(),
                connection_id: "pc".into(),
                answer_sdp: "not-submitted".into(),
            })
            .await,
            Err("stale_connection")
        );
        slot.tick(Instant::now());
        assert!(slot.canceled());
        assert_eq!(
            state
                .0
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .failure
                .as_ref()
                .unwrap()
                .1,
            "turn_credentials_expired"
        );
        drained(&state).await;
    }
}
