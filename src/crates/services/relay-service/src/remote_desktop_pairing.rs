//! Self-hosted desktop service bootstrap. No OpenBitFun account login or
//! identity-provider credential participates in device pairing.
use crate::{db, routes::api::AppState};
use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    Json,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;

const PRINCIPAL: &str = "remote-desktop-self-hosted";
const PAIRING_CONTEXT: &[u8] = b"OpenBitFun remote desktop pairing v1";

/// Refuse switching an existing database between account login and device
/// pairing. Keep every record intact and require a separate deployment path.
pub async fn validate_remote_desktop_database(
    pool: &db::DbPool,
    paired: bool,
) -> anyhow::Result<()> {
    let incompatible: i64 = sqlx::query_scalar(if paired {
        "SELECT COUNT(*) FROM users WHERE user_id != 'remote-desktop-self-hosted'"
    } else {
        "SELECT COUNT(*) FROM users WHERE user_id = 'remote-desktop-self-hosted'"
    })
    .fetch_one(pool)
    .await?;
    anyhow::ensure!(incompatible == 0, "Account Relay and remote desktop service require separate databases; existing records were retained");
    Ok(())
}

/// A deployment-scoped enrollment key, distinct from device access tokens.
/// Only its authentication tag is retained; Debug never exposes key material.
#[derive(Clone)]
pub struct RemoteDesktopPairingConfig {
    tag: [u8; 32],
}

impl std::fmt::Debug for RemoteDesktopPairingConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteDesktopPairingConfig")
            .finish_non_exhaustive()
    }
}

impl RemoteDesktopPairingConfig {
    pub fn new(key: &str) -> Result<Self, String> {
        if !(32..=256).contains(&key.len())
            || !key.is_ascii()
            || key.bytes().any(|b| b.is_ascii_whitespace())
        {
            return Err(
                "Remote desktop pairing key must be 32-256 non-whitespace ASCII bytes".into(),
            );
        }
        let mut mac =
            Hmac::<Sha256>::new_from_slice(key.as_bytes()).map_err(|_| "Invalid pairing key")?;
        mac.update(PAIRING_CONTEXT);
        Ok(Self {
            tag: mac.finalize().into_bytes().into(),
        })
    }

    fn accepts(&self, key: &str) -> bool {
        if key.len() > 256 {
            return false;
        }
        let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(key.as_bytes()) else {
            return false;
        };
        mac.update(PAIRING_CONTEXT);
        mac.verify_slice(&self.tag).is_ok()
    }
}

#[derive(Deserialize)]
pub(crate) struct PairRequest {
    device_id: String,
    device_name: String,
    device_kind: String,
    public_key: String,
    request_id: String,
}

/// Enrollment grants directory/signaling access only. The controlled computer
/// still has to approve this exact device key and display scope locally.
pub(crate) async fn pair(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<PairRequest>,
) -> Result<Json<Value>, StatusCode> {
    let config = state
        .remote_desktop_pairing
        .as_ref()
        .ok_or(StatusCode::NOT_FOUND)?;
    let key = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if !config.accepts(key) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let public_key = STANDARD
        .decode(&request.public_key)
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    if request.device_id.is_empty()
        || request.device_id.len() > 128
        || !request
            .device_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        || request.device_name.trim().is_empty()
        || request.device_name.len() > 256
        || request.device_name.chars().any(char::is_control)
        || !matches!(request.device_kind.as_str(), "desktop" | "mobile")
        || public_key.len() != 32
        || public_key.iter().all(|b| *b == 0)
        || uuid::Uuid::parse_str(&request.request_id).is_err()
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    db::UserRow::upsert_verified(&state.db, PRINCIPAL, PRINCIPAL)
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let canonical_key = STANDARD.encode(public_key);
    let existing: Option<(Option<String>,)> =
        sqlx::query_as("SELECT public_key FROM devices WHERE user_id = ? AND device_id = ?")
            .bind(PRINCIPAL)
            .bind(&request.device_id)
            .fetch_optional(state.db.as_ref())
            .await
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let issued = if let Some((key,)) = existing {
        // Re-enrollment renews credentials only for the same persisted key.
        // A reinstalled/new-key device still needs a separate ID and local grant.
        // Keep original metadata; names never identify an authorized device.
        if key.as_deref() != Some(&canonical_key) {
            return Err(StatusCode::CONFLICT);
        }
        let previous: Option<String> =
            sqlx::query_scalar("SELECT token FROM auth_tokens WHERE request_id = ?")
                .bind(&request.request_id)
                .fetch_optional(state.db.as_ref())
                .await
                .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        if let Some(previous) = previous {
            let _ = db::AuthToken::find(&state.db, &previous)
                .await
                .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        }
        db::AuthToken::create_idempotent(
            &state.db,
            PRINCIPAL,
            &request.device_id,
            &request.request_id,
        )
        .await
        .map_err(|_| StatusCode::CONFLICT)?
    } else {
        db::AuthToken::provision_new_device(
            &state.db,
            PRINCIPAL,
            &request.device_id,
            &request.device_name,
            Some(&request.device_kind),
            &request.request_id,
            &canonical_key,
            &db::DeviceMetadata::default(),
        )
        .await
        .map_err(|_| StatusCode::CONFLICT)?
        .ok_or(StatusCode::CONFLICT)?
    };
    Ok(Json(json!({"token":issued.token,"user_id":issued.user_id,
        "device_id":issued.device_id,"expires_at":issued.expires_at})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{MemoryAssetStore, RelayRuntimeOptions};
    use axum::{
        body::{to_bytes, Body},
        http::Request,
    };
    use std::sync::Arc;
    use tower::ServiceExt;

    const KEY: &str = "fixture-only-independent-pairing-key-1234";
    fn options() -> RelayRuntimeOptions {
        RelayRuntimeOptions {
            remote_desktop_pairing: Some(RemoteDesktopPairingConfig::new(KEY).unwrap()),
            ..Default::default()
        }
    }
    fn router(db: Arc<db::DbPool>, options: RelayRuntimeOptions) -> axum::Router {
        crate::build_relay_router_with_options(
            Arc::new(MemoryAssetStore::new()),
            std::time::Instant::now(),
            db,
            "test",
            options,
        )
    }
    async fn json(response: axum::response::Response) -> Value {
        serde_json::from_slice(&to_bytes(response.into_body(), 64 * 1024).await.unwrap()).unwrap()
    }
    fn request(key: &str, body: &Value) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri("/api/remote-desktop/pair")
            .header(header::AUTHORIZATION, format!("Bearer {key}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }
    fn device() -> Value {
        json!({"device_id":"independent-pc", "device_name":"My PC", "device_kind":"desktop",
            "public_key":STANDARD.encode([7;32]), "request_id":uuid::Uuid::new_v4().to_string()})
    }

    #[tokio::test]
    async fn login_relay_has_no_desktop_capability_or_enrollment_even_with_turn_config() {
        let db = Arc::new(db::connect(":memory:").await.unwrap());
        let app = router(
            db,
            RelayRuntimeOptions {
                remote_desktop_turn: Some(
                    crate::RemoteDesktopTurnConfig::new(
                        vec!["turn:example.test:3478".into()],
                        KEY.into(),
                    )
                    .unwrap(),
                ),
                ..Default::default()
            },
        );
        let info = json(
            app.clone()
                .oneshot(
                    Request::builder()
                        .uri("/api/info")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap(),
        )
        .await;
        assert!(info["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| !v.as_str().unwrap().starts_with("remote_desktop_")));
        for path in [
            "/api/remote-desktop/pair",
            "/api/remote-desktop/controllers",
            "/api/remote-desktop/turn",
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(path)
                        .body(Body::from_stream(futures_util::stream::pending::<
                            Result<axum::body::Bytes, std::io::Error>,
                        >()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        }
    }

    #[tokio::test]
    async fn pairing_is_independent_idempotent_and_never_replaces_an_existing_device_key() {
        let db = Arc::new(db::connect(":memory:").await.unwrap());
        let app = router(db.clone(), options());
        let body = device();
        assert_eq!(
            app.clone()
                .oneshot(request("openbitfun-login-token", &body))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert!(db::UserRow::find_by_user_id(&db, PRINCIPAL)
            .await
            .unwrap()
            .is_none());
        let first = app.clone().oneshot(request(KEY, &body)).await.unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        let first = json(first).await;
        assert_eq!(first["user_id"], PRINCIPAL);
        let retry = json(app.clone().oneshot(request(KEY, &body)).await.unwrap()).await;
        assert_eq!(retry, first);
        let mut changed = body.clone();
        changed["public_key"] = json!(STANDARD.encode([8; 32]));
        assert_eq!(
            app.clone()
                .oneshot(request(KEY, &changed))
                .await
                .unwrap()
                .status(),
            StatusCode::CONFLICT
        );
        changed["request_id"] = json!(uuid::Uuid::new_v4().to_string());
        assert_eq!(
            app.clone()
                .oneshot(request(KEY, &changed))
                .await
                .unwrap()
                .status(),
            StatusCode::CONFLICT
        );
        assert_eq!(
            app.clone()
                .oneshot(request(first["token"].as_str().unwrap(), &device()))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        for path in [
            "/api/auth/login",
            "/api/auth/github/start",
            "/api/auth/provision-device",
            "/api/auth/delegate",
        ] {
            assert_eq!(
                app.clone()
                    .oneshot(
                        Request::builder()
                            .method("POST")
                            .uri(path)
                            .body(Body::empty())
                            .unwrap()
                    )
                    .await
                    .unwrap()
                    .status(),
                StatusCode::NOT_FOUND
            );
        }
        let info = json(
            app.oneshot(
                Request::builder()
                    .uri("/api/info")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap(),
        )
        .await;
        assert!(info["capabilities"]
            .as_array()
            .unwrap()
            .contains(&json!("remote_desktop_pairing_v1")));
    }

    #[tokio::test]
    async fn switching_database_roles_is_rejected_without_erasing_credentials() {
        let db = db::connect(":memory:").await.unwrap();
        db::UserRow::create(&db, "official-user", "alice")
            .await
            .unwrap();
        assert!(validate_remote_desktop_database(&db, true).await.is_err());
        assert!(db::UserRow::find_by_user_id(&db, "official-user")
            .await
            .unwrap()
            .is_some());
        assert!(validate_remote_desktop_database(&db, false).await.is_ok());
        let paired = db::connect(":memory:").await.unwrap();
        db::UserRow::create(&paired, PRINCIPAL, PRINCIPAL)
            .await
            .unwrap();
        assert!(validate_remote_desktop_database(&paired, false)
            .await
            .is_err());
        assert!(validate_remote_desktop_database(&paired, true)
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn same_key_reenrollment_renews_expired_credentials_without_replacing_the_device() {
        let db = Arc::new(db::connect(":memory:").await.unwrap());
        let app = router(db.clone(), options());
        let body = device();
        let original = json(app.clone().oneshot(request(KEY, &body)).await.unwrap()).await;
        sqlx::query("UPDATE auth_tokens SET expires_at = 1 WHERE token = ?")
            .bind(original["token"].as_str().unwrap())
            .execute(db.as_ref())
            .await
            .unwrap();
        let mut renewal = body.clone();
        renewal["device_name"] = json!("New local label after restart");
        let response = app.clone().oneshot(request(KEY, &renewal)).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let renewed = json(response).await;
        assert_ne!(renewed["token"], original["token"]);
        assert_eq!(renewed["device_id"], original["device_id"]);
        assert_eq!(
            json(app.clone().oneshot(request(KEY, &renewal)).await.unwrap()).await,
            renewed
        );
        let devices = db::DeviceRow::list_by_user(&db, PRINCIPAL).await.unwrap();
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].public_key, Some(STANDARD.encode([7; 32])));
        assert_eq!(devices[0].device_name.as_deref(), Some("My PC"));
    }

    #[tokio::test]
    async fn desktop_service_refuses_general_rpc_before_buffering_its_body() {
        let app = router(Arc::new(db::connect(":memory:").await.unwrap()), options());
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            app.oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/rpc/payloads")
                    .body(Body::from_stream(futures_util::stream::pending::<
                        Result<axum::body::Bytes, std::io::Error>,
                    >()))
                    .unwrap(),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn pairing_key_is_bounded_and_not_debuggable() {
        assert!(RemoteDesktopPairingConfig::new("short").is_err());
        let config = RemoteDesktopPairingConfig::new(KEY).unwrap();
        assert!(!format!("{config:?}").contains(KEY));
        assert!(config.accepts(KEY));
        assert!(!config.accepts("another-deployment-enrollment-key-1234"));
    }
}
