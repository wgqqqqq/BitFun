//! Authenticated viewing/source wire commands. Native preparation and resource
//! drainage stay in media_session; local trust writes stay in the host facade.
use super::*;
#[cfg(feature = "remote-desktop-media")]
mod source;

impl RemoteDesktopState {
    fn check_credential_binding(
        &self,
        host: &mut Host,
        source: &ControllerIdentity,
        attachment: Option<&str>,
        binding: Option<&str>,
    ) -> Result<(), &'static str> {
        let Some(attachment) = attachment else {
            return Ok(());
        };
        let valid = binding.is_some_and(|value| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        });
        let owns = host.policy.snapshot(source).is_ok_and(|snapshot| {
            snapshot
                .attachment
                .is_some_and(|current| current.attach_id == attachment)
        });
        if owns && (!valid || binding != host.credential_binding.as_deref()) {
            // A fresh Relay registry cannot replace the credentials of a live
            // or suspended attachment, even for the same device and public key.
            match host.policy.stop() {
                Ok(effects) => self.apply_media(effects),
                Err(_) => {
                    #[cfg(feature = "remote-desktop-media")]
                    self.1.cancel();
                }
            }
            return Err("authorization_expired");
        }
        if !valid {
            return Err("relay_upgrade_required");
        }
        Ok(())
    }

    pub(super) fn availability(&self, generation: u64) -> &'static str {
        #[cfg(feature = "remote-desktop-media")]
        {
            let owner = self.0.lock().unwrap();
            let Some(relay) = owner
                .as_ref()
                .filter(|host| host.account_generation == generation)
                .and_then(|host| host.relay.as_ref())
            else {
                return "media_backend_unavailable";
            };
            if !relay
                .capabilities
                .iter()
                .any(|value| value == "remote_desktop_credential_binding_v1")
            {
                return "relay_upgrade_required";
            }
            if !relay
                .capabilities
                .iter()
                .any(|value| value == "remote_desktop_turn_v1")
            {
                return "turn_unavailable";
            }
            let Ok(url) =
                openbitfun_services_integrations::remote_connect::account::validate_relay_base_url(
                    &relay.relay_url,
                )
            else {
                return "target_unavailable";
            };
            let local = url.host_str().is_some_and(|host| {
                host == "localhost"
                    || host
                        .trim_matches(['[', ']'])
                        .parse::<std::net::IpAddr>()
                        .is_ok_and(|ip| ip.is_loopback())
            });
            if url.scheme() != "https" && !local {
                return "remote_desktop_requires_https";
            }
            if self.1.cleaning() {
                return "cleanup_pending";
            }
            return capture::availability();
        }
        #[cfg(not(feature = "remote-desktop-media"))]
        {
            let _ = generation;
            if cfg!(target_os = "macos") {
                "media_backend_unavailable"
            } else {
                "unsupported"
            }
        }
    }

    pub(crate) async fn handle(
        &self,
        generation: u64,
        socket_generation: u64,
        source: &ControllerIdentity,
        request: ReadOnlyRequest,
        route_attachment: Option<&str>,
        credential_binding: Option<&str>,
    ) -> HostReply {
        if request.version != 1 || !request.matches_route_attachment(route_attachment) {
            return HostReply::plain(error("invalid_request"));
        }
        // Only Relay-supplied metadata is passed here, outside the encrypted
        // controller command. Check before Signal or any source mutation.
        {
            let mut owner = self.0.lock().unwrap();
            let Some(host) = owner.as_mut().filter(|host| {
                host.account_generation == generation
                    && crate::remote_desktop::connection::is_current(generation)
            }) else {
                return HostReply::plain(error("target_unavailable"));
            };
            if let Err(code) =
                self.check_credential_binding(host, source, route_attachment, credential_binding)
            {
                return HostReply::plain(error(code));
            }
        }
        if let ReadOnlyCommand::Signal(answer) = request.command {
            #[cfg(feature = "remote-desktop-media")]
            {
                let slot = {
                    let owner = self.0.lock().unwrap();
                    owner
                        .as_ref()
                        .filter(|host| {
                            host.account_generation == generation
                                && crate::remote_desktop::connection::is_current(generation)
                        })
                        .filter(|host| {
                            answer.valid()
                                && host
                                    .policy
                                    .connection_for(
                                        source,
                                        &answer.attach_id,
                                        &answer.connection_id,
                                    )
                                    .is_ok()
                        })
                        .and_then(|_| self.1.current(source, &answer.connection_id))
                };
                return match slot {
                    Some(slot) => match slot.answer(answer).await {
                        Ok(()) => HostReply::plain(json!({"answer_accepted":true})),
                        Err(code) => HostReply::plain(error(code)),
                    },
                    None => HostReply::plain(error("stale_connection")),
                };
            }
            #[cfg(not(feature = "remote-desktop-media"))]
            {
                let _ = answer;
                return HostReply::plain(error("media_backend_unavailable"));
            }
        }
        let availability = self.availability(generation);
        #[cfg(feature = "remote-desktop-media")]
        let codecs = if availability == "ready" {
            self.1.codecs()
        } else {
            Vec::new()
        };
        #[cfg(not(feature = "remote-desktop-media"))]
        let codecs: Vec<String> = Vec::new();
        let mut owner = self.0.lock().unwrap();
        let Some(host) = owner.as_mut().filter(|host| {
            host.account_generation == generation
                && crate::remote_desktop::connection::is_current(generation)
        }) else {
            return HostReply::plain(error("target_unavailable"));
        };
        if let Err(code) =
            self.check_credential_binding(host, source, route_attachment, credential_binding)
        {
            return HostReply::plain(error(code));
        }
        let mut attachment = None;
        let body = match request.command {
            ReadOnlyCommand::Capabilities => {
                let mut capabilities = Vec::new();
                if availability == "ready" {
                    capabilities.extend(["read_only_video_v1", "gathered_sdp_v1"]);
                    capabilities.extend([
                        openbitfun_product_domains::remote_desktop::SOURCE_LIFECYCLE_V1,
                        openbitfun_product_domains::remote_desktop::CREDENTIAL_REBUILD_V1,
                        openbitfun_product_domains::remote_desktop::QUALITY_PRESETS_V1,
                    ]);
                    if Self::control_available() {
                        capabilities.push("ordered_control_v1");
                        #[cfg(feature = "remote-desktop-media")]
                        if native_input::text_supported() {
                            capabilities.push("text_commit_v1");
                        }
                    }
                }
                json!({"protocol_versions":[1], "availability":availability,
                "capabilities":capabilities, "codecs":codecs,
                "authorization":if host.policy.authorized_displays(source).is_empty() {"device_approval_required"} else {"view"}})
            }
            ReadOnlyCommand::ListDisplays => {
                let allowed = host.policy.authorized_displays(source);
                if allowed.is_empty() {
                    return HostReply::plain(error("device_approval_required"));
                }
                // handle_remote_desktop_message already checked this socket,
                // source directory/key and encrypted request. A new display
                // probe can recover only an idle host, never an old PC/lease.
                if let Err(code) = host.policy.revalidate_idle_route(source) {
                    return HostReply::plain(error(domain_error(code)));
                }
                match displays::list() {
                    Ok(displays) => {
                        json!({"displays":displays.into_iter().filter(|display| allowed.contains(&display.display_id)).collect::<Vec<_>>(), "state_revision":host.policy.revision()})
                    }
                    Err(_) => error("unsupported"),
                }
            }
            ReadOnlyCommand::GetState => match host.policy.snapshot(source) {
                Ok(snapshot) => {
                    #[cfg(feature = "remote-desktop-media")]
                    {
                        let slot = snapshot
                            .attachment
                            .as_ref()
                            .and_then(|current| self.1.current(source, &current.connection_id));
                        // A drained suspended transport has no reusable SDP,
                        // but its fixed-key Relay association can be revalidated.
                        let relation = snapshot.attachment.as_ref().and_then(|current| {
                            self.1.for_attachment(&current.attach_id).filter(|slot| {
                                slot.source() == source
                                    && slot.connection_id() == current.connection_id
                            })
                        });
                        if let Some(slot) = relation
                            .as_ref()
                            .filter(|slot| route_attachment == Some(slot.attach_id()))
                        {
                            attachment = Some(AttachmentReply {
                                attach_id: slot.attach_id().into(),
                                disposition: AttachmentDisposition::Accepted,
                            });
                        }
                        let failure = host
                            .failure
                            .as_ref()
                            .filter(|(owner, _)| owner == source)
                            .map(|(_, code)| *code);
                        json!({"state":snapshot,"media":slot.map(|slot|slot.status()),"media_error":failure})
                    }
                    #[cfg(not(feature = "remote-desktop-media"))]
                    json!({"state":snapshot})
                }
                Err(_) => error("device_approval_required"),
            },
            ReadOnlyCommand::Attach(request) => {
                if !host.policy.allows(source, &request.display_id) {
                    return HostReply::plain(error("device_approval_required"));
                }
                // Resolve a live retry before OS/cleanup checks. After source
                // selection its immutable initial display may no longer be the
                // current target; a retry must neither resolve it nor rewind it.
                #[cfg(feature = "remote-desktop-media")]
                if let Some(current) = host
                    .policy
                    .snapshot(source)
                    .ok()
                    .and_then(|state| state.attachment)
                {
                    return match host.policy.attach(source, &request, &current.connection_id) {
                        Ok(_) => HostReply {
                            body: json!({"state":host.policy.snapshot(source).ok()}),
                            attachment: self
                                .1
                                .for_attachment(&request.attach_id)
                                .filter(|slot| {
                                    slot.source() == source
                                        && slot.connection_id() == current.connection_id
                                })
                                .map(|_| AttachmentReply {
                                    attach_id: request.attach_id,
                                    disposition: AttachmentDisposition::Accepted,
                                }),
                        },
                        Err(code) => HostReply::plain(error(domain_error(code))),
                    };
                }
                if availability != "ready" {
                    return HostReply::plain(error(availability));
                }
                #[cfg(feature = "remote-desktop-media")]
                {
                    let snapshot = host.policy.snapshot(source).unwrap();
                    if !snapshot.busy && self.1.occupied() {
                        return HostReply::plain(error("cleanup_pending"));
                    }
                    let target = match displays::resolve(&request.display_id) {
                        Ok(target) => target,
                        Err(_) => return HostReply::plain(error("target_lost")),
                    };
                    let connection_id = uuid::Uuid::new_v4().to_string();
                    match host.policy.attach(source, &request, &connection_id) {
                        Ok(effects) => {
                            host.credential_binding = credential_binding.map(str::to_owned);
                            if !effects.is_empty() {
                                let relay = host.relay.clone().unwrap();
                                let pending = media_session::PendingMedia {
                                    generation,
                                    socket_generation,
                                    relay,
                                    source: source.clone(),
                                    attach_id: request.attach_id.clone(),
                                    connection_id: connection_id.clone(),
                                    target,
                                    force_relay: request.force_relay,
                                    quality: Default::default(),
                                    owner: Arc::downgrade(&self.0),
                                };
                                if let Err(code) = self.1.reserve(pending) {
                                    let _ = host.policy.stop();
                                    let _ = host.policy.media_closed(&connection_id);
                                    return HostReply::plain(error(code));
                                }
                                host.failure = None;
                            }
                            attachment = Some(AttachmentReply {
                                attach_id: request.attach_id,
                                disposition: AttachmentDisposition::Accepted,
                            });
                            json!({"state":host.policy.snapshot(source).ok()})
                        }
                        Err(code) => error(domain_error(code)),
                    }
                }
                #[cfg(not(feature = "remote-desktop-media"))]
                error("media_backend_unavailable")
            }
            ReadOnlyCommand::Detach { attach_id } => {
                let owned = host
                    .policy
                    .snapshot(source)
                    .ok()
                    .and_then(|snapshot| snapshot.attachment)
                    .is_some_and(|current| current.attach_id == attach_id);
                match host.policy.detach(source, &attach_id) {
                    Ok(effects) => {
                        self.apply_media(effects);
                        if owned {
                            attachment = Some(AttachmentReply {
                                attach_id,
                                disposition: AttachmentDisposition::Ended,
                            });
                        }
                        json!({"state":host.policy.snapshot(source).ok()})
                    }
                    Err(code) => error(domain_error(code)),
                }
            }
            ReadOnlyCommand::Suspend(request) => {
                #[cfg(feature = "remote-desktop-media")]
                {
                    return self.suspend_source(host, source, request);
                }
                #[cfg(not(feature = "remote-desktop-media"))]
                {
                    let _ = request;
                    error("media_backend_unavailable")
                }
            }
            ReadOnlyCommand::SelectDisplay(request) => {
                #[cfg(feature = "remote-desktop-media")]
                {
                    return self.select_source(host, source, request, availability);
                }
                #[cfg(not(feature = "remote-desktop-media"))]
                {
                    let _ = request;
                    error("media_backend_unavailable")
                }
            }
            ReadOnlyCommand::SetQuality(request) => {
                #[cfg(feature = "remote-desktop-media")]
                {
                    return self.set_source_quality(host, source, request);
                }
                #[cfg(not(feature = "remote-desktop-media"))]
                {
                    let _ = request;
                    error("media_backend_unavailable")
                }
            }
            ReadOnlyCommand::Resume(request) => {
                #[cfg(feature = "remote-desktop-media")]
                {
                    return self.resume_source(
                        host,
                        source,
                        request,
                        socket_generation,
                        availability,
                    );
                }
                #[cfg(not(feature = "remote-desktop-media"))]
                {
                    let _ = request;
                    error("media_backend_unavailable")
                }
            }
            ReadOnlyCommand::Signal(_) => unreachable!(),
        };
        let _ = (socket_generation, route_attachment);
        HostReply { body, attachment }
    }
}

pub(crate) struct HostReply {
    pub body: Value,
    pub attachment: Option<AttachmentReply>,
}
impl HostReply {
    pub(crate) fn plain(body: Value) -> Self {
        Self {
            body,
            attachment: None,
        }
    }
}
fn domain_error(code: openbitfun_product_domains::remote_desktop::ReadOnlyError) -> &'static str {
    use openbitfun_product_domains::remote_desktop::ReadOnlyError::*;
    match code {
        AuthorizationRequired => "device_approval_required",
        RelayUnavailable => "target_unavailable",
        AttachmentBusy => "attachment_busy",
        CleanupPending => "cleanup_pending",
        AttachIdConflict => "attach_id_conflict",
        StaleRevision => "stale_revision",
        StaleConnection => "stale_connection",
        NotAttachmentOwner => "not_attachment_owner",
        InvalidRequest => "invalid_request",
        RevisionExhausted => "revision_exhausted",
    }
}

fn error(code: &str) -> Value {
    json!({"error":{"code":code,"retryable":false}})
}
