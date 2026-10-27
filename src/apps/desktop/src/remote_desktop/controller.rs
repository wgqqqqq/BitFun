//! Controller requests use only the independent self-hosted desktop connection.
use super::connection::{self, Connection};
use openbitfun_product_domains::remote_desktop::{
    ReadOnlyCommand, ReadOnlyRequest, PROTOCOL_VERSION,
};
use openbitfun_services_integrations::remote_connect::{
    account::AccountClient,
    device_crypto, encryption,
    relay_client::RemoteDesktopConnection,
    remote_desktop_device::{
        encrypt_signal, public_key_fingerprint, TurnCredentials, TurnIssuanceError,
        MAX_SIGNAL_PLAINTEXT_BYTES,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

/// Decimal counters avoid JavaScript integer precision loss. None of these
/// local fields is copied into the encrypted request or Relay route envelope.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControllerContext {
    pub account_generation: String,
    pub connection_id: String,
    pub socket_generation: String,
    pub target_device_id: String,
    pub public_key_fingerprint: String,
}

impl ControllerContext {
    fn same_route(&self, other: &Self) -> bool {
        self.account_generation == other.account_generation
            && self.connection_id == other.connection_id
            && self.socket_generation == other.socket_generation
            && self.target_device_id == other.target_device_id
    }
}

#[derive(Deserialize)]
pub struct ControllerRequest {
    pub target_device_id: String,
    pub payload: ReadOnlyRequest,
    #[serde(default)]
    pub attach_id: Option<String>,
    #[serde(default)]
    pub context: Option<ControllerContext>,
}

impl ControllerRequest {
    fn validate(&self) -> Result<(), String> {
        if !valid_id(&self.target_device_id)
            || self.attach_id.as_deref().is_some_and(|id| !valid_id(id))
            || !self
                .payload
                .matches_route_attachment(self.attach_id.as_deref())
        {
            return Err("invalid_request".into());
        }
        if self.payload.version != PROTOCOL_VERSION {
            return Err("unsupported_protocol".into());
        }
        // An old UI must not silently obtain a fresh binding to execute an old
        // mutation. Only a new capability probe bootstraps local context.
        if self.context.is_none() && !matches!(&self.payload.command, ReadOnlyCommand::Capabilities)
        {
            return Err("controller_context_required".into());
        }
        Ok(())
    }
}

#[derive(Serialize)]
pub struct ControllerReply {
    pub context: ControllerContext,
    pub payload: Value,
}

#[derive(Deserialize)]
pub struct ControllerTurnRequest {
    pub target_device_id: String,
    pub attach_id: String,
    pub context: ControllerContext,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}

struct Prepared {
    owner: Arc<Connection>,
    socket: RemoteDesktopConnection,
    context: ControllerContext,
    peer_key: [u8; 32],
}
impl Prepared {
    async fn capture(target: &str, expected: Option<&ControllerContext>) -> Result<Self, String> {
        let owner = connection::snapshot()?;
        let socket = owner
            .client
            .remote_desktop_connection()
            .map_err(|_| "remote_desktop_connection_changed")?;
        let mut context = ControllerContext {
            account_generation: owner.generation.to_string(),
            connection_id: owner.generation.to_string(),
            socket_generation: socket.socket_generation().to_string(),
            target_device_id: target.into(),
            public_key_fingerprint: String::new(),
        };
        if expected.is_some_and(|old| !old.same_route(&context)) {
            return Err("controller_context_changed".into());
        }
        let peer_key = AccountClient::new()
            .device_public_key(&owner.relay, &owner.session, target)
            .await
            .map_err(|_| "target_identity_unavailable")?;
        context.public_key_fingerprint = public_key_fingerprint(&peer_key);
        if expected.is_some_and(|old| old != &context) {
            return Err("target_identity_changed".into());
        }
        let prepared = Self {
            owner,
            socket,
            context,
            peer_key,
        };
        prepared.require_current()?;
        Ok(prepared)
    }
    fn require_current(&self) -> Result<(), String> {
        if !connection::is_current(self.owner.generation)
            || !self
                .owner
                .client
                .remote_desktop_connection_is_current(&self.socket)
        {
            return Err("remote_desktop_connection_changed".into());
        }
        Ok(())
    }
    async fn verify_reply_owner(&self) -> Result<(), String> {
        self.require_current()?;
        let key = AccountClient::new()
            .device_public_key(
                &self.owner.relay,
                &self.owner.session,
                &self.context.target_device_id,
            )
            .await
            .map_err(|_| "target_identity_unavailable")?;
        self.require_current()?;
        if key != self.peer_key {
            return Err("target_identity_changed".into());
        }
        Ok(())
    }
}

fn route_error(error: &anyhow::Error) -> String {
    // Never expose arbitrary transport/error bodies (which may contain URLs,
    // tokens or payloads). Unknown delivery is not a reason to replay a call.
    match error.to_string().as_str() {
        "remote_desktop_connection_changed" => "remote_desktop_connection_changed",
        "relay_upgrade_required" => "relay_upgrade_required",
        "target_offline" => "target_offline",
        "unsupported" => "unsupported",
        "invalid_request" => "invalid_request",
        "invalid_response" => "invalid_response",
        "unauthorized" => "unauthorized",
        "capacity_exceeded" => "capacity_exceeded",
        "forbidden" => "forbidden",
        "unsupported_protocol" => "unsupported_protocol",
        "target_unavailable" => "target_unavailable",
        "authorization_expired" => "authorization_expired",
        "authorization_unknown" => "authorization_unknown",
        "deadline_elapsed" => "deadline_elapsed",
        "attachment_busy" => "attachment_busy",
        "attach_id_conflict" => "attach_id_conflict",
        "attachment_binding_changed" => "attachment_binding_changed",
        "attachment_identity_changed" => "attachment_identity_changed",
        "attachment_unavailable" => "attachment_unavailable",
        _ => "delivery_unknown",
    }
    .into()
}

pub(crate) async fn perform_remote_desktop_request(
    request: ControllerRequest,
) -> Result<ControllerReply, String> {
    request.validate()?;
    let text = serde_json::to_string(&request.payload).map_err(|_| "invalid_request")?;
    if text.len() > MAX_SIGNAL_PLAINTEXT_BYTES {
        return Err("invalid_request".into());
    }
    let prepared = Prepared::capture(&request.target_device_id, request.context.as_ref()).await?;
    let encrypted = encrypt_signal(
        &prepared.owner.session.master_key,
        &prepared.peer_key,
        &text,
    )
    .map_err(|_| "invalid_request")?;
    prepared.require_current()?;
    let response = prepared
        .owner
        .client
        .request_remote_desktop(
            &prepared.socket,
            &request.target_device_id,
            request.attach_id.as_deref(),
            &encrypted,
            &prepared.owner.capabilities,
        )
        .await;
    prepared.verify_reply_owner().await?;
    let response = response.map_err(|e| route_error(&e))?;
    let key =
        device_crypto::derive_message_key(&prepared.owner.session.master_key, &prepared.peer_key)
            .map_err(|_| "signal_decryption_failed")?;
    let text = encryption::decrypt_from_base64(&key, &response.encrypted_data, &response.nonce)
        .map_err(|_| "signal_decryption_failed")?;
    if text.len() > MAX_SIGNAL_PLAINTEXT_BYTES {
        return Err("invalid_response".into());
    }
    let payload: Value = serde_json::from_str(&text).map_err(|_| "invalid_response")?;
    if !payload.is_object() {
        return Err("invalid_response".into());
    }
    prepared.require_current()?;
    Ok(ControllerReply {
        context: prepared.context,
        payload,
    })
}

pub(crate) async fn perform_remote_desktop_turn(
    request: ControllerTurnRequest,
) -> Result<TurnCredentials, String> {
    if !valid_id(&request.target_device_id) || !valid_id(&request.attach_id) {
        return Err("invalid_request".into());
    }
    let prepared = Prepared::capture(&request.target_device_id, Some(&request.context)).await?;
    let result = AccountClient::new()
        .remote_desktop_turn(
            &prepared.owner.relay,
            &prepared.owner.session,
            &request.target_device_id,
            &request.attach_id,
            &prepared.owner.capabilities,
        )
        .await;
    prepared.verify_reply_owner().await?;
    result.map_err(|error| match error.downcast_ref::<TurnIssuanceError>() {
        Some(error) => error.code.to_owned(),
        None => "turn_unavailable".into(),
    })
}

#[cfg(test)]
#[path = "controller_tests.rs"]
mod tests;
