//! Desktop host lifecycle. Account transport remains in Remote Connect; pure
//! authorization decisions remain in product-domains. No Agent session is used.
pub(crate) mod connection;
#[cfg(feature = "remote-desktop-media")]
mod control_worker;
pub(crate) mod controller;
mod displays;
#[cfg(feature = "remote-desktop-media")]
mod native_input;
#[cfg(all(
    feature = "remote-desktop-media",
    any(target_os = "windows", target_os = "linux", test)
))]
mod raw_frame;
#[cfg(all(target_os = "macos", feature = "remote-desktop-media"))]
use macos_capture as capture;
#[cfg(all(not(target_os = "macos"), feature = "remote-desktop-media"))]
mod capture;
mod grants;
#[cfg(all(target_os = "linux", feature = "remote-desktop-media"))]
pub(crate) mod linux;
#[cfg(all(target_os = "macos", feature = "remote-desktop-media"))]
mod macos_capture;
#[cfg(all(target_os = "macos", feature = "remote-desktop-media"))]
mod macos_input;
#[cfg(feature = "remote-desktop-media")]
mod media;
#[cfg(feature = "remote-desktop-media")]
mod media_session;
#[cfg(all(test, feature = "remote-desktop-media"))]
mod native_channel_properties_tests;
#[cfg(feature = "remote-desktop-media")]
pub(crate) mod receiver;
mod requests;
#[cfg(target_os = "windows")]
pub(crate) mod windows;

use grants::GrantStore;
use openbitfun_product_domains::remote_desktop::{
    ControllerIdentity, ReadOnlyCommand, ReadOnlyHost, ReadOnlyRequest, ViewGrantFile,
};
use openbitfun_services_integrations::remote_connect::remote_desktop_device::{
    AttachmentDisposition, AttachmentReply,
};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Instant,
};

#[cfg(feature = "remote-desktop-media")]
#[derive(Clone)]
pub(crate) struct RelayContext {
    pub relay_url: String,
    pub session: openbitfun_services_integrations::remote_connect::account::AccountSession,
    pub host_device_id: String,
    pub service_connection_id: u64,
    pub capabilities: Vec<String>,
}

struct Host {
    account_generation: u64,
    policy: ReadOnlyHost,
    store: Option<GrantStore>,
    started: Instant,
    // Pinned before the first accepted attachment reply; retained through Relay
    // restarts and source suspension. Never persisted or exposed to a renderer.
    credential_binding: Option<String>,
    #[cfg(feature = "remote-desktop-media")]
    relay: Option<RelayContext>,
    #[cfg(feature = "remote-desktop-media")]
    failure: Option<(ControllerIdentity, &'static str)>,
}

#[derive(Default)]
pub(crate) struct RemoteDesktopState(
    Arc<Mutex<Option<Host>>>,
    #[cfg(feature = "remote-desktop-media")] media_session::Sessions,
);

impl RemoteDesktopState {
    pub(crate) fn connect(
        &self,
        generation: u64,
        account: &str,
        path: PathBuf,
    ) -> Result<(), String> {
        self.retire();
        let store = GrantStore::load(path);
        let (store, grants) = match store {
            Ok(store) => {
                let grants = store.snapshot();
                (Some(store), grants)
            }
            Err(error) => {
                log::warn!("Remote desktop local grants unavailable: {error}");
                (
                    None,
                    ViewGrantFile {
                        version: 0,
                        grants: Vec::new(),
                    },
                )
            }
        };
        let policy = ReadOnlyHost::new(account.into(), uuid::Uuid::new_v4().to_string(), grants)
            .map_err(|error| format!("Remote desktop host identity is invalid: {error:?}"))?;
        *self.0.lock().unwrap() = Some(Host {
            account_generation: generation,
            policy,
            store,
            started: Instant::now(),
            credential_binding: None,
            #[cfg(feature = "remote-desktop-media")]
            relay: None,
            #[cfg(feature = "remote-desktop-media")]
            failure: None,
        });
        Ok(())
    }

    /// Account replacement retires the host synchronously before any awaited IO.
    pub(crate) fn retire(&self) {
        #[cfg(feature = "remote-desktop-media")]
        self.1.cancel();
        self.0.lock().unwrap().take();
    }

    #[cfg(feature = "remote-desktop-media")]
    pub(crate) fn configure_relay(&self, generation: u64, context: RelayContext) {
        if let Some(host) = self.0.lock().unwrap().as_mut().filter(|host| {
            host.account_generation == generation
                && context.session.user_id == host.policy.account_id()
        }) {
            host.relay = Some(context);
        }
    }

    pub(crate) fn relay_lost(&self, generation: u64) {
        let mut owner = self.0.lock().unwrap();
        if let Some(host) = owner
            .as_mut()
            .filter(|host| host.account_generation == generation)
        {
            host.policy
                .relay_lost(host.started.elapsed().as_millis() as u64);
            #[cfg(feature = "remote-desktop-media")]
            self.1.lost();
        }
    }

    pub(crate) fn relay_notice(
        &self,
        generation: u64,
        socket_generation: u64,
        notice: &openbitfun_product_domains::remote_desktop::RelayNotice,
    ) -> bool {
        use openbitfun_product_domains::remote_desktop::RelayNoticeKind;
        let mut owner = self.0.lock().unwrap();
        let Some(host) = owner
            .as_mut()
            .filter(|host| host.account_generation == generation)
        else {
            return false;
        };
        if !crate::remote_desktop::connection::is_current(generation) {
            return false;
        }
        if !host.policy.matches_attachment(&notice.attach_id) {
            return notice.kind != RelayNoticeKind::Ready;
        }
        match notice.kind {
            // A ready notification alone never proves fixed-key media binding.
            // The native media provider must own that verified pending binding.
            RelayNoticeKind::Ready => {
                #[cfg(feature = "remote-desktop-media")]
                {
                    use openbitfun_product_domains::remote_desktop::ViewPhase;
                    if let Some(slot) = self.1.for_relay_notice(&notice.attach_id) {
                        let owns = host.policy.snapshot(slot.source()).is_ok_and(|snapshot| {
                            let cleaning = snapshot.cleanup_pending;
                            snapshot.attachment.is_some_and(|current| {
                                current.connection_id == slot.connection_id()
                                    && (slot.route_visible(Instant::now())
                                        || (cleaning && current.phase == ViewPhase::Suspended))
                            })
                        });
                        if owns {
                            match host
                                .policy
                                .relay_revalidated(host.started.elapsed().as_millis() as u64)
                            {
                                Ok(effects) if effects.is_empty() => {
                                    slot.ready(socket_generation);
                                    return true;
                                }
                                Ok(effects) => self.apply_media(effects),
                                Err(_) => self.1.cancel(),
                            }
                        }
                    }
                }
                let _ = socket_generation;
                false
            }
            RelayNoticeKind::Unknown => {
                host.policy
                    .relay_lost(host.started.elapsed().as_millis() as u64);
                #[cfg(feature = "remote-desktop-media")]
                if let Some(slot) = self.1.for_attachment(&notice.attach_id) {
                    slot.lost();
                }
                true
            }
            RelayNoticeKind::Revoked | RelayNoticeKind::Ended => match host.policy.stop() {
                Ok(effects) => {
                    self.apply_media(effects);
                    true
                }
                Err(_) => {
                    #[cfg(feature = "remote-desktop-media")]
                    self.1.cancel();
                    false
                }
            },
        }
    }

    pub(crate) fn local_settings(&self, generation: u64, account: &str) -> Result<Value, String> {
        let availability = self.availability(generation);
        let owner = self.0.lock().unwrap();
        let host = owner
            .as_ref()
            .filter(|host| host.account_generation == generation)
            .ok_or("Remote desktop host is not connected")?;
        let displays = displays::list().map_err(|error| error.to_string())?;
        let grants: Vec<_> = host
            .policy
            .local_view_grants()
            .grants
            .iter()
            .filter(|grant| grant.account_id == account)
            .cloned()
            .collect();
        Ok(
            json!({"displays":displays, "grants":grants, "storage_available":host.store.is_some(),
            "control_grant_supported":cfg!(feature = "remote-desktop-media"), "control_available":Self::control_available(),
            "availability":availability, "state_revision":host.policy.revision()}),
        )
    }

    fn control_available() -> bool {
        #[cfg(feature = "remote-desktop-media")]
        {
            return control_worker::CONTROL_AVAILABLE && native_input::available();
        }
        #[cfg(not(feature = "remote-desktop-media"))]
        {
            false
        }
    }

    pub(crate) fn validate_display_scope(scope: &[String]) -> Result<(), String> {
        let displays = displays::list().map_err(|error| error.to_string())?;
        if scope.is_empty()
            || scope.len() > displays.len()
            || scope
                .iter()
                .any(|id| !displays.iter().any(|display| display.display_id == *id))
        {
            return Err("Choose an available display explicitly".into());
        }
        let distinct: std::collections::HashSet<_> = scope.iter().collect();
        if distinct.len() != scope.len() {
            return Err("Duplicate display scope".into());
        }
        Ok(())
    }

    pub(crate) fn approve(
        &self,
        generation: u64,
        grant: openbitfun_product_domains::remote_desktop::ViewGrant,
    ) -> Result<(), String> {
        Self::validate_display_scope(&grant.display_ids)?;
        if grant
            .control_display_ids
            .iter()
            .any(|id| !grant.display_ids.contains(id))
        {
            return Err("Control scope must be contained in the approved viewing scope".into());
        }
        let mut owner = self.0.lock().unwrap();
        let host = owner
            .as_mut()
            .filter(|host| host.account_generation == generation)
            .ok_or("Remote desktop host is not connected")?;
        let store = host
            .store
            .as_mut()
            .ok_or("Grant file is unavailable; existing data was retained")?;
        let grants = store.approve(grant).map_err(|error| error.to_string())?;
        let effects = host
            .policy
            .replace_grants(grants)
            .map_err(|error| format!("{error:?}"))?;
        self.apply_media(effects);
        Ok(())
    }

    pub(crate) fn revoke(
        &self,
        generation: u64,
        account: &str,
        device: &str,
    ) -> Result<(), String> {
        let mut owner = self.0.lock().unwrap();
        let host = owner
            .as_mut()
            .filter(|host| host.account_generation == generation)
            .ok_or("Remote desktop host is not connected")?;
        // Revocation takes effect in memory first, even if disk persistence fails.
        #[cfg(feature = "remote-desktop-media")]
        self.1.cancel_device(account, device);
        let mut grants = host.policy.local_view_grants().clone();
        grants
            .grants
            .retain(|grant| !(grant.account_id == account && grant.device_id == device));
        let effects = host
            .policy
            .replace_grants(grants)
            .map_err(|error| format!("{error:?}"))?;
        self.apply_media(effects);
        let store = host
            .store
            .as_mut()
            .ok_or("Grant revoked for this runtime, but the grant file is unavailable")?;
        if let Err(error) = store.revoke(account, device) {
            // Never let a later approval re-import the revoked disk snapshot.
            host.store = None;
            return Err(format!(
                "Grant revoked for this runtime, but could not be saved: {error}"
            ));
        }
        Ok(())
    }

    pub(crate) fn stop(&self, generation: u64) -> Result<(), String> {
        let mut owner = self.0.lock().unwrap();
        let host = owner
            .as_mut()
            .filter(|host| host.account_generation == generation)
            .ok_or("Remote desktop host is not connected")?;
        #[cfg(feature = "remote-desktop-media")]
        self.1.cancel();
        let effects = host.policy.stop().map_err(|error| format!("{error:?}"))?;
        self.apply_media(effects);
        Ok(())
    }

    fn apply_media(&self, effects: Vec<openbitfun_product_domains::remote_desktop::MediaEffect>) {
        #[cfg(feature = "remote-desktop-media")]
        self.1.apply(effects);
        #[cfg(not(feature = "remote-desktop-media"))]
        let _ = effects;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_product_domains::remote_desktop::ViewGrant;

    #[test]
    fn local_stop_is_generation_scoped_without_network_or_account_mutation() {
        use openbitfun_product_domains::remote_desktop::AttachRequest;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("grants.json");
        let source = ControllerIdentity {
            account_id: "account".into(),
            device_id: "phone".into(),
            public_key_fingerprint: "a".repeat(64),
        };
        let grants = ViewGrantFile {
            version: 1,
            grants: vec![ViewGrant {
                account_id: source.account_id.clone(),
                device_id: source.device_id.clone(),
                public_key_fingerprint: source.public_key_fingerprint.clone(),
                display_ids: vec!["screen".into()],
                control_display_ids: Vec::new(),
            }],
        };
        std::fs::write(&path, serde_json::to_vec(&grants).unwrap()).unwrap();
        let state = RemoteDesktopState::default();
        for (generation, attach_id, connection_id) in [(41, "old", "pc-old"), (42, "new", "pc-new")]
        {
            state.connect(generation, "account", path.clone()).unwrap();
            {
                let mut owner = state.0.lock().unwrap();
                let policy = &mut owner.as_mut().unwrap().policy;
                policy
                    .attach(
                        &source,
                        &AttachRequest {
                            attach_id: attach_id.into(),
                            expected_state_revision: policy.revision(),
                            display_id: "screen".into(),
                            force_relay: false,
                        },
                        connection_id,
                    )
                    .unwrap();
                policy.bound(&source, connection_id).unwrap();
            }
            assert!(state.stop(generation - 1).is_err());
            assert!(state
                .0
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .policy
                .snapshot(&source)
                .unwrap()
                .attachment
                .is_some());
            state.stop(generation).unwrap();
            assert!(state
                .0
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .policy
                .snapshot(&source)
                .unwrap()
                .attachment
                .is_none());
        }
        assert_eq!(
            serde_json::from_slice::<ViewGrantFile>(&std::fs::read(path).unwrap()).unwrap(),
            grants
        );
    }

    #[test]
    fn remote_desktop_failed_revoke_cannot_be_reimported_by_a_later_approval() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("grants.json");
        let grant = ViewGrant {
            account_id: "account".into(),
            device_id: "phone".into(),
            public_key_fingerprint: "a".repeat(64),
            display_ids: vec!["screen".into()],
            control_display_ids: Vec::new(),
        };
        std::fs::write(
            &path,
            serde_json::to_vec(&ViewGrantFile {
                version: 1,
                grants: vec![grant.clone()],
            })
            .unwrap(),
        )
        .unwrap();
        let generation = crate::remote_desktop::connection::generation();
        let state = RemoteDesktopState::default();
        state.connect(generation, "account", path.clone()).unwrap();
        let source = ControllerIdentity {
            account_id: grant.account_id.clone(),
            device_id: grant.device_id.clone(),
            public_key_fingerprint: grant.public_key_fingerprint.clone(),
        };
        assert!(state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .policy
            .allows(&source, "screen"));
        std::fs::write(&path, b"external data").unwrap();
        assert!(state.revoke(generation, "account", "phone").is_err());
        let owner = state.0.lock().unwrap();
        let host = owner.as_ref().unwrap();
        assert!(!host.policy.allows(&source, "screen"));
        assert!(host.store.is_none());
        assert!(host.policy.local_view_grants().grants.is_empty());
        assert_eq!(std::fs::read(path).unwrap(), b"external data");
    }
    #[test]
    fn remote_desktop_relay_notice_never_grants_media_and_stops_only_its_attachment() {
        use openbitfun_product_domains::remote_desktop::{
            AttachRequest, RelayNotice, RelayNoticeKind,
        };
        let generation = crate::remote_desktop::connection::generation();
        let source = ControllerIdentity {
            account_id: "account".into(),
            device_id: "phone".into(),
            public_key_fingerprint: "a".repeat(64),
        };
        let mut policy = ReadOnlyHost::new(
            "account".into(),
            "boot".into(),
            ViewGrantFile {
                version: 1,
                grants: vec![ViewGrant {
                    account_id: source.account_id.clone(),
                    device_id: source.device_id.clone(),
                    public_key_fingerprint: source.public_key_fingerprint.clone(),
                    display_ids: vec!["screen".into()],
                    control_display_ids: Vec::new(),
                }],
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
        policy.bound(&source, "pc").unwrap();
        let state = RemoteDesktopState::default();
        *state.0.lock().unwrap() = Some(Host {
            account_generation: generation,
            policy,
            store: None,
            started: Instant::now(),
            credential_binding: Some("a".repeat(64)),
            #[cfg(feature = "remote-desktop-media")]
            relay: None,
            #[cfg(feature = "remote-desktop-media")]
            failure: None,
        });
        let notice = |attach: &str, kind| RelayNotice {
            version: 1,
            attach_id: attach.into(),
            kind,
        };
        assert!(!state.relay_notice(generation, 1, &notice("a", RelayNoticeKind::Ready)));
        assert!(state.relay_notice(generation, 1, &notice("old", RelayNoticeKind::Revoked)));
        assert!(state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .policy
            .may_send_frame(&source, "pc", 0));
        assert!(state.relay_notice(generation, 1, &notice("a", RelayNoticeKind::Unknown)));
        assert!(!state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .policy
            .may_send_frame(&source, "pc", 30_100));
        assert!(state.relay_notice(generation, 1, &notice("a", RelayNoticeKind::Revoked)));
        assert!(!state
            .0
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .policy
            .may_send_frame(&source, "pc", 1));
        assert!(!state.relay_notice(generation, 1, &notice("a", RelayNoticeKind::Ready)));
    }
}
