//! Short-lived coturn REST credentials for an acknowledged device attachment.
//! Signing material stays in the Relay; no SDP, pixels or Agent state is stored.
use crate::routes::api::AppState;
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Clone)]
pub struct RemoteDesktopTurnConfig {
    urls: Vec<String>,
    secret: String,
}
impl std::fmt::Debug for RemoteDesktopTurnConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteDesktopTurnConfig")
            .field("urls", &self.urls)
            .field("secret", &"[redacted]")
            .finish()
    }
}
impl RemoteDesktopTurnConfig {
    pub fn new(urls: Vec<String>, secret: String) -> Result<Self, String> {
        if urls.is_empty() || urls.len() > 4 || urls.iter().any(|url| !valid_url(url)) {
            return Err(
                "TURN URLs must be explicit turn/turns authorities with optional UDP/TCP transport"
                    .into(),
            );
        }
        if !(32..=256).contains(&secret.len())
            || !secret.is_ascii()
            || secret.bytes().any(|b| b.is_ascii_whitespace())
        {
            return Err("TURN signing secret must be 32-256 non-whitespace ASCII bytes".into());
        }
        Ok(Self { urls, secret })
    }
    fn issue(
        &self,
        auth: &crate::db::AuthToken,
        target: &str,
        attach_id: &str,
        now: i64,
        valid_until: i64,
    ) -> Option<serde_json::Value> {
        // Repeated reads in one five-minute bucket return the same username,
        // rather than bypassing coturn per-user allocation quotas with every GET.
        // TTL is 5-10 minutes, also bounded by both original device credentials.
        let expiry = (now.checked_div(300)?.checked_add(2)?.checked_mul(300)?).min(valid_until);
        if now < 0 || expiry <= now {
            return None;
        }
        let principal =
            serde_json::to_vec(&[&auth.user_id, &auth.device_id, target, attach_id]).ok()?;
        let username = format!("{expiry}:rd:{:x}", Sha256::digest(principal));
        let mut hmac = Hmac::<sha1::Sha1>::new_from_slice(self.secret.as_bytes()).ok()?;
        hmac.update(username.as_bytes());
        let credential = STANDARD.encode(hmac.finalize().into_bytes());
        Some(
            serde_json::json!({"attach_id":attach_id,"target_device_id":target,"expires_at":expiry,
            "ice_servers":[{"urls":self.urls,"username":username,"credential":credential}]}),
        )
    }
}
fn valid_url(value: &str) -> bool {
    if value.len() > 1024 || value.chars().any(char::is_whitespace) {
        return false;
    }
    let Some((scheme, address)) = value.split_once(':') else {
        return false;
    };
    if !matches!(scheme, "turn" | "turns") {
        return false;
    }
    let (authority, transport) = address
        .split_once('?')
        .map_or((address, None), |(a, b)| (a, Some(b)));
    if transport.is_some_and(|value| !matches!(value, "transport=udp" | "transport=tcp"))
        || (scheme == "turns" && transport == Some("transport=udp"))
        || authority.is_empty()
        || authority.contains(['/', '@', '#', '?'])
    {
        return false;
    }
    reqwest::Url::parse(&format!("https://{authority}")).is_ok_and(|url| {
        url.host_str().is_some() && url.username().is_empty() && url.password().is_none()
    })
}
fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}
#[derive(Deserialize)]
struct Request {
    target_device_id: String,
    attach_id: String,
}
pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/api/remote-desktop/turn", get(credentials))
}
async fn credentials(
    State(state): State<AppState>,
    Query(request): Query<Request>,
    headers: HeaderMap,
) -> Response {
    let auth = match crate::routes::devices::validate_user(&state, &headers).await {
        Ok(auth) if auth.is_device_token() => auth,
        Ok(_) => return failure(StatusCode::FORBIDDEN, "forbidden"),
        Err(status) => return failure(status, "authorization_required"),
    };
    if !valid_id(&request.target_device_id) || !valid_id(&request.attach_id) {
        return failure(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let Some(config) = &state.remote_desktop_turn else {
        return failure(StatusCode::SERVICE_UNAVAILABLE, "turn_unavailable");
    };
    let expiry = match state
        .remote_desktop_associations
        .turn_authority(&state, &auth, &request.target_device_id, &request.attach_id)
        .await
    {
        Ok(expiry) => expiry,
        Err("authorization_unknown") => {
            return failure(StatusCode::SERVICE_UNAVAILABLE, "authorization_unknown")
        }
        Err(code) => return failure(StatusCode::FORBIDDEN, code),
    };
    let Some(payload) = config.issue(
        &auth,
        &request.target_device_id,
        &request.attach_id,
        chrono::Utc::now().timestamp(),
        expiry,
    ) else {
        return failure(StatusCode::FORBIDDEN, "authorization_expired");
    };
    // These credentials are allowed into the narrow media bridge; the Relay
    // signing secret and device/account tokens are never returned or logged.
    ([("cache-control", "no-store")], Json(payload)).into_response()
}
fn failure(status: StatusCode, code: &str) -> Response {
    (
        status,
        [("cache-control", "no-store")],
        Json(serde_json::json!({"error":{"code":code}})),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn turn_configuration_rejects_other_protocols_and_redacts_signing_material() {
        let secret = "test-secret-material-not-for-deployment".to_string();
        for url in [
            "https://host",
            "turn://host",
            "turn:user@host",
            "turn:host/path",
            "turn:host?other=value",
            "turns:host?transport=udp",
            "turn:host:99999",
        ] {
            assert!(RemoteDesktopTurnConfig::new(vec![url.into()], secret.clone()).is_err());
        }
        for url in [
            "turn:host:3478?transport=udp",
            "turn:host:3478?transport=tcp",
            "turns:host:5349?transport=tcp",
            "turn:[::1]:3478",
        ] {
            let config = RemoteDesktopTurnConfig::new(vec![url.into()], secret.clone()).unwrap();
            assert!(!format!("{config:?}").contains(&secret));
        }
    }
}
