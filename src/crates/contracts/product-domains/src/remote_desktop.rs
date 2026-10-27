//! Remote desktop authorization, attachment and input facts. No OS handles,
//! media engine, account token, clock or asynchronous task lives here.
pub mod control;
pub mod health;
pub mod input;
pub mod input_admission;
pub mod lease;
mod quality;
mod source;
pub use quality::{QualityPreset, QualitySettings, SetQualityRequest, QUALITY_PRESETS_V1};

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;
pub const SOURCE_LIFECYCLE_V1: &str = "source_lifecycle_v1";
/// Relative per-PC TURN budget; renewal uses the existing drain/resume protocol.
pub const CREDENTIAL_REBUILD_V1: &str = "credential_rebuild_v1";
pub const RELAY_VIDEO_GRACE_MS: u64 = 30_000;

/// Construct only from an authenticated route and the verified device key,
/// never by deserializing a request body. Account IDs are opaque Relay IDs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControllerIdentity {
    pub account_id: String,
    pub device_id: String,
    pub public_key_fingerprint: String,
}

impl ControllerIdentity {
    fn valid(&self) -> bool {
        !self.account_id.is_empty()
            && valid_id(&self.device_id)
            && self.public_key_fingerprint.len() == 64
            && self
                .public_key_fingerprint
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }
}

/// Local device trust. The existing view shape is retained; missing additive
/// control scope never grants input. Control also requires the matching view
/// scope in this same record, not another device/key/grant entry.
/// The host's local settings path is the only writer; this has no remote command.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ViewGrant {
    pub account_id: String,
    pub device_id: String,
    pub public_key_fingerprint: String,
    pub display_ids: Vec<String>,
    pub control_display_ids: Vec<String>,
}

impl ViewGrant {
    fn allows(&self, source: &ControllerIdentity, display: &str) -> bool {
        source.valid()
            && self.account_id == source.account_id
            && self.device_id == source.device_id
            && self.public_key_fingerprint == source.public_key_fingerprint
            && valid_display_id(display)
            && self.display_ids.iter().any(|id| id == display)
    }

    fn allows_control(&self, source: &ControllerIdentity, display: &str) -> bool {
        self.allows(source, display) && self.control_display_ids.iter().any(|id| id == display)
    }
}

fn store_version() -> u32 {
    1
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewGrantFile {
    #[serde(default = "store_version")]
    pub version: u32,
    #[serde(default)]
    pub grants: Vec<ViewGrant>,
}

impl Default for ViewGrantFile {
    fn default() -> Self {
        Self {
            version: 1,
            grants: Vec::new(),
        }
    }
}

/// Unknown schemas are retained by the IO owner and cannot authorize a screen.
impl ViewGrantFile {
    pub fn supported(&self) -> bool {
        self.version == 1
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReadOnlyRequest {
    pub version: u32,
    #[serde(flatten)]
    pub command: ReadOnlyCommand,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "op", content = "body", rename_all = "snake_case")]
pub enum ReadOnlyCommand {
    Capabilities,
    ListDisplays,
    GetState,
    Attach(AttachRequest),
    Signal(AnswerRequest),
    Suspend(SourceRequest),
    SelectDisplay(SelectDisplayRequest),
    SetQuality(SetQualityRequest),
    Resume(SourceRequest),
    Detach { attach_id: String },
}

impl ReadOnlyRequest {
    /// Attachment mutations must agree with the Relay's authenticated outer
    /// association. Read-only probes remain usable before an attachment exists.
    pub fn matches_route_attachment(&self, outer: Option<&str>) -> bool {
        match &self.command {
            ReadOnlyCommand::Attach(request) => outer == Some(request.attach_id.as_str()),
            ReadOnlyCommand::Signal(request) => outer == Some(request.attach_id.as_str()),
            ReadOnlyCommand::Suspend(request) | ReadOnlyCommand::Resume(request) => {
                outer == Some(request.attach_id.as_str())
            }
            ReadOnlyCommand::SelectDisplay(request) => outer == Some(request.attach_id.as_str()),
            ReadOnlyCommand::SetQuality(request) => outer == Some(request.attach_id.as_str()),
            ReadOnlyCommand::Detach { attach_id } => outer == Some(attach_id.as_str()),
            ReadOnlyCommand::Capabilities | ReadOnlyCommand::ListDisplays => outer.is_none(),
            ReadOnlyCommand::GetState => true,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RelayNoticeKind {
    Ready,
    Unknown,
    Revoked,
    Ended,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayNotice {
    pub version: u32,
    pub attach_id: String,
    pub kind: RelayNoticeKind,
}
impl RelayNotice {
    pub fn valid(&self) -> bool {
        self.version == PROTOCOL_VERSION && valid_id(&self.attach_id)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AttachRequest {
    pub attach_id: String,
    pub expected_state_revision: String,
    pub display_id: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub force_relay: bool,
}
fn is_false(value: &bool) -> bool {
    !*value
}

/// Optional source_lifecycle_v1 commands. Controllers must check the host's
/// capability before sending them; these do not change the legacy attach shape.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SourceRequest {
    pub attach_id: String,
    pub expected_state_revision: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SelectDisplayRequest {
    pub attach_id: String,
    pub expected_state_revision: String,
    pub display_id: String,
}

/// v1 uses a fully gathered SDP; only the host offers. No trickle, negotiation
/// sequence or renderer assertion can select an attachment owner.
#[derive(Clone, Serialize, Deserialize)]
pub struct AnswerRequest {
    pub attach_id: String,
    pub connection_id: String,
    pub answer_sdp: String,
}
impl std::fmt::Debug for AnswerRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AnswerRequest")
            .field("attach_id", &self.attach_id)
            .field("connection_id", &self.connection_id)
            .finish_non_exhaustive()
    }
}
impl AnswerRequest {
    pub fn valid(&self) -> bool {
        valid_id(&self.attach_id)
            && valid_id(&self.connection_id)
            && !self.answer_sdp.is_empty()
            && self.answer_sdp.len() <= 90 * 1024
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadOnlyError {
    AuthorizationRequired,
    RelayUnavailable,
    AttachmentBusy,
    CleanupPending,
    AttachIdConflict,
    StaleRevision,
    StaleConnection,
    NotAttachmentOwner,
    InvalidRequest,
    RevisionExhausted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ViewPhase {
    Binding,
    Streaming,
    /// The logical attachment remains reserved, but has no usable transport.
    Suspended,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentSnapshot {
    pub attach_id: String,
    pub connection_id: String,
    pub display_id: String,
    pub phase: ViewPhase,
    #[serde(default)]
    pub quality: QualityPreset,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ViewSnapshot {
    pub state_revision: String,
    pub busy: bool,
    pub cleanup_pending: bool,
    /// Only the authenticated attachment owner receives connection/source IDs.
    pub attachment: Option<AttachmentSnapshot>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MediaEffect {
    /// Create only the transport; do not send source pixels until bind passes.
    Prepare {
        connection_id: String,
        display_id: String,
    },
    StartCapture {
        connection_id: String,
        display_id: String,
    },
    Close {
        connection_id: String,
    },
}

#[derive(Clone, Debug)]
struct Attachment {
    owner: ControllerIdentity,
    snapshot: AttachmentSnapshot,
    initial_display_id: String,
    force_relay: bool,
}

/// Pure serial state, owned by the host facade. The facade serializes commands,
/// local approvals, media callbacks and grant changes through this one owner.
pub struct ReadOnlyHost {
    account_id: String,
    boot_id: String,
    revision: u64,
    grants: ViewGrantFile,
    attachment: Option<Attachment>,
    retiring_connection: Option<String>,
    relay_lost_at_ms: Option<u64>,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}

fn valid_display_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

impl ReadOnlyHost {
    pub fn account_id(&self) -> &str {
        &self.account_id
    }
    /// boot_id must be a fresh host-generated UUID for every process lifetime.
    pub fn new(
        account_id: String,
        boot_id: String,
        grants: ViewGrantFile,
    ) -> Result<Self, ReadOnlyError> {
        if account_id.is_empty() || !valid_id(&boot_id) {
            return Err(ReadOnlyError::InvalidRequest);
        }
        Ok(Self {
            account_id,
            boot_id,
            revision: 0,
            grants,
            attachment: None,
            retiring_connection: None,
            relay_lost_at_ms: None,
        })
    }

    pub fn matches_attachment(&self, attach_id: &str) -> bool {
        self.attachment
            .as_ref()
            .is_some_and(|attachment| attachment.snapshot.attach_id == attach_id)
    }

    pub fn revision(&self) -> String {
        format!("{}:{}", self.boot_id, self.revision)
    }

    fn advance(&mut self) -> Result<(), ReadOnlyError> {
        self.revision = self
            .revision
            .checked_add(1)
            .ok_or(ReadOnlyError::RevisionExhausted)?;
        Ok(())
    }

    /// Native host control transitions share the attachment CAS revision.
    /// This fences delayed acquisition after a grant/release; it grants no input.
    pub fn control_changed(
        &mut self,
        source: &ControllerIdentity,
        connection_id: &str,
    ) -> Result<String, ReadOnlyError> {
        let attachment = self
            .attachment
            .as_ref()
            .ok_or(ReadOnlyError::InvalidRequest)?;
        if attachment.owner != *source || attachment.snapshot.connection_id != connection_id {
            return Err(ReadOnlyError::InvalidRequest);
        }
        self.advance()?;
        Ok(self.revision())
    }

    pub fn allows(&self, source: &ControllerIdentity, display: &str) -> bool {
        self.account_id == source.account_id
            && self.grants.supported()
            && self
                .grants
                .grants
                .iter()
                .any(|grant| grant.allows(source, display))
    }

    /// Eligibility only. This never creates a lease or GUI reservation or
    /// proves that the bound PC/source/receiver is healthy.
    pub fn allows_control(&self, source: &ControllerIdentity, display: &str) -> bool {
        self.account_id == source.account_id
            && self.grants.supported()
            && self
                .grants
                .grants
                .iter()
                .any(|grant| grant.allows_control(source, display))
    }

    /// Local trust management reads the effective grants, including after a
    /// persistence failure. Remote callers only receive authorized_displays.
    pub fn local_view_grants(&self) -> &ViewGrantFile {
        &self.grants
    }

    pub fn authorized_displays(&self, source: &ControllerIdentity) -> Vec<String> {
        if self.account_id != source.account_id || !self.grants.supported() {
            return Vec::new();
        }
        let mut displays = Vec::new();
        for grant in &self.grants.grants {
            for id in &grant.display_ids {
                if grant.allows(source, id) && !displays.contains(id) {
                    displays.push(id.clone());
                }
            }
        }
        displays
    }

    pub fn snapshot(&self, source: &ControllerIdentity) -> Result<ViewSnapshot, ReadOnlyError> {
        if self.authorized_displays(source).is_empty() {
            return Err(ReadOnlyError::AuthorizationRequired);
        }
        Ok(ViewSnapshot {
            state_revision: self.revision(),
            busy: self.attachment.is_some(),
            cleanup_pending: self.retiring_connection.is_some(),
            attachment: self
                .attachment
                .as_ref()
                .filter(|a| a.owner == *source)
                .map(|a| a.snapshot.clone()),
        })
    }

    pub fn connection_for(
        &self,
        source: &ControllerIdentity,
        attach_id: &str,
        connection_id: &str,
    ) -> Result<&AttachmentSnapshot, ReadOnlyError> {
        let current = self
            .attachment
            .as_ref()
            .ok_or(ReadOnlyError::StaleConnection)?;
        if current.owner != *source
            || current.snapshot.attach_id != attach_id
            || current.snapshot.connection_id != connection_id
            || current.snapshot.phase == ViewPhase::Suspended
        {
            return Err(ReadOnlyError::StaleConnection);
        }
        if !self.allows(source, &current.snapshot.display_id) {
            return Err(ReadOnlyError::AuthorizationRequired);
        }
        if self.relay_lost_at_ms.is_some() {
            return Err(ReadOnlyError::RelayUnavailable);
        }
        Ok(&current.snapshot)
    }

    /// connection_id is generated by the host adapter, never accepted from wire.
    /// Actual source availability and OS consent must be checked by that adapter.
    pub fn attach(
        &mut self,
        source: &ControllerIdentity,
        request: &AttachRequest,
        connection_id: &str,
    ) -> Result<Vec<MediaEffect>, ReadOnlyError> {
        if !self.allows(source, &request.display_id) {
            return Err(ReadOnlyError::AuthorizationRequired);
        }
        if self.relay_lost_at_ms.is_some() {
            return Err(ReadOnlyError::RelayUnavailable);
        }
        if !valid_id(&request.attach_id) || !valid_id(connection_id) {
            return Err(ReadOnlyError::InvalidRequest);
        }
        if let Some(current) = &self.attachment {
            if current.owner == *source && current.snapshot.attach_id == request.attach_id {
                return if current.initial_display_id == request.display_id
                    && current.force_relay == request.force_relay
                {
                    Ok(Vec::new())
                } else {
                    Err(ReadOnlyError::AttachIdConflict)
                };
            }
            return Err(ReadOnlyError::AttachmentBusy);
        }
        if self.retiring_connection.is_some() {
            return Err(ReadOnlyError::CleanupPending);
        }
        if request.expected_state_revision != self.revision() {
            return Err(ReadOnlyError::StaleRevision);
        }
        self.advance()?;
        self.attachment = Some(Attachment {
            owner: source.clone(),
            initial_display_id: request.display_id.clone(),
            force_relay: request.force_relay,
            snapshot: AttachmentSnapshot {
                attach_id: request.attach_id.clone(),
                connection_id: connection_id.into(),
                display_id: request.display_id.clone(),
                phase: ViewPhase::Binding,
                quality: QualityPreset::default(),
            },
        });
        Ok(vec![MediaEffect::Prepare {
            connection_id: connection_id.into(),
            display_id: request.display_id.clone(),
        }])
    }

    /// Called after the host adapter verifies the fixed peer key, signaling/DTLS
    /// identity and the single expected DataChannel. It is not a wire assertion.
    pub fn bound(
        &mut self,
        source: &ControllerIdentity,
        connection_id: &str,
    ) -> Result<Vec<MediaEffect>, ReadOnlyError> {
        let current = self
            .attachment
            .as_ref()
            .ok_or(ReadOnlyError::StaleConnection)?;
        if current.owner != *source
            || current.snapshot.connection_id != connection_id
            || current.snapshot.phase == ViewPhase::Suspended
        {
            return Err(ReadOnlyError::StaleConnection);
        }
        if self.relay_lost_at_ms.is_some() {
            return Err(ReadOnlyError::RelayUnavailable);
        }
        if !self.allows(source, &current.snapshot.display_id) {
            return Err(ReadOnlyError::AuthorizationRequired);
        }
        if current.snapshot.phase == ViewPhase::Streaming {
            return Ok(Vec::new());
        }
        self.advance()?;
        let current = self.attachment.as_mut().unwrap();
        current.snapshot.phase = ViewPhase::Streaming;
        Ok(vec![MediaEffect::StartCapture {
            connection_id: connection_id.into(),
            display_id: current.snapshot.display_id.clone(),
        }])
    }

    pub fn detach(
        &mut self,
        source: &ControllerIdentity,
        attach_id: &str,
    ) -> Result<Vec<MediaEffect>, ReadOnlyError> {
        if let Some(current) = &self.attachment {
            if current.owner != *source {
                return Err(ReadOnlyError::NotAttachmentOwner);
            }
            // A late detach for a retired attachment must not close its successor.
            if current.snapshot.attach_id != attach_id {
                return Ok(Vec::new());
            }
            self.stop()
        } else {
            Ok(Vec::new())
        }
    }

    /// Local stop/revoke first removes authorization to stream, before effect IO.
    /// Even an empty-slot stop advances CAS, fencing an attach whose ACK was lost.
    pub fn stop(&mut self) -> Result<Vec<MediaEffect>, ReadOnlyError> {
        self.advance()?;
        Ok(self.retire_attachment())
    }

    fn retire_attachment(&mut self) -> Vec<MediaEffect> {
        if let Some(current) = self.attachment.take() {
            // A suspended attachment has already retired its native PC. Keep
            // any unfinished old drain, but do not invent a second cleanup.
            if current.snapshot.phase == ViewPhase::Suspended {
                return Vec::new();
            }
            let connection_id = current.snapshot.connection_id;
            self.retiring_connection = Some(connection_id.clone());
            vec![MediaEffect::Close { connection_id }]
        } else {
            Vec::new()
        }
    }

    /// Cleanup confirmation must follow drained capture/encoder callbacks.
    /// Unexpected termination closes only the currently matching connection.
    pub fn media_closed(&mut self, connection_id: &str) -> Result<(), ReadOnlyError> {
        if self.retiring_connection.as_deref() == Some(connection_id) {
            self.advance()?;
            self.retiring_connection = None;
        } else if self.attachment.as_ref().is_some_and(|a| {
            a.snapshot.connection_id == connection_id && a.snapshot.phase != ViewPhase::Suspended
        }) {
            self.advance()?;
            self.attachment = None;
        }
        Ok(())
    }

    /// Local settings only. Unsupported/newer files remain in the IO owner;
    /// replacing them here revokes active access instead of silently resetting.
    pub fn replace_grants(
        &mut self,
        grants: ViewGrantFile,
    ) -> Result<Vec<MediaEffect>, ReadOnlyError> {
        self.advance()?;
        // Compare only the current participant's effective record(s). A local
        // scope change needs a fresh binding even when viewing is still allowed;
        // editing another device must not interrupt this stream. Use the single
        // revision above so retirement cannot fail on a second counter advance.
        let changed = self.attachment.as_ref().is_some_and(|current| {
            let records = |file: &ViewGrantFile| {
                file.grants
                    .iter()
                    .filter(|grant| grant.allows(&current.owner, &current.snapshot.display_id))
                    .cloned()
                    .collect::<Vec<_>>()
            };
            records(&self.grants) != records(&grants)
        });
        self.grants = grants;
        let invalid = self
            .attachment
            .as_ref()
            .is_some_and(|a| !self.allows(&a.owner, &a.snapshot.display_id));
        if invalid || changed {
            Ok(self.retire_attachment())
        } else {
            Ok(Vec::new())
        }
    }

    pub fn relay_lost(&mut self, now_ms: u64) {
        // Repeated failed reconnections cannot extend the first loss deadline.
        self.relay_lost_at_ms.get_or_insert(now_ms);
    }

    /// Only after a new authenticated host route and this source's current key
    /// have been verified. A display probe may reopen an idle route, never an
    /// existing attachment or its cleanup barrier. Fence pre-loss attach CAS.
    pub fn revalidate_idle_route(
        &mut self,
        source: &ControllerIdentity,
    ) -> Result<(), ReadOnlyError> {
        if self.authorized_displays(source).is_empty() {
            return Err(ReadOnlyError::AuthorizationRequired);
        }
        if self.relay_lost_at_ms.is_some()
            && self.attachment.is_none()
            && self.retiring_connection.is_none()
        {
            self.advance()?;
            self.relay_lost_at_ms = None;
        }
        Ok(())
    }

    /// Host-facade call after authenticated routing/key revalidation, not a
    /// controller's self-reported reconnect. Closed attachments stay closed.
    pub fn relay_revalidated(&mut self, now_ms: u64) -> Result<Vec<MediaEffect>, ReadOnlyError> {
        let effects = self.expire_relay_grace(now_ms)?;
        self.relay_lost_at_ms = None;
        Ok(effects)
    }

    pub fn expire_relay_grace(&mut self, now_ms: u64) -> Result<Vec<MediaEffect>, ReadOnlyError> {
        if self
            .relay_lost_at_ms
            .is_some_and(|first| now_ms.saturating_sub(first) >= RELAY_VIDEO_GRACE_MS)
            && self.attachment.is_some()
        {
            self.stop()
        } else {
            Ok(Vec::new())
        }
    }

    /// Capture callbacks must gate immediately before forwarding each frame.
    pub fn may_send_frame(
        &self,
        source: &ControllerIdentity,
        connection_id: &str,
        now_ms: u64,
    ) -> bool {
        if self
            .relay_lost_at_ms
            .is_some_and(|first| now_ms.saturating_sub(first) >= RELAY_VIDEO_GRACE_MS)
        {
            return false;
        }
        self.attachment.as_ref().is_some_and(|a| {
            a.owner == *source
                && a.snapshot.connection_id == connection_id
                && a.snapshot.phase == ViewPhase::Streaming
                && self.allows(source, &a.snapshot.display_id)
        })
    }
}

#[cfg(test)]
mod tests;
