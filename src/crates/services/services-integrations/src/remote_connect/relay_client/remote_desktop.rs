//! Dedicated desktop requests, replies and registration on the account owner.
//! No second connection, ACK registry or authentication lifecycle is created.
use super::super::remote_desktop_device::{EncryptedSignal, RemoteDesktopReply};
use super::{ConnectionState, Owner, RelayClient, Reply, ReplyLane};
use anyhow::{anyhow, bail, Result};
use serde_json::json;
use std::{
    sync::{Arc, Weak},
    time::{Duration, Instant},
};

/// Local fencing token for one authenticated account socket. It grants no
/// remote authority and is never serialized or accepted from a wire payload.
/// The weak owner identity also prevents reuse on another RelayClient whose
/// counters happen to match.
#[derive(Clone)]
pub struct RemoteDesktopConnection {
    owner: Weak<std::sync::Mutex<Owner>>,
    epoch: u64,
    socket_generation: u64,
}

impl RemoteDesktopConnection {
    /// Local UI fencing only; never a Relay protocol field or authority claim.
    pub fn socket_generation(&self) -> u64 {
        self.socket_generation
    }

    fn matches(&self, identity: &Arc<std::sync::Mutex<Owner>>, owner: &Owner) -> bool {
        self.owner.ptr_eq(&Arc::downgrade(identity))
            && owner.epoch == self.epoch
            && owner.socket_generation == self.socket_generation
            && owner.state == ConnectionState::Connected
            && owner.sender.is_some()
    }
}

impl Owner {
    pub(super) fn remote_desktop_reply_owner(
        &self,
        socket_generation: u64,
        lane: ReplyLane,
        target: &str,
        correlation: &str,
    ) -> Result<&Reply> {
        if self.socket_generation != socket_generation
            || self.state != ConnectionState::Connected
            || !self.remote_desktop_requested
            || (lane == ReplyLane::RemoteDesktop && !self.remote_desktop_registered)
        {
            bail!("Remote desktop reply connection changed");
        }
        let reply = self
            .replies
            .get(correlation)
            .ok_or_else(|| anyhow!("Remote desktop acknowledgement is no longer pending"))?;
        if reply.socket_generation != socket_generation
            || reply.lane != lane
            || reply.source != target
            || reply.deadline <= Instant::now()
        {
            bail!("Remote desktop response owner expired");
        }
        Ok(reply)
    }
}

impl RelayClient {
    /// Controller calls do not require a local capture provider or rd-register.
    /// Capture before resolving a fixed peer key, then retain for that controller
    /// attachment. Reconnect requires a new attachment, never token refresh.
    pub fn remote_desktop_connection(&self) -> Result<RemoteDesktopConnection> {
        let owner = self.owner.lock().unwrap();
        if owner.state != ConnectionState::Connected || owner.sender.is_none() {
            bail!("remote_desktop_connection_changed");
        }
        Ok(RemoteDesktopConnection {
            owner: Arc::downgrade(&self.owner),
            epoch: owner.epoch,
            socket_generation: owner.socket_generation,
        })
    }

    pub fn remote_desktop_connection_is_current(&self, expected: &RemoteDesktopConnection) -> bool {
        let owner = self.owner.lock().unwrap();
        expected.matches(&self.owner, &owner)
    }

    /// Dedicated, bounded signaling on the existing authenticated socket. The
    /// caller pins the target's directory key; only ciphertext crosses Relay.
    /// No lifecycle lock is retained over IO and no mutation is replayed.
    pub async fn request_remote_desktop(
        &self,
        expected: &RemoteDesktopConnection,
        target: &str,
        attach_id: Option<&str>,
        encrypted: &EncryptedSignal,
        capabilities: &[String],
    ) -> Result<EncryptedSignal> {
        encrypted.validate()?;
        super::super::realtime_client::ensure_remote_desktop_route(capabilities)?;
        let sender = {
            let owner = self.owner.lock().unwrap();
            if !expected.matches(&self.owner, &owner) {
                bail!("remote_desktop_connection_changed");
            }
            owner
                .sender
                .clone()
                .ok_or_else(|| anyhow!("remote_desktop_connection_changed"))?
        };
        let params = serde_json::to_value(encrypted)?;
        let timeout = Duration::from_secs(10);
        let response = match attach_id {
            Some(attachment) => {
                sender
                    .call_remote_desktop_attachment(
                        target,
                        attachment,
                        params,
                        timeout,
                        capabilities,
                    )
                    .await
            }
            None => {
                sender
                    .call_remote_desktop(target, params, timeout, capabilities)
                    .await
            }
        };
        // Fence errors as well as successes. A late response/error from an old
        // socket must not affect the replacement controller connection.
        if !self.remote_desktop_connection_is_current(expected) {
            bail!("remote_desktop_connection_changed");
        }
        let encrypted: EncryptedSignal = serde_json::from_value(response?)?;
        encrypted.validate()?;
        Ok(encrypted)
    }

    pub fn remote_desktop_socket_is_current(&self, socket_generation: u64) -> bool {
        let owner = self.owner.lock().unwrap();
        owner.state == ConnectionState::Connected
            && owner.remote_desktop_registered
            && owner.socket_generation == socket_generation
    }

    pub fn remote_desktop_notice_socket_is_current(&self, socket_generation: u64) -> bool {
        let owner = self.owner.lock().unwrap();
        owner.state == ConnectionState::Connected
            && owner.remote_desktop_requested
            && owner.socket_generation == socket_generation
    }

    pub async fn acknowledge_remote_desktop_notice(
        &self,
        socket_generation: u64,
        correlation: &str,
        attach_id: &str,
        handled: bool,
    ) -> Result<()> {
        let (sender, reply) = {
            let mut owner = self.owner.lock().unwrap();
            owner.remote_desktop_reply_owner(
                socket_generation,
                ReplyLane::RemoteDesktopNotice,
                attach_id,
                correlation,
            )?;
            let sender = owner
                .sender
                .clone()
                .ok_or_else(|| anyhow!("Relay is disconnected"))?;
            let reply = owner
                .replies
                .remove(correlation)
                .ok_or_else(|| anyhow!("Notice acknowledgement is no longer pending"))?;
            (sender, reply)
        };
        sender
            .respond_remote_desktop_notice(reply.id, attach_id, handled)
            .await
    }

    /// Replies stay on the exact pending request/socket. Association metadata
    /// is host-produced and must agree with the original authenticated header.
    pub async fn reply_remote_desktop(
        &self,
        socket_generation: u64,
        target: &str,
        correlation: &str,
        response: &RemoteDesktopReply,
    ) -> Result<()> {
        let (sender, reply, payload) = {
            let mut owner = self.owner.lock().unwrap();
            let pending = owner.remote_desktop_reply_owner(
                socket_generation,
                ReplyLane::RemoteDesktop,
                target,
                correlation,
            )?;
            let payload = response.relay_payload(pending.attach_id.as_deref())?;
            let sender = owner
                .sender
                .clone()
                .ok_or_else(|| anyhow!("Relay is disconnected"))?;
            // Validation precedes removal; a wrong caller cannot consume a valid ACK.
            let reply = owner.replies.remove(correlation).unwrap();
            (sender, reply, payload)
        };
        sender.respond_remote_desktop(reply.id, payload).await
    }

    pub async fn end_remote_desktop(&self, socket_generation: u64, attach_id: &str) -> Result<()> {
        let sender = {
            let owner = self.owner.lock().unwrap();
            if owner.socket_generation != socket_generation
                || owner.state != ConnectionState::Connected
                || !owner.remote_desktop_requested
            {
                bail!("Remote desktop cleanup connection changed");
            }
            owner
                .sender
                .clone()
                .ok_or_else(|| anyhow!("Relay is disconnected"))?
        };
        sender.end_remote_desktop(attach_id).await
    }

    /// Invalid encrypted commands have no safe application reply key. Only this
    /// closed error set may be returned without application encryption.
    pub async fn reject_remote_desktop(&self, target: &str, correlation: &str) -> Result<()> {
        let (sender, reply) = {
            let mut owner = self.owner.lock().unwrap();
            let sender = owner
                .sender
                .clone()
                .ok_or_else(|| anyhow!("Relay is disconnected"))?;
            let reply = owner
                .replies
                .remove(correlation)
                .ok_or_else(|| anyhow!("Remote desktop acknowledgement is no longer pending"))?;
            (sender, reply)
        };
        if reply.source != target
            || reply.lane != ReplyLane::RemoteDesktop
            || reply.deadline <= Instant::now()
        {
            bail!("Remote desktop response owner expired");
        }
        sender
            .respond_remote_desktop(reply.id, json!({"$relayError":"invalid_request"}))
            .await
    }

    /// Optional host route on the same connection; never registered for CLI or
    /// other hosts unless their actual provider explicitly asks for it.
    pub async fn register_remote_desktop(&self, capabilities: &[String]) -> Result<()> {
        let _registration = self.remote_desktop_registration.lock().await;
        super::super::realtime_client::ensure_remote_desktop_route(capabilities)?;
        let (sender, epoch, socket_generation) = {
            let mut owner = self.owner.lock().unwrap();
            let sender = owner
                .sender
                .clone()
                .ok_or_else(|| anyhow!("Relay is disconnected"))?;
            // Requests can arrive as soon as the Relay joins the route room,
            // before its registration ACK reaches this socket.
            owner.remote_desktop_requested = true;
            (sender, owner.epoch, owner.socket_generation)
        };
        let result = sender.register_remote_desktop(capabilities).await;
        let current = self
            .owner
            .lock()
            .unwrap()
            .finish_remote_desktop_registration(epoch, socket_generation, result.is_ok());
        if !current {
            bail!("Relay connection changed during remote desktop registration");
        }
        result?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "remote_desktop_request_tests.rs"]
mod request_tests;
