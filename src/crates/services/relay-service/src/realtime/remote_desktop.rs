//! Dedicated, versioned signaling lane. Payloads remain opaque ciphertext;
//! registration never authorizes capture or input on the receiving host.
use super::*;
mod associations;
pub(crate) use associations::Associations;

const VERSION: u32 = 1;
const MAX_CIPHERTEXT_BYTES: usize = 128 * 1024;
const MAX_TIMEOUT_MS: u64 = 30_000;
// Reserve the bounded ciphertext reply as well as the pending request.
const RESPONSE_MEMORY_COST: u32 = (MAX_CIPHERTEXT_BYTES * 4 + 8 * 1024) as u32;

#[derive(Deserialize)]
struct Register {
    version: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Call {
    version: u32,
    target_device_id: String,
    /// The device encryption envelope, not a host operation or arbitrary RPC.
    params: Ciphertext,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    attach_id: Option<String>,
}

#[derive(Deserialize, serde::Serialize)]
struct Ciphertext {
    encrypted_data: String,
    nonce: String,
}

fn valid_ciphertext(value: &Ciphertext) -> bool {
    !value.encrypted_data.is_empty()
        && value.encrypted_data.len() <= MAX_CIPHERTEXT_BYTES
        && !value.nonce.is_empty()
        && value.nonce.len() <= 128
}

fn room(account: &str, device: &str) -> String {
    format!("rd:{account}:{device}:v1")
}

fn valid_device_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}

// Delegated tokens intentionally keep working on the old RPC path. v1 has no
// delegated-device trust contract, so they cannot use the remote desktop lane.
async fn authorized_device(state: &AppState, identity: &Identity) -> bool {
    matches!(AuthToken::find(&state.db, &identity.token).await,
        Ok(Some(auth)) if auth.is_device_token()
            && auth.user_id == identity.account && auth.device_id == identity.device)
}

async fn can_register_host(state: &AppState, identity: &Identity) -> bool {
    if identity.scope != Scope::Machine || !authorized_device(state, identity).await {
        return false;
    }
    match sqlx::query_scalar::<_, Option<String>>(
        "SELECT device_kind FROM devices WHERE user_id = ? AND device_id = ?",
    )
    .bind(&identity.account)
    .bind(&identity.device)
    .fetch_optional(&*state.db)
    .await
    {
        Ok(Some(kind)) => crate::db::device_kind_is_host(kind.as_deref()),
        _ => false,
    }
}

pub(super) fn install(socket: &SocketRef, state: &AppState, io: &SocketIo) {
    if state.remote_desktop_pairing.is_none() {
        for event in [
            "rd-register",
            "rd-unregister",
            "rd-call",
            "rd-notice-ack",
            "rd-end",
        ] {
            socket.on(event, |ack: AckSender| async move {
                let _ = ack.send(&failure("remote_desktop_service_required"));
            });
        }
        return;
    }
    let register_state = state.clone();
    socket.on(
        "rd-register",
        move |socket: SocketRef, TryData(data): TryData<Register>, ack: AckSender| {
            let state = register_state.clone();
            async move {
                let Some(identity) = socket.extensions.get::<Identity>() else {
                    return;
                };
                let Ok(data) = data else {
                    let _ = ack.send(&failure("invalid_request"));
                    return;
                };
                if data.version != VERSION {
                    let _ = ack.send(&failure("unsupported_protocol"));
                    return;
                }
                if !valid_device_id(&identity.device) || !can_register_host(&state, &identity).await
                {
                    let _ = ack.send(&failure("forbidden"));
                    return;
                }
                // Multiple reconnecting sockets may register. Dispatch requires
                // exactly one owner; ambiguous ownership is transient, not revoke.
                socket.join(room(&identity.account, &identity.device));
                let _ = ack.send(&json!({"ok":true,"version":VERSION}));
            }
        },
    );
    // Release only this socket's own registration, including after token expiry.
    let unregister_io = io.clone();
    socket.on("rd-unregister", move |socket: SocketRef, ack: AckSender| {
        let io = unregister_io.clone();
        async move {
            if let Some(identity) = socket.extensions.get::<Identity>() {
                identity
                    .remote_desktop_associations
                    .end_host(&io, socket.id, None)
                    .await;
                socket.leave(room(&identity.account, &identity.device));
                let _ = ack.send(&json!({"ok":true}));
            }
        }
    });
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct End {
        version: u32,
        attach_id: String,
    }
    let end_state = state.clone();
    let end_io = io.clone();
    socket.on(
        "rd-end",
        move |socket: SocketRef, TryData(data): TryData<End>, ack: AckSender| {
            let state = end_state.clone();
            let io = end_io.clone();
            async move {
                let Some(identity) = socket.extensions.get::<Identity>() else {
                    return;
                };
                let Ok(data) = data else {
                    let _ = ack.send(&failure("invalid_request"));
                    return;
                };
                if data.version != VERSION || !valid_device_id(&data.attach_id) {
                    let _ = ack.send(&failure("invalid_request"));
                    return;
                }
                if identity.scope != Scope::Machine || !authorized_device(&state, &identity).await {
                    let _ = ack.send(&failure("forbidden"));
                    return;
                }
                identity
                    .remote_desktop_associations
                    .end_host(&io, socket.id, Some(&data.attach_id))
                    .await;
                let _ = ack.send(&json!({"ok":true}));
            }
        },
    );
    let call_state = state.clone();
    let call_io = io.clone();
    socket.on(
        "rd-call",
        move |socket: SocketRef, TryData(data): TryData<Call>, ack: AckSender| {
            let state = call_state.clone();
            let io = call_io.clone();
            async move {
                let Some(identity) = socket.extensions.get::<Identity>() else {
                    return;
                };
                let Ok(data) = data else {
                    let _ = ack.send(&failure("invalid_request"));
                    return;
                };
                if data.version != VERSION {
                    let _ = ack.send(&failure("unsupported_protocol"));
                    return;
                }
                let timeout_ms = data.timeout_ms.unwrap_or(MAX_TIMEOUT_MS);
                if !valid_device_id(&data.target_device_id)
                    || data
                        .attach_id
                        .as_deref()
                        .is_some_and(|id| !valid_device_id(id))
                    || !valid_ciphertext(&data.params)
                    || !(1..=MAX_TIMEOUT_MS).contains(&timeout_ms)
                {
                    let _ = ack.send(&failure("invalid_request"));
                    return;
                }
                if !authorized_device(&state, &identity).await {
                    let _ = ack.send(&failure("forbidden"));
                    return;
                }
                let kind = sqlx::query_scalar::<_, Option<String>>(
                    "SELECT device_kind FROM devices WHERE user_id=? AND device_id=?",
                )
                .bind(&identity.account)
                .bind(&data.target_device_id)
                .fetch_optional(&*state.db)
                .await;
                if matches!(kind, Ok(Some(Some(ref kind))) if kind == "cli") {
                    let _ = ack.send(&failure("unsupported"));
                    return;
                }
                if kind.is_err() {
                    let _ = ack.send(&failure("authorization_unknown"));
                    return;
                }
                let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
                let reservation =
                    rpc_memory_cost(&json!(data.params)) as u32 + RESPONSE_MEMORY_COST;
                // Both sub-budgets and the existing total budgets apply. RAII
                // returns all permits on denial, timeout, cancellation or loss.
                let mut permits = Vec::new();
                for budget in [
                    &identity.remote_desktop_calls,
                    &identity.remote_desktop_server_calls,
                    &identity.account_calls,
                    &identity.server_calls,
                ] {
                    match budget.clone().try_acquire_many_owned(reservation) {
                        Ok(permit) => permits.push(permit),
                        Err(_) => {
                            let _ = ack.send(&failure("capacity_exceeded"));
                            return;
                        }
                    }
                }
                // No implicit reconnect retry and no general client-version
                // exception. Only this explicitly negotiated v1 lane is used.
                let targets = io
                    .within(room(&identity.account, &data.target_device_id))
                    .sockets();
                if targets.len() != 1 {
                    // Keep the compatible wire error; diagnose only the local
                    // routing fact, never identities or opaque request bodies.
                    tracing::debug!(
                        reason = if targets.is_empty() {
                            "host_registration_missing"
                        } else {
                            "host_registration_ambiguous"
                        },
                        "Remote desktop signaling target unavailable"
                    );
                    let _ = ack.send(&failure("target_unavailable"));
                    return;
                }
                let target = targets.into_iter().next().unwrap();
                if target.id == socket.id {
                    let _ = ack.send(&failure("forbidden"));
                    return;
                }
                let Some(target_identity) = target.extensions.get::<Identity>() else {
                    tracing::debug!(
                        reason = "host_identity_missing",
                        "Remote desktop signaling target unavailable"
                    );
                    let _ = ack.send(&failure("target_unavailable"));
                    return;
                };
                if target_identity.account != identity.account
                    || target_identity.device != data.target_device_id
                    || target_identity.scope != Scope::Machine
                    || !target.connected()
                    || !socket.connected()
                    || !authorized_device(&state, &identity).await
                    || !authorized_device(&state, &target_identity).await
                {
                    let _ = ack.send(&failure("authorization_expired"));
                    return;
                }
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                if remaining.is_zero() {
                    let _ = ack.send(&failure("deadline_elapsed"));
                    return;
                }
                let tracking = match data.attach_id.as_deref() {
                    Some(id) => match identity
                        .remote_desktop_associations
                        .begin(&state, &io, &socket, &target, id)
                        .await
                    {
                        Ok(tracking) => Some(tracking),
                        Err(error) => {
                            let _ = ack.send(&failure(error));
                            return;
                        }
                    },
                    None => None,
                };
                let mut request = json!({
                    "version":VERSION,"params":data.params,
                    "sourceDeviceId":identity.device,"timeoutMs":remaining.as_millis()
                });
                if let Some(id) = &data.attach_id {
                    request["attachId"] = json!(id);
                }
                if let Some(tracking) = &tracking {
                    request["credentialBinding"] = json!(tracking.credential_binding());
                }
                let response = match target
                    .timeout(remaining)
                    .emit_with_ack::<_, Value>("rd-request", &request)
                {
                    Ok(pending) => match pending.await {
                        Ok(value) => {
                            // An ACK from a socket whose identity was revoked
                            // while executing must not become a success result.
                            if !socket.connected()
                                || !target.connected()
                                || !authorized_device(&state, &identity).await
                                || !authorized_device(&state, &target_identity).await
                            {
                                failure("delivery_unknown")
                            } else if let Some(error) =
                                value.get("$relayError").and_then(Value::as_str)
                            {
                                if error == "target_unavailable" {
                                    tracing::debug!(
                                        reason = "host_registration_not_ready",
                                        "Remote desktop signaling target unavailable"
                                    );
                                }
                                failure(error)
                            } else {
                                let disposition =
                                    value.get("$rdAttachment").and_then(Value::as_str);
                                let result = serde_json::from_value::<Ciphertext>(value.clone());
                                match result {
                                    Ok(result) if valid_ciphertext(&result) => {
                                        let association = match (disposition, tracking.as_ref()) {
                                            (None, _) => Ok(()),
                                            (Some("accepted"), Some(tracking)) => {
                                                tracking
                                                    .accept(
                                                        &state,
                                                        &io,
                                                        deadline.saturating_duration_since(
                                                            tokio::time::Instant::now(),
                                                        ),
                                                    )
                                                    .await
                                            }
                                            (Some("ended"), Some(tracking)) => {
                                                tracking.end(&io).await;
                                                Ok(())
                                            }
                                            _ => Err("invalid_response"),
                                        };
                                        match association {
                                            Ok(())
                                                if socket.connected()
                                                    && target.connected()
                                                    && authorized_device(&state, &identity)
                                                        .await
                                                    && authorized_device(
                                                        &state,
                                                        &target_identity,
                                                    )
                                                    .await =>
                                            {
                                                json!({"ok":true,"result":result})
                                            }
                                            Ok(()) => failure("delivery_unknown"),
                                            Err(error) => failure(error),
                                        }
                                    }
                                    _ => failure("invalid_response"),
                                }
                            }
                        }
                        Err(_) => failure("delivery_unknown"),
                    },
                    Err(_) => {
                        tracing::debug!(
                            reason = "request_emit_failed",
                            "Remote desktop signaling target unavailable"
                        );
                        failure("target_unavailable")
                    }
                };
                let _ = ack.send(&response);
            }
        },
    );
}
