//! Local desktop trust and controller commands. Never proxied through a peer.
use crate::remote_desktop::{connection, controller, RemoteDesktopState};
use openbitfun_product_domains::remote_desktop::ViewGrant;
use openbitfun_services_integrations::remote_connect::{
    account::AccountClient, remote_desktop_device::public_key_fingerprint,
};
use serde::Deserialize;
use serde_json::Value;
use tauri::{Manager, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

fn require_local_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Remote desktop requires the local main window".into());
    }
    let url = window.url().map_err(|error| error.to_string())?;
    if !window
        .state::<std::sync::Arc<crate::frontend_workbench::FrontendWorkbenchManager>>()
        .is_current_main_document(&url)
    {
        return Err("Remote desktop requires the current local product document".into());
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct EmptyRequest {}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ReceiverRequest {
    Backend,
    Open {
        renderer_id: String,
        config: Value,
        events: tauri::ipc::JavaScriptChannelId,
    },
    Send {
        renderer_id: String,
        body: String,
    },
    Stats {
        renderer_id: String,
    },
    FrameAck {
        renderer_id: String,
        sequence: String,
    },
    Close {
        renderer_id: String,
    },
}

#[tauri::command]
pub async fn remote_desktop_receiver(
    window: WebviewWindow,
    request: ReceiverRequest,
) -> Result<Value, String> {
    require_local_main(&window)?;
    if matches!(request, ReceiverRequest::Backend) {
        return Ok(serde_json::json!({"backend":if cfg!(target_os="linux") {
            if cfg!(feature="remote-desktop-media") {"native"} else {"unsupported"}
        } else {"web"}}));
    }
    #[cfg(feature = "remote-desktop-media")]
    {
        use crate::remote_desktop::receiver;
        let result = match request {
            ReceiverRequest::Open {
                renderer_id,
                config,
                events,
            } => {
                receiver::open(
                    connection::snapshot()?.generation,
                    renderer_id,
                    serde_json::from_value(config).map_err(|_| "invalid_request")?,
                    events.channel_on(window.as_ref().clone()),
                )
                .await
            }
            ReceiverRequest::Send { renderer_id, body } => {
                receiver::send(&renderer_id, &body).map(|_| Value::Null)
            }
            ReceiverRequest::Stats { renderer_id } => receiver::stats(&renderer_id).await,
            ReceiverRequest::FrameAck {
                renderer_id,
                sequence,
            } => receiver::acknowledge(&renderer_id, &sequence).map(|_| Value::Null),
            ReceiverRequest::Close { renderer_id } => {
                receiver::close(&renderer_id);
                Ok(Value::Null)
            }
            ReceiverRequest::Backend => unreachable!(),
        };
        require_local_main(&window)?;
        result
    }
    #[cfg(not(feature = "remote-desktop-media"))]
    Err("media_backend_unavailable".into())
}

#[derive(Deserialize)]
pub struct ServiceConnectRequest {
    pub service_url: String,
    pub pairing_key: Option<String>,
    pub device_name: String,
}

#[tauri::command]
pub async fn remote_desktop_service_connect(
    window: WebviewWindow,
    request: ServiceConnectRequest,
) -> Result<connection::ServiceStatus, String> {
    require_local_main(&window)?;
    let result = connection::connect(
        window.app_handle(),
        &request.service_url,
        request.pairing_key.as_deref(),
        &request.device_name,
    )
    .await;
    require_local_main(&window)?;
    result
}

#[tauri::command]
pub async fn remote_desktop_service_status(
    window: WebviewWindow,
    request: EmptyRequest,
) -> Result<connection::ServiceStatus, String> {
    let _ = request;
    require_local_main(&window)?;
    connection::status_for_app(window.app_handle())
}

#[tauri::command]
pub async fn remote_desktop_service_disconnect(
    window: WebviewWindow,
    request: EmptyRequest,
) -> Result<(), String> {
    let _ = request;
    require_local_main(&window)?;
    connection::disconnect(window.app_handle()).await
}

#[tauri::command]
pub async fn remote_desktop_service_devices(
    window: WebviewWindow,
    request: EmptyRequest,
) -> Result<Value, String> {
    let _ = request;
    require_local_main(&window)?;
    let current = connection::snapshot()?;
    let devices = AccountClient::new()
        .list_devices(&current.relay, &current.session)
        .await
        .map_err(|_| "remote_desktop_directory_unavailable")?;
    require_local_main(&window)?;
    if !connection::is_current(current.generation) {
        return Err("remote_desktop_connection_changed".into());
    }
    serde_json::to_value(devices).map_err(|_| "remote_desktop_directory_unavailable".into())
}

/// Signaling originates on this controller even when its workspace is remote.
/// This API has no grant/OS-consent operations and never proxies via a peer.
#[tauri::command]
pub async fn remote_desktop_request(
    window: WebviewWindow,
    request: controller::ControllerRequest,
) -> Result<controller::ControllerReply, String> {
    require_local_main(&window)?;
    let result = controller::perform_remote_desktop_request(request).await;
    require_local_main(&window)?;
    result
}

#[tauri::command]
pub async fn remote_desktop_turn(
    window: WebviewWindow,
    request: controller::ControllerTurnRequest,
) -> Result<
    openbitfun_services_integrations::remote_connect::remote_desktop_device::TurnCredentials,
    String,
> {
    require_local_main(&window)?;
    let result = controller::perform_remote_desktop_turn(request).await;
    require_local_main(&window)?;
    result
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureConsentAction {
    Request,
    OpenSettings,
}

#[derive(Deserialize)]
pub struct CaptureConsentRequest {
    pub action: CaptureConsentAction,
}

/// OS consent belongs to this computer, even when the shell displays a peer.
/// This command does not create a device grant or start sharing. Interactive
/// pickers temporarily reserve the existing local confirmation boundary.
#[tauri::command]
pub async fn remote_desktop_capture_consent(
    window: WebviewWindow,
    request: CaptureConsentRequest,
) -> Result<Value, String> {
    require_local_main(&window)?;
    #[cfg(all(target_os = "macos", feature = "remote-desktop-media"))]
    {
        use openbitfun_agent_tools::computer_use_permissions::ComputerPermissionKind;
        let result = match request.action {
            CaptureConsentAction::Request => serde_json::to_value(
                crate::computer_use::permissions::request(ComputerPermissionKind::ScreenRecording)
                    .await?,
            )
            .map_err(|error| error.to_string())?,
            CaptureConsentAction::OpenSettings => {
                crate::api::computer_use_api::computer_use_open_system_settings(
                    crate::api::computer_use_api::ComputerUseOpenSettingsRequest {
                        pane: "screen_recording".into(),
                    },
                )
                .await?;
                serde_json::json!({"settings_opened":true})
            }
        };
        require_local_main(&window)?;
        Ok(result)
    }
    #[cfg(all(target_os = "linux", feature = "remote-desktop-media"))]
    {
        let _ = request.action;
        if crate::remote_desktop::linux::wayland() {
            // The local picker must not be driven by an AI or another remote
            // input owner. Reuse the existing confirmation reservation.
            let confirmation = LocalConfirmationGuard::acquire()?;
            crate::remote_desktop::linux::authorize().await?;
            require_local_main(&window)?;
            confirmation.finish()?;
        }
        require_local_main(&window)?;
        Ok(serde_json::json!({"availability":crate::remote_desktop::linux::availability()}))
    }
    #[cfg(all(target_os = "windows", feature = "remote-desktop-media"))]
    {
        let _ = request.action;
        Ok(serde_json::json!({"availability":crate::remote_desktop::windows::availability()}))
    }
    #[cfg(not(feature = "remote-desktop-media"))]
    {
        let _ = request.action;
        Err("media_backend_unavailable".into())
    }
}

#[tauri::command]
pub async fn remote_desktop_local_settings(
    window: WebviewWindow,
    request: EmptyRequest,
) -> Result<Value, String> {
    let _ = request;
    require_local_main(&window)?;
    let generation = connection::generation();
    let (session, relay_url) = connection::read_context_for_generation(generation).await?;
    let directory = AccountClient::new()
        .remote_desktop_controller_directory(&relay_url, &session)
        .await;
    // Do not hold account mutation admission across network IO. Recheck after
    // it, and retain local stop/revoke even if the directory is unavailable.
    let _operation = connection::lock_operation(generation).await?;
    require_local_main(&window)?;
    let mut settings = window
        .state::<RemoteDesktopState>()
        .local_settings(generation, &session.user_id)?;
    use openbitfun_services_integrations::remote_connect::account::RemoteDesktopControllerDirectory;
    let (state, devices) = match directory {
        Ok(RemoteDesktopControllerDirectory::Ready(devices)) => ("ready", devices),
        Ok(RemoteDesktopControllerDirectory::Unsupported) => ("unsupported", Vec::new()),
        Err(_) => ("unavailable", Vec::new()),
    };
    settings["controller_directory_state"] = Value::String(state.into());
    settings["controller_devices"] =
        serde_json::to_value(devices).map_err(|_| "Controller directory serialization failed")?;
    Ok(settings)
}

#[derive(Deserialize)]
pub struct ApproveRequest {
    pub device_id: String,
    pub display_ids: Vec<String>,
}

#[tauri::command]
pub async fn remote_desktop_approve_view(
    window: WebviewWindow,
    request: ApproveRequest,
) -> Result<(), String> {
    approve_device(window, request, ApprovalScope::View).await
}

/// Separate local operation: an old viewing request cannot gain input through
/// an extra payload field. Saving this scope does not open a control lease.
#[tauri::command]
pub async fn remote_desktop_approve_control(
    window: WebviewWindow,
    request: ApproveRequest,
) -> Result<(), String> {
    approve_device(window, request, ApprovalScope::Control).await
}

#[derive(Clone, Copy)]
enum ApprovalScope {
    View,
    Control,
}

/// Owns no input or worker. Its private ticket prevents AI/remote software from
/// driving the confirmation dialog; physical local input remains available.
struct LocalConfirmationGuard(
    Option<crate::computer_use::control_session::ExternalReservationToken>,
);
impl LocalConfirmationGuard {
    fn acquire() -> Result<Self, String> {
        crate::computer_use::control_session::reserve_external_control()
            .map(|ticket| Self(Some(ticket)))
    }
    fn finish(mut self) -> Result<(), String> {
        let ticket = self
            .0
            .take()
            .ok_or("Local confirmation reservation is unavailable")?;
        if crate::computer_use::control_session::release_external_control(ticket, || Ok(()))? {
            Ok(())
        } else {
            Err("Local confirmation reservation was invalidated".into())
        }
    }
}
impl Drop for LocalConfirmationGuard {
    fn drop(&mut self) {
        // This guard creates no input or worker. Early return/cancellation can
        // therefore drain it without injecting any cleanup events.
        let Some(ticket) = self.0.take() else {
            return;
        };
        if let Err(error) =
            crate::computer_use::control_session::release_external_control(ticket, || Ok(()))
        {
            log::error!("Local remote desktop confirmation cleanup failed: {error}");
        }
    }
}

async fn approve_device(
    window: WebviewWindow,
    request: ApproveRequest,
    scope: ApprovalScope,
) -> Result<(), String> {
    require_local_main(&window)?;
    let generation = connection::generation();
    let (session, relay_url) = connection::read_context_for_generation(generation).await?;
    RemoteDesktopState::validate_display_scope(&request.display_ids)?;
    let key = AccountClient::new()
        .device_public_key(&relay_url, &session, &request.device_id)
        .await
        .map_err(|error| error.to_string())?;
    openbitfun_services_integrations::remote_connect::device_crypto::derive_message_key(
        &session.master_key,
        &key,
    )
    .map_err(|_| "Device public key is invalid".to_string())?;
    let fingerprint = public_key_fingerprint(&key);
    if !connection::is_current(generation) {
        return Err("Account changed".into());
    }
    require_local_main(&window)?;
    let confirmation = LocalConfirmationGuard::acquire()?;
    // A native OS dialog is outside the remote command/permission mailbox. No
    // web message or a successful Relay request can grant screen access.
    let (sent, received) = tokio::sync::oneshot::channel();
    let (question, explanation) = match scope {
        ApprovalScope::View => ("Allow this device to view the selected displays?", "This saves a view-only grant and removes any previous input permission for this device on this computer."),
        ApprovalScope::Control => ("Allow this device to view and operate the selected displays?", "This saves viewing and keyboard/mouse permission on this computer. It does not start sharing or acquire an input lease."),
    };
    window
        .dialog()
        .message(format!(
            "{question}\n\nDevice: {}\nKey: {}\nDisplays: {}\n\n{explanation}",
            request.device_id,
            fingerprint,
            request.display_ids.join(", ")
        ))
        .title("Remote desktop authorization")
        .parent(&window)
        .buttons(MessageDialogButtons::OkCancel)
        .show(move |allowed| {
            let _ = sent.send(allowed);
        });
    if !received.await.map_err(|_| "Local confirmation closed")? {
        return Err("Local authorization cancelled".into());
    }
    require_local_main(&window)?;
    let _operation = connection::lock_operation(generation).await?;
    // The directory key may have changed while the human read the dialog.
    let current = AccountClient::new()
        .device_public_key(&relay_url, &session, &request.device_id)
        .await
        .map_err(|error| error.to_string())?;
    if current != key || !connection::is_current(generation) {
        return Err("Device identity changed; confirm the new identity".into());
    }
    let control_display_ids = match scope {
        ApprovalScope::View => Vec::new(),
        ApprovalScope::Control => request.display_ids.clone(),
    };
    window.state::<RemoteDesktopState>().approve(
        generation,
        ViewGrant {
            account_id: session.user_id,
            device_id: request.device_id,
            public_key_fingerprint: fingerprint,
            display_ids: request.display_ids,
            control_display_ids,
        },
    )?;
    confirmation.finish()
}

#[derive(Deserialize)]
pub struct RevokeRequest {
    pub device_id: String,
}

#[tauri::command]
pub async fn remote_desktop_revoke_view(
    window: WebviewWindow,
    request: RevokeRequest,
) -> Result<(), String> {
    require_local_main(&window)?;
    let generation = connection::generation();
    let _operation = connection::lock_operation(generation).await?;
    let (session, _) = connection::read_context_for_generation(generation).await?;
    window
        .state::<RemoteDesktopState>()
        .revoke(generation, &session.user_id, &request.device_id)
}

#[tauri::command]
pub async fn remote_desktop_local_stop(
    window: WebviewWindow,
    request: EmptyRequest,
) -> Result<(), String> {
    let _ = request;
    require_local_main(&window)?;
    let generation = connection::generation();
    // Stopping only removes this host generation's authority under its owner
    // lock. Never wait behind account operations that can be doing network IO.
    window.state::<RemoteDesktopState>().stop(generation)?;
    #[cfg(all(target_os = "linux", feature = "remote-desktop-media"))]
    crate::remote_desktop::linux::revoke().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_confirmation_guard_blocks_other_tickets_and_releases_on_cancel_or_finish() {
        use crate::computer_use::control_session;
        let old = control_session::reserve_external_control().unwrap();
        assert!(control_session::release_external_control(old, || Ok(())).unwrap());
        let confirmation = LocalConfirmationGuard::acquire().unwrap();
        assert!(control_session::reserve_external_control().is_err());
        assert!(control_session::with_external_control(old, || panic!(
            "old input reached a local confirmation"
        ))
        .is_err());
        // Cancel/early error runs Drop. This fixture never opens a dialog or
        // gives its own confirmation ticket to a native input provider.
        drop(confirmation);
        let next = LocalConfirmationGuard::acquire().unwrap();
        next.finish().unwrap();
        LocalConfirmationGuard::acquire().unwrap().finish().unwrap();
    }
}
