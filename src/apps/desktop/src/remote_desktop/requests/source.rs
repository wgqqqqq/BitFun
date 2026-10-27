//! The host lock serializes source mutation with native reservation and grants.
use super::*;
use openbitfun_product_domains::remote_desktop::{SelectDisplayRequest, SourceRequest, ViewPhase};

impl RemoteDesktopState {
    pub(super) fn set_source_quality(
        &self,
        host: &mut Host,
        source: &ControllerIdentity,
        request: openbitfun_product_domains::remote_desktop::SetQualityRequest,
    ) -> HostReply {
        match host.policy.set_quality(source, &request) {
            Ok(()) => HostReply::plain(json!({"state":host.policy.snapshot(source).ok()})),
            Err(code) => HostReply::plain(error(domain_error(code))),
        }
    }

    pub(super) fn suspend_source(
        &self,
        host: &mut Host,
        source: &ControllerIdentity,
        request: SourceRequest,
    ) -> HostReply {
        match host
            .policy
            .suspend(source, &request.attach_id, &request.expected_state_revision)
        {
            Ok(effects) => {
                self.apply_media(effects);
                // The existing Relay association stays live. Do not ask it to
                // bind a transport while native cleanup is still pending.
                HostReply::plain(json!({"state":host.policy.snapshot(source).ok()}))
            }
            Err(code) => HostReply::plain(error(domain_error(code))),
        }
    }

    pub(super) fn select_source(
        &self,
        host: &mut Host,
        source: &ControllerIdentity,
        request: SelectDisplayRequest,
        availability: &str,
    ) -> HostReply {
        let same = host
            .policy
            .snapshot(source)
            .ok()
            .and_then(|state| state.attachment)
            .is_some_and(|current| {
                current.attach_id == request.attach_id && current.display_id == request.display_id
            });
        if !host.policy.allows(source, &request.display_id) {
            return HostReply::plain(error("device_approval_required"));
        }
        if !same {
            if availability != "ready" {
                return HostReply::plain(error(availability));
            }
            if displays::resolve(&request.display_id).is_err() {
                return HostReply::plain(error("target_lost"));
            }
        }
        match host.policy.select_display(
            source,
            &request.attach_id,
            &request.display_id,
            &request.expected_state_revision,
        ) {
            Ok(effects) => {
                self.apply_media(effects);
                HostReply::plain(json!({"state":host.policy.snapshot(source).ok()}))
            }
            Err(code) => HostReply::plain(error(domain_error(code))),
        }
    }

    pub(super) fn resume_source(
        &self,
        host: &mut Host,
        source: &ControllerIdentity,
        request: SourceRequest,
        socket_generation: u64,
        availability: &str,
    ) -> HostReply {
        let current = match host.policy.snapshot(source) {
            Ok(state) => match state
                .attachment
                .filter(|a| a.attach_id == request.attach_id)
            {
                Some(current) => current,
                None => return HostReply::plain(error("stale_connection")),
            },
            Err(code) => return HostReply::plain(error(domain_error(code))),
        };
        if current.phase != ViewPhase::Suspended {
            return HostReply::plain(error("invalid_request"));
        }
        if availability != "ready" {
            return HostReply::plain(error(availability));
        }
        // Resolve again at resume, never reuse the old PC's cached geometry.
        let target = match displays::resolve_with_quality(&current.display_id, current.quality) {
            Ok(target) => target,
            Err(_) => return HostReply::plain(error("target_lost")),
        };
        self.prepare_resumed_source(host, source, request, socket_generation, target)
    }

    fn prepare_resumed_source(
        &self,
        host: &mut Host,
        source: &ControllerIdentity,
        request: SourceRequest,
        socket_generation: u64,
        target: displays::CaptureTarget,
    ) -> HostReply {
        let current = match host
            .policy
            .snapshot(source)
            .ok()
            .and_then(|state| state.attachment)
            .filter(|a| a.attach_id == request.attach_id)
        {
            Some(current) => current,
            None => return HostReply::plain(error("stale_connection")),
        };
        let old = match self
            .1
            .retained(source, &request.attach_id, &current.connection_id)
        {
            Ok(old) => old,
            Err(code) => return HostReply::plain(error(code)),
        };
        let Some(relay) = host.relay.clone() else {
            return HostReply::plain(error("target_unavailable"));
        };
        let connection_id = uuid::Uuid::new_v4().to_string();
        if let Err(code) = host.policy.resume(
            source,
            &request.attach_id,
            &request.expected_state_revision,
            &connection_id,
        ) {
            return HostReply::plain(error(domain_error(code)));
        }
        let pending = media_session::PendingMedia {
            generation: host.account_generation,
            socket_generation,
            relay,
            source: source.clone(),
            attach_id: request.attach_id.clone(),
            connection_id: connection_id.clone(),
            target,
            force_relay: old.force_relay(),
            quality: current.quality,
            owner: Arc::downgrade(&self.0),
        };
        if let Err(code) = self.1.reserve(pending) {
            // No new PC exists on reservation failure. Retire the logical new
            // binding, clear only its empty cleanup record, then wake the old
            // retained owner. Never leave an unowned binding or replay resume.
            let _ = host.policy.stop();
            let _ = host.policy.media_closed(&connection_id);
            self.1.cancel();
            return HostReply::plain(error(code));
        }
        host.failure = None;
        HostReply {
            body: json!({"state":host.policy.snapshot(source).ok()}),
            attachment: Some(AttachmentReply {
                attach_id: request.attach_id,
                disposition: AttachmentDisposition::Accepted,
            }),
        }
    }
}

#[cfg(test)]
mod tests;
