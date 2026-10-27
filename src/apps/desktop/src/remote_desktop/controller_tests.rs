use super::*;

fn context() -> ControllerContext {
    ControllerContext {
        account_generation: "9007199254740993".into(),
        connection_id: "2".into(),
        socket_generation: "3".into(),
        target_device_id: "desktop".into(),
        public_key_fingerprint: "f".repeat(64),
    }
}

#[test]
fn remote_desktop_controller_context_fences_each_local_binding_fact() {
    let original = context();
    let wire = serde_json::to_value(&original).unwrap();
    let copy: ControllerContext = serde_json::from_value(wire.clone()).unwrap();
    assert!(copy == original && copy.same_route(&original));
    assert_eq!(wire["account_generation"], "9007199254740993");
    for field in [
        "account_generation",
        "connection_id",
        "socket_generation",
        "target_device_id",
        "public_key_fingerprint",
    ] {
        let mut changed = wire.clone();
        changed[field] = Value::String("changed".into());
        let changed: ControllerContext = serde_json::from_value(changed).unwrap();
        assert!(changed != original);
        assert_eq!(
            changed.same_route(&original),
            field == "public_key_fingerprint"
        );
    }
}

#[test]
fn remote_desktop_controller_only_new_probe_can_create_context() {
    for (op, body) in [
        ("list_displays", Value::Null),
        ("get_state", Value::Null),
        ("detach", serde_json::json!({"attach_id":"a"})),
    ] {
        let request: ControllerRequest = serde_json::from_value(serde_json::json!({
            "target_device_id":"desktop", "payload":{"version":1,"op":op,"body":body},
            "attach_id": if op == "detach" { Some("a") } else { None }
        }))
        .unwrap();
        assert_eq!(
            request.validate().unwrap_err(),
            "controller_context_required"
        );
    }
    let request: ControllerRequest = serde_json::from_value(serde_json::json!({
        "target_device_id":"desktop","payload":{"version":1,"op":"capabilities"}
    }))
    .unwrap();
    request.validate().unwrap();
    let mut request = request;
    request.payload.version = 2;
    assert_eq!(request.validate().unwrap_err(), "unsupported_protocol");
    request.payload.version = 1;
    request.attach_id = Some("a".into());
    assert_eq!(request.validate().unwrap_err(), "invalid_request");
    request.attach_id = None;
    request.target_device_id = "desktop:invoke".into();
    assert_eq!(request.validate().unwrap_err(), "invalid_request");
}

#[test]
fn remote_desktop_controller_mutations_preserve_route_scope_and_closed_ops() {
    let mut value = serde_json::json!({"target_device_id":"desktop", "context":context(), "attach_id":"a",
        "payload":{"version":1,"op":"detach","body":{"attach_id":"a"}}});
    serde_json::from_value::<ControllerRequest>(value.clone())
        .unwrap()
        .validate()
        .unwrap();
    value["attach_id"] = Value::String("b".into());
    assert_eq!(
        serde_json::from_value::<ControllerRequest>(value.clone())
            .unwrap()
            .validate()
            .unwrap_err(),
        "invalid_request"
    );
    for op in ["grant", "approve_control", "invoke", "acquire_control"] {
        value["payload"]["op"] = Value::String(op.into());
        assert!(serde_json::from_value::<ControllerRequest>(value.clone()).is_err());
    }
    assert_eq!(
        route_error(&anyhow::anyhow!("unexpected sensitive transport response")),
        "delivery_unknown"
    );
    assert_eq!(
        route_error(&anyhow::anyhow!("target_offline")),
        "target_offline"
    );
}

#[tokio::test]
async fn remote_desktop_controller_oversized_signal_is_rejected_before_account_or_network_io() {
    let request: ControllerRequest = serde_json::from_value(serde_json::json!({
        "target_device_id":"desktop", "context":context(), "attach_id":"a",
        "payload":{"version":1,"op":"signal","body":{
            "attach_id":"a", "connection_id":"pc", "answer_sdp":"x".repeat(MAX_SIGNAL_PLAINTEXT_BYTES)
        }}
    })).unwrap();
    assert_eq!(
        perform_remote_desktop_request(request).await.err().unwrap(),
        "invalid_request"
    );
}

/// Real self-hosted service HTTP + Socket.IO. No app, capture, OS input or
/// persistent device identity is started by this test.
#[tokio::test]
async fn remote_desktop_controller_fences_keys_and_socket_but_is_independent_of_account_login() {
    use crate::api::remote_connect_api::{
        replace_account_context_for_test, ACCOUNT_CONTEXT_TEST_LOCK,
    };
    use base64::{engine::general_purpose::STANDARD, Engine};
    use openbitfun_relay_service::{
        db, MemoryAssetStore, RelayRuntimeOptions, RemoteDesktopPairingConfig,
    };
    use openbitfun_services_integrations::remote_connect::{
        account::AccountSession, relay_client::RelayClient,
    };
    use std::{
        sync::atomic::{AtomicBool, Ordering},
        time::{Duration, Instant},
    };
    use tokio::sync::Notify;

    let _serial = ACCOUNT_CONTEXT_TEST_LOCK.lock().await;
    let database = Arc::new(db::connect(":memory:").await.unwrap());
    let principal = "self-hosted-controller-test";
    db::UserRow::upsert_verified(&database, principal, principal)
        .await
        .unwrap();
    let peer_key = device_crypto::public_key(&[11; 32]);
    for (id, key) in [
        ("controller", device_crypto::public_key(&[7; 32])),
        ("desktop", peer_key),
    ] {
        db::DeviceRow::upsert(
            &database,
            id,
            principal,
            id,
            Some("desktop"),
            Some(&STANDARD.encode(key)),
        )
        .await
        .unwrap();
    }
    let token = db::AuthToken::create(&database, principal, "controller")
        .await
        .unwrap()
        .token;
    let pause = Arc::new(AtomicBool::new(false));
    let arrived = Arc::new(Notify::new());
    let resume = Arc::new(Notify::new());
    let router = openbitfun_relay_service::build_relay_router_with_options(
        Arc::new(MemoryAssetStore::new()),
        Instant::now(),
        database.clone(),
        "test",
        RelayRuntimeOptions {
            remote_desktop_pairing: Some(
                RemoteDesktopPairingConfig::new("isolated-test-enrollment-key-12345678").unwrap(),
            ),
            ..Default::default()
        },
    )
    .layer(axum::middleware::from_fn({
        let (pause, arrived, resume) = (pause.clone(), arrived.clone(), resume.clone());
        move |request: axum::extract::Request, next: axum::middleware::Next| {
            let (pause, arrived, resume) = (pause.clone(), arrived.clone(), resume.clone());
            async move {
                if request.uri().path().ends_with("/key") && pause.swap(false, Ordering::SeqCst) {
                    arrived.notify_one();
                    resume.notified().await;
                }
                next.run(request).await
            }
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let relay = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let (client, _events) = RelayClient::new_controller();
    client.connect(&relay).await.unwrap();
    client
        .connect_authenticated(&token, "Controller")
        .await
        .unwrap();
    let socket = client.remote_desktop_connection().unwrap();
    let client = Arc::new(client);
    let owner = Arc::new(Connection {
        generation: connection::generation(),
        session: AccountSession::new(token, principal.into(), [7; 32]),
        relay,
        device_id: "controller".into(),
        client: client.clone(),
        capabilities: vec!["remote_desktop_route_v1".into()],
    });
    let prepared = Arc::new(Prepared {
        context: ControllerContext {
            account_generation: owner.generation.to_string(),
            connection_id: owner.generation.to_string(),
            socket_generation: socket.socket_generation().to_string(),
            target_device_id: "desktop".into(),
            public_key_fingerprint: public_key_fingerprint(&peer_key),
        },
        owner,
        socket,
        peer_key,
    });
    prepared.verify_reply_owner().await.unwrap();
    db::DeviceRow::upsert(
        &database,
        "desktop",
        principal,
        "desktop",
        Some("desktop"),
        Some(&STANDARD.encode(device_crypto::public_key(&[17; 32]))),
    )
    .await
    .unwrap();
    let wrong_key = prepared.verify_reply_owner().await;
    db::DeviceRow::upsert(
        &database,
        "desktop",
        principal,
        "desktop",
        Some("desktop"),
        Some(&STANDARD.encode(peer_key)),
    )
    .await
    .unwrap();

    pause.store(true, Ordering::SeqCst);
    let pending = tokio::spawn({
        let prepared = prepared.clone();
        async move { prepared.verify_reply_owner().await }
    });
    tokio::time::timeout(Duration::from_secs(3), arrived.notified())
        .await
        .unwrap();
    let previous = replace_account_context_for_test(Some((
        AccountSession::new(
            "unrelated-login-token".into(),
            "unrelated-account".into(),
            [19; 32],
        ),
        "https://login.example".into(),
    )))
    .await;
    resume.notify_one();
    let account_change = pending.await.unwrap();
    replace_account_context_for_test(previous).await;

    pause.store(true, Ordering::SeqCst);
    let pending = tokio::spawn({
        let prepared = prepared.clone();
        async move { prepared.verify_reply_owner().await }
    });
    tokio::time::timeout(Duration::from_secs(3), arrived.notified())
        .await
        .unwrap();
    client.disconnect().await;
    resume.notify_one();
    let socket_change = pending.await.unwrap();
    server.abort();
    assert_eq!(wrong_key.unwrap_err(), "target_identity_changed");
    account_change.unwrap();
    assert_eq!(
        socket_change.unwrap_err(),
        "remote_desktop_connection_changed"
    );
}
