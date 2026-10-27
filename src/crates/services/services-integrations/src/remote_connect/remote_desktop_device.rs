//! Authenticate a dedicated read-only command using the existing device-pair
//! encryption. Account/route identity and fixed peer keys stay outside wire bodies.
use super::{device_crypto, encryption};
use anyhow::{bail, Result};
use openbitfun_product_domains::remote_desktop::{
    ControllerIdentity, ReadOnlyRequest, PROTOCOL_VERSION,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_SIGNAL_PLAINTEXT_BYTES: usize = 96 * 1024 - 64;

/// Gather a reflexive candidate at the same operator-approved UDP endpoint.
/// Do not add public discovery servers or downgrade TCP/TLS-only configuration.
pub fn stun_url_for_turn_udp(url: &str) -> Option<String> {
    let address = url.strip_prefix("turn:")?;
    let authority = match address.split_once('?') {
        Some((authority, "transport=udp")) => authority,
        None => address,
        _ => return None,
    };
    if authority.is_empty()
        || authority.len() > 1019
        || authority
            .chars()
            .any(|c| c.is_whitespace() || "/@#?".contains(c))
    {
        return None;
    }
    Some(format!("stun:{authority}"))
}

#[derive(Debug, thiserror::Error)]
#[error("TURN issuance failed: {code} ({status})")]
pub struct TurnIssuanceError {
    pub code: &'static str,
    pub status: u16,
}

/// Only short-lived ICE credentials may cross the bundled renderer bridge.
/// These DTOs deliberately have no Debug implementation.
#[derive(Clone, Serialize, Deserialize)]
pub struct TurnIceServer {
    pub urls: Vec<String>,
    pub username: String,
    pub credential: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct TurnCredentials {
    pub target_device_id: String,
    pub attach_id: String,
    pub expires_at: u64,
    pub ice_servers: Vec<TurnIceServer>,
}
impl TurnCredentials {
    pub fn validate(&self, target: &str, attachment: &str, now_seconds: u64) -> Result<()> {
        if self.target_device_id != target
            || self.attach_id != attachment
            || self.expires_at <= now_seconds
            || self.expires_at > now_seconds.saturating_add(660)
            || self.ice_servers.is_empty()
            || self.ice_servers.len() > 4
            || self.ice_servers.iter().any(|server| {
                server.urls.is_empty()
                    || server.urls.len() > 4
                    || server.urls.iter().any(|url| {
                        url.len() > 1024
                            || !(url.starts_with("turn:") || url.starts_with("turns:"))
                            || url.chars().any(char::is_whitespace)
                    })
                    || server.username.is_empty()
                    || server.username.len() > 256
                    || server.credential.is_empty()
                    || server.credential.len() > 256
            })
        {
            bail!("TURN credentials are invalid, expired or belong to another attachment");
        }
        Ok(())
    }
}

/// Relay-only association metadata. It is produced by the host after its own
/// policy decision, never deserialized from an encrypted controller command.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum AttachmentDisposition {
    Accepted,
    Ended,
}

pub struct AttachmentReply {
    pub attach_id: String,
    pub disposition: AttachmentDisposition,
}

pub struct RemoteDesktopReply {
    pub encrypted: EncryptedSignal,
    pub attachment: Option<AttachmentReply>,
}

impl RemoteDesktopReply {
    pub(super) fn relay_payload(
        &self,
        route_attachment: Option<&str>,
    ) -> Result<serde_json::Value> {
        self.encrypted.validate()?;
        let mut payload = serde_json::to_value(&self.encrypted)?;
        if let Some(attachment) = &self.attachment {
            super::realtime_client::validate_remote_desktop_attachment(&attachment.attach_id)?;
            if route_attachment != Some(attachment.attach_id.as_str()) {
                bail!("Remote desktop reply attachment does not match its route");
            }
            payload["$rdAttachment"] = serde_json::Value::String(
                match attachment.disposition {
                    AttachmentDisposition::Accepted => "accepted",
                    AttachmentDisposition::Ended => "ended",
                }
                .into(),
            );
        }
        Ok(payload)
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct EncryptedSignal {
    pub encrypted_data: String,
    pub nonce: String,
}

impl EncryptedSignal {
    pub fn validate(&self) -> Result<()> {
        if self.encrypted_data.is_empty()
            || self.encrypted_data.len() > 128 * 1024
            || self.nonce.is_empty()
            || self.nonce.len() > 128
        {
            bail!("Invalid remote desktop encryption envelope");
        }
        Ok(())
    }
}

pub struct VerifiedReadOnlyRequest {
    pub source: ControllerIdentity,
    pub request: ReadOnlyRequest,
}

/// Fingerprint the canonical 32-byte X25519 key, not its display name/base64 text.
pub fn public_key_fingerprint(public_key: &[u8; 32]) -> String {
    Sha256::digest(public_key)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn encrypt_signal(
    local_secret: &[u8; 32],
    fixed_peer_key: &[u8; 32],
    plaintext: &str,
) -> Result<EncryptedSignal> {
    // Bound JSON before encryption/base64 as well as after encoding.
    if plaintext.len() > MAX_SIGNAL_PLAINTEXT_BYTES {
        bail!("Remote desktop signaling payload is too large");
    }
    let key = device_crypto::derive_message_key(local_secret, fixed_peer_key)?;
    let (encrypted_data, nonce) = encryption::encrypt_to_base64(&key, plaintext)?;
    let result = EncryptedSignal {
        encrypted_data,
        nonce,
    };
    result.validate()?;
    Ok(result)
}

/// account_id/source_device_id must come from the authenticated host connection
/// and Relay-injected source respectively. Resolve and pin the same-account peer
/// key before calling; request fields never select a key or grant principal.
pub fn decrypt_read_only_request(
    local_secret: &[u8; 32],
    fixed_peer_key: &[u8; 32],
    account_id: &str,
    source_device_id: &str,
    encrypted: &EncryptedSignal,
) -> Result<VerifiedReadOnlyRequest> {
    encrypted.validate()?;
    let key = device_crypto::derive_message_key(local_secret, fixed_peer_key)?;
    let plaintext =
        encryption::decrypt_from_base64(&key, &encrypted.encrypted_data, &encrypted.nonce)?;
    let request: ReadOnlyRequest = serde_json::from_str(&plaintext)?;
    if request.version != PROTOCOL_VERSION {
        bail!("unsupported_protocol");
    }
    Ok(VerifiedReadOnlyRequest {
        source: ControllerIdentity {
            account_id: account_id.into(),
            device_id: source_device_id.into(),
            public_key_fingerprint: public_key_fingerprint(fixed_peer_key),
        },
        request,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_product_domains::remote_desktop::{
        ReadOnlyCommand, ReadOnlyHost, ViewGrant, ViewGrantFile,
    };

    #[test]
    fn remote_desktop_stun_uses_only_the_approved_udp_turn_authority() {
        assert_eq!(
            stun_url_for_turn_udp("turn:trial.example:3478?transport=udp").as_deref(),
            Some("stun:trial.example:3478")
        );
        assert_eq!(
            stun_url_for_turn_udp("turn:[2001:db8::1]:3478").as_deref(),
            Some("stun:[2001:db8::1]:3478")
        );
        for url in [
            "turns:trial.example:5349",
            "turn:trial.example:3478?transport=tcp",
            "turn:",
            "stun:public.example:3478",
            "turn://trial.example",
            "turn:user@trial.example",
            "turn:trial.example#other",
            "turn:trial.example?transport=udp&extra=1",
            "turn:trial.example?transport=udp?other",
            "turn:trial.example\n",
        ] {
            assert_eq!(stun_url_for_turn_udp(url), None);
        }
    }

    #[test]
    fn remote_desktop_reply_metadata_is_scoped_and_never_part_of_the_ciphertext() {
        let encrypted = encrypt_signal(
            &[7; 32],
            &device_crypto::public_key(&[11; 32]),
            r#"{"state":{"attachment":null}}"#,
        )
        .unwrap();
        let mut reply = RemoteDesktopReply {
            encrypted: encrypted.clone(),
            attachment: None,
        };
        assert_eq!(
            reply.relay_payload(None).unwrap(),
            serde_json::to_value(&encrypted).unwrap()
        );
        for disposition in [
            AttachmentDisposition::Accepted,
            AttachmentDisposition::Ended,
        ] {
            reply.attachment = Some(AttachmentReply {
                attach_id: "attachment".into(),
                disposition,
            });
            assert!(reply.relay_payload(None).is_err());
            assert!(reply.relay_payload(Some("other-attachment")).is_err());
            let payload = reply.relay_payload(Some("attachment")).unwrap();
            let marker = if disposition == AttachmentDisposition::Accepted {
                "accepted"
            } else {
                "ended"
            };
            assert_eq!(payload["$rdAttachment"], marker);
            assert_eq!(payload["encrypted_data"], encrypted.encrypted_data);
            assert_eq!(payload["nonce"], encrypted.nonce);
        }
        reply.attachment.as_mut().unwrap().attach_id.clear();
        assert!(reply.relay_payload(Some("")).is_err());
    }

    #[test]
    fn authenticated_ciphertext_cannot_choose_the_source_or_approval_identity() {
        let phone = [7; 32];
        let host = [11; 32];
        let phone_public = device_crypto::public_key(&phone);
        let encrypted = encrypt_signal(&phone, &device_crypto::public_key(&host),
            r#"{"version":1,"op":"attach","account_id":"evil","sourceDeviceId":"desktop","body":{"attach_id":"a","display_id":"screen","expected_state_revision":"boot:0"}}"#).unwrap();
        let verified =
            decrypt_read_only_request(&host, &phone_public, "account", "phone", &encrypted)
                .unwrap();
        assert_eq!(verified.source.account_id, "account");
        assert_eq!(verified.source.device_id, "phone");
        let grant = ViewGrant {
            account_id: "account".into(),
            device_id: "phone".into(),
            public_key_fingerprint: public_key_fingerprint(&phone_public),
            display_ids: vec!["screen".into()],
            control_display_ids: vec![],
        };
        let mut owner = ReadOnlyHost::new(
            "account".into(),
            "boot".into(),
            ViewGrantFile {
                version: 1,
                grants: vec![grant],
            },
        )
        .unwrap();
        let ReadOnlyCommand::Attach(request) = verified.request.command else {
            panic!("expected attach");
        };
        assert_eq!(
            owner
                .attach(&verified.source, &request, "host-generated-pc")
                .unwrap()
                .len(),
            1
        );
        assert!(!owner.may_send_frame(&verified.source, "host-generated-pc", 0));
        assert!(decrypt_read_only_request(
            &host,
            &device_crypto::public_key(&[17; 32]),
            "account",
            "phone",
            &encrypted
        )
        .is_err());
    }

    #[test]
    fn version_mismatch_agent_commands_and_remote_grant_ops_are_rejected() {
        for text in [
            r#"{"version":2,"op":"capabilities"}"#,
            r#"{"cmd":"invoke","body":{}}"#,
            r#"{"version":1,"op":"grant","body":{}}"#,
            r#"{"version":1,"op":"acquire_control","body":{}}"#,
        ] {
            let encrypted =
                encrypt_signal(&[7; 32], &device_crypto::public_key(&[11; 32]), text).unwrap();
            assert!(decrypt_read_only_request(
                &[11; 32],
                &device_crypto::public_key(&[7; 32]),
                "account",
                "phone",
                &encrypted
            )
            .is_err());
        }
        assert!(encrypt_signal(&[7; 32], &[0; 32], "{}").is_err());
        assert!(encrypt_signal(
            &[7; 32],
            &device_crypto::public_key(&[11; 32]),
            &"x".repeat(96 * 1024)
        )
        .is_err());
    }
}
