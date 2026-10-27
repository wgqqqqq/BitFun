//! Real Socket.IO framing against the shared router, including legacy clients.
use super::*;

#[tokio::test]
async fn ordinary_account_relay_rejects_desktop_events_even_when_the_client_ignores_discovery() {
    let f = client_build_fixture().await;
    let (address, server) = spawn(f.app).await;
    let mut host = connect_scope(address, "", &f.desktop_token, "machine-scoped").await;
    let mut controller = connect_scope(address, "", &f.mobile_token, "user-scoped").await;
    event(&mut host, 1, "rd-register", json!({"version":1})).await;
    assert_eq!(
        acknowledgement(&mut host, 1).await["error"],
        "remote_desktop_service_required"
    );
    event(&mut controller, 2, "rd-call", call("desktop", 1000)).await;
    assert_eq!(
        acknowledgement(&mut controller, 2).await["error"],
        "remote_desktop_service_required"
    );
    server.abort();
}

#[tokio::test]
async fn controller_directory_is_separate_account_scoped_and_requires_full_device_tokens() {
    for prefix in ["", "/v1/relay"] {
        let f = client_build_fixture_with_desktop(true).await;
        for (id, kind, account) in [
            ("desktop", "desktop", "owner"),
            ("mobile", "mobile", "owner"),
            ("pc", "desktop", "owner"),
            ("watch", "watch", "owner"),
            ("cli", "cli", "owner"),
            ("outsider", "mobile", "outsider"),
        ] {
            db::DeviceRow::upsert(&f.db, id, account, id, Some(kind), None)
                .await
                .unwrap();
            sqlx::query("UPDATE devices SET public_key = ? WHERE user_id = ? AND device_id = ?")
                .bind(BASE64.encode([7; 32]))
                .bind(account)
                .bind(id)
                .execute(f.db.as_ref())
                .await
                .unwrap();
        }
        let delegated = db::AuthToken::create_delegated(&f.db, "owner", "desktop")
            .await
            .unwrap();
        let app = if prefix.is_empty() {
            f.app
        } else {
            Router::new().nest(prefix, f.app)
        };
        let path = format!("{prefix}/api/remote-desktop/controllers");
        for (token, status) in [
            ("missing", StatusCode::UNAUTHORIZED),
            (delegated.token.as_str(), StatusCode::FORBIDDEN),
        ] {
            assert_eq!(
                request(&app, "GET", &path, token, Value::Null)
                    .await
                    .status(),
                status
            );
        }
        let response = request(&app, "GET", &path, &f.desktop_token, Value::Null).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(
            body.as_array()
                .unwrap()
                .iter()
                .map(|d| d["device_id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["mobile", "pc"]
        );
        assert!(body
            .as_array()
            .unwrap()
            .iter()
            .all(|d| d.get("public_key").is_none() && d.get("token").is_none()));
        let old = json_body(
            request(
                &app,
                "GET",
                &format!("{prefix}/api/devices"),
                &f.desktop_token,
                Value::Null,
            )
            .await,
        )
        .await;
        assert!(old
            .as_array()
            .unwrap()
            .iter()
            .all(|d| d["device_id"] != "mobile" && d["device_id"] != "watch"));
        let other =
            json_body(request(&app, "GET", &path, &f.outsider_token, Value::Null).await).await;
        assert_eq!(other, json!([]));
        db::AuthToken::revoke_by_device(&f.db, "owner", "desktop")
            .await
            .unwrap();
        assert_eq!(
            request(&app, "GET", &path, &f.desktop_token, Value::Null)
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
}

#[tokio::test]
async fn controller_directory_rejects_oversized_results_without_truncation() {
    let f = client_build_fixture_with_desktop(true).await;
    db::DeviceRow::upsert(&f.db, "controller", "owner", "Phone", Some("mobile"), None)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE devices SET public_key = ?, device_alias = ? WHERE user_id = ? AND device_id = ?",
    )
    .bind(BASE64.encode([7; 32]))
    .bind("x".repeat(64 * 1024))
    .bind("owner")
    .bind("controller")
    .execute(f.db.as_ref())
    .await
    .unwrap();
    let path = "/api/remote-desktop/controllers";
    assert_eq!(
        request(&f.app, "GET", path, &f.desktop_token, Value::Null)
            .await
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    sqlx::query("UPDATE devices SET device_alias = ? WHERE user_id = ? AND device_id = ?")
        .bind("My phone")
        .bind("owner")
        .bind("controller")
        .execute(f.db.as_ref())
        .await
        .unwrap();
    let response = request(&f.app, "GET", path, &f.desktop_token, Value::Null).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_body(response).await.as_array().unwrap().len(), 1);
}

fn call(target: &str, timeout: u64) -> Value {
    json!({"version":1,"targetDeviceId":target,
        "params":{"encrypted_data":"opaque-ciphertext","nonce":"opaque-nonce"},
        "timeoutMs":timeout})
}

async fn next_request(socket: &mut Socket) -> (String, Value) {
    loop {
        let message = packet(socket).await;
        if let Some(rest) = message.strip_prefix("42") {
            let index = rest.find('[').unwrap();
            let data: Value = serde_json::from_str(&rest[index..]).unwrap();
            if data[0] == "rd-request" {
                return (rest[..index].to_string(), data[1].clone());
            }
        }
    }
}

async fn reply(socket: &mut Socket, id: &str, value: Value) {
    socket
        .send(Message::Text(format!("43{id}{}", json!([value])).into()))
        .await
        .unwrap();
}

#[tokio::test]
async fn versioned_route_is_account_scoped_and_injects_source_without_changing_legacy_handshake() {
    for prefix in ["", "/v1/relay"] {
        let f = client_build_fixture_with_desktop(true).await;
        let app = if prefix.is_empty() {
            f.app
        } else {
            Router::new().nest(prefix, f.app)
        };
        let (address, server) = spawn(app).await;
        // Different general RPC protocols deliberately remain incompatible.
        let mut host = connect_scope_with_build(
            address,
            prefix,
            &f.desktop_token,
            "machine-scoped",
            Some(("host", 5)),
        )
        .await;
        // A legacy handshake can opt into the dedicated v1 lane separately.
        let mut phone = connect_scope(address, prefix, &f.mobile_token, "user-scoped").await;
        let mut outsider = connect_scope(address, prefix, &f.outsider_token, "user-scoped").await;
        event(
            &mut host,
            1,
            "rd-register",
            json!({"version":1,"targetDeviceId":"outsider"}),
        )
        .await;
        assert_eq!(acknowledgement(&mut host, 1).await["ok"], true);
        event(&mut outsider, 2, "rd-call", call("desktop", 1000)).await;
        assert_eq!(
            acknowledgement(&mut outsider, 2).await["error"],
            "target_unavailable"
        );
        let mut request = call("desktop", 2000);
        request["sourceDeviceId"] = json!("outsider");
        request["account"] = json!("outsider");
        event(&mut phone, 3, "rd-call", request.clone()).await;
        let (id, forwarded) = next_request(&mut host).await;
        assert_eq!(forwarded["version"], 1);
        assert_eq!(forwarded["sourceDeviceId"], "mobile");
        assert_eq!(forwarded["params"], request["params"]);
        assert!(forwarded.get("account").is_none());
        reply(
            &mut host,
            &id,
            json!({"encrypted_data":"encrypted-answer","nonce":"answer-nonce"}),
        )
        .await;
        let response = acknowledgement(&mut phone, 3).await;
        assert_eq!(response["ok"], true);
        assert_eq!(response["result"]["encrypted_data"], "encrypted-answer");
        event(&mut phone, 30, "rd-call", call("desktop", 2000)).await;
        let (id, _) = next_request(&mut host).await;
        reply(&mut host, &id, json!({"display_id":"plaintext-response"})).await;
        assert_eq!(
            acknowledgement(&mut phone, 30).await["error"],
            "invalid_response"
        );
        // Generic RPC cannot be used as a version-gate escape hatch.
        event(
            &mut host,
            4,
            "rpc-register",
            json!({"method":"desktop:invoke"}),
        )
        .await;
        assert_eq!(
            acknowledgement(&mut host, 4).await["error"],
            "remote_desktop_only"
        );
        event(
            &mut phone,
            5,
            "rpc-call",
            json!({"method":"desktop:invoke","params":{},"timeoutMs":1000}),
        )
        .await;
        assert!(acknowledgement(&mut phone, 5).await["error"]
            .as_str()
            .unwrap()
            .contains("remote_desktop_only"));
        server.abort();
    }
}

#[tokio::test]
async fn registration_version_scope_delegate_and_payload_limits_are_explicit() {
    let f = client_build_fixture_with_desktop(true).await;
    db::DeviceRow::upsert(
        &f.db,
        "mobile",
        "owner",
        "Desktop label",
        Some("mobile"),
        None,
    )
    .await
    .unwrap();
    let delegated =
        db::AuthToken::create_keyed_delegated(&f.db, "owner", "mobile", "controller-key")
            .await
            .unwrap();
    let (address, server) = spawn(f.app).await;
    let mut host = connect_scope(address, "", &f.desktop_token, "machine-scoped").await;
    let mut phone = connect_scope(address, "", &f.mobile_token, "user-scoped").await;
    let mut delegate = connect_scope(address, "", &delegated.token, "user-scoped").await;
    let mut phone_machine = connect_scope(address, "", &f.mobile_token, "machine-scoped").await;
    event(&mut phone_machine, 10, "rd-register", json!({"version":1})).await;
    assert_eq!(
        acknowledgement(&mut phone_machine, 10).await["error"],
        "forbidden"
    );
    event(&mut host, 1, "rd-register", json!({"version":2})).await;
    assert_eq!(
        acknowledgement(&mut host, 1).await["error"],
        "unsupported_protocol"
    );
    event(&mut phone, 2, "rd-register", json!({"version":1})).await;
    assert_eq!(acknowledgement(&mut phone, 2).await["error"], "forbidden");
    event(&mut delegate, 3, "rd-call", call("desktop", 1000)).await;
    assert_eq!(
        acknowledgement(&mut delegate, 3).await["error"],
        "forbidden"
    );
    for (id, body, error) in [
        (
            4,
            json!({"version":2,"targetDeviceId":"desktop","params":{"encrypted_data":"x","nonce":"n"}}),
            "unsupported_protocol",
        ),
        (
            5,
            json!({"version":1,"targetDeviceId":"desktop","params":{"op":"attach"}}),
            "invalid_request",
        ),
        (6, call("desktop:invoke", 1000), "invalid_request"),
        (7, call("desktop", 30_001), "invalid_request"),
        (8, call("desktop", 0), "invalid_request"),
    ] {
        event(&mut phone, id, "rd-call", body).await;
        assert_eq!(acknowledgement(&mut phone, id).await["error"], error);
    }
    let mut oversized = call("desktop", 1000);
    oversized["params"]["encrypted_data"] = json!("x".repeat(128 * 1024 + 1));
    event(&mut phone, 9, "rd-call", oversized).await;
    assert_eq!(
        acknowledgement(&mut phone, 9).await["error"],
        "invalid_request"
    );
    server.abort();
}

#[tokio::test]
async fn reconnect_unregister_and_disconnect_never_retry_a_dispatched_call() {
    let f = client_build_fixture_with_desktop(true).await;
    let (address, server) = spawn(f.app).await;
    let mut host = connect_scope(address, "", &f.desktop_token, "machine-scoped").await;
    let mut phone = connect_scope(address, "", &f.mobile_token, "user-scoped").await;
    event(&mut host, 1, "rd-register", json!({"version":1})).await;
    assert_eq!(acknowledgement(&mut host, 1).await["ok"], true);
    let mut old = call("desktop", 2000);
    old["params"]["encrypted_data"] = json!("old-mutation");
    event(&mut phone, 2, "rd-call", old).await;
    let _ = next_request(&mut host).await;
    // Presence activation replaces the old device socket. Its outstanding ACK
    // must be UNKNOWN, even if a replacement is already online and registered.
    let mut replacement = connect_scope(address, "", &f.desktop_token, "machine-scoped").await;
    event(&mut replacement, 3, "rd-register", json!({"version":1})).await;
    assert_eq!(acknowledgement(&mut replacement, 3).await["ok"], true);
    assert_eq!(
        acknowledgement(&mut phone, 2).await["error"],
        "delivery_unknown"
    );
    let mut fresh = call("desktop", 2000);
    fresh["params"]["encrypted_data"] = json!("explicit-fresh-request");
    event(&mut phone, 4, "rd-call", fresh).await;
    let (id, forwarded) = next_request(&mut replacement).await;
    assert_eq!(
        forwarded["params"]["encrypted_data"],
        "explicit-fresh-request"
    );
    reply(
        &mut replacement,
        &id,
        json!({"encrypted_data":"fresh-answer","nonce":"n"}),
    )
    .await;
    assert_eq!(acknowledgement(&mut phone, 4).await["ok"], true);
    event(&mut replacement, 5, "rd-unregister", json!({})).await;
    assert_eq!(acknowledgement(&mut replacement, 5).await["ok"], true);
    event(&mut phone, 6, "rd-call", call("desktop", 1000)).await;
    assert_eq!(
        acknowledgement(&mut phone, 6).await["error"],
        "target_unavailable"
    );
    server.abort();
}

#[tokio::test]
async fn revocation_during_ack_is_not_reported_as_success() {
    let f = client_build_fixture_with_desktop(true).await;
    let (address, server) = spawn(f.app).await;
    let mut host = connect_scope(address, "", &f.desktop_token, "machine-scoped").await;
    let mut phone = connect_scope(address, "", &f.mobile_token, "user-scoped").await;
    event(&mut host, 1, "rd-register", json!({"version":1})).await;
    assert_eq!(acknowledgement(&mut host, 1).await["ok"], true);
    event(&mut phone, 2, "rd-call", call("desktop", 2000)).await;
    let (id, _) = next_request(&mut host).await;
    sqlx::query("DELETE FROM auth_tokens WHERE token = ?")
        .bind(&f.desktop_token)
        .execute(&*f.db)
        .await
        .unwrap();
    reply(
        &mut host,
        &id,
        json!({"encrypted_data":"late-answer","nonce":"late"}),
    )
    .await;
    assert_eq!(
        acknowledgement(&mut phone, 2).await["error"],
        "delivery_unknown"
    );
    event(&mut phone, 3, "rd-call", call("desktop", 1000)).await;
    assert_eq!(
        acknowledgement(&mut phone, 3).await["error"],
        "authorization_expired"
    );
    server.abort();
}

#[tokio::test]
async fn remote_desktop_subbudget_is_shared_between_sockets_and_reclaimed_after_timeout() {
    let f = client_build_fixture_with_desktop(true).await;
    let (address, server) = spawn(f.app).await;
    let mut host = connect_scope(address, "", &f.desktop_token, "machine-scoped").await;
    let mut phone = connect_scope(address, "", &f.mobile_token, "user-scoped").await;
    let mut other_socket = connect_scope(address, "", &f.mobile_token, "user-scoped").await;
    event(&mut host, 1, "rd-register", json!({"version":1})).await;
    assert_eq!(acknowledgement(&mut host, 1).await["ok"], true);
    let mut large = call("desktop", 1000);
    large["params"]["encrypted_data"] = json!("x".repeat(100 * 1024));
    event(&mut phone, 2, "rd-call", large.clone()).await;
    let _ = next_request(&mut host).await;
    event(&mut other_socket, 3, "rd-call", large.clone()).await;
    let _ = next_request(&mut host).await;
    event(&mut other_socket, 4, "rd-call", large).await;
    assert_eq!(
        acknowledgement(&mut other_socket, 4).await["error"],
        "capacity_exceeded"
    );
    assert_eq!(
        acknowledgement(&mut phone, 2).await["error"],
        "delivery_unknown"
    );
    assert_eq!(
        acknowledgement(&mut other_socket, 3).await["error"],
        "delivery_unknown"
    );
    event(&mut phone, 5, "rd-call", call("desktop", 1000)).await;
    let (id, _) = next_request(&mut host).await;
    reply(
        &mut host,
        &id,
        json!({"encrypted_data":"after-timeout","nonce":"n"}),
    )
    .await;
    assert_eq!(acknowledgement(&mut phone, 5).await["ok"], true);
    server.abort();
}

async fn next_notice(socket: &mut Socket) -> (String, Value) {
    loop {
        let message = packet(socket).await;
        if let Some(rest) = message.strip_prefix("42") {
            let index = rest.find('[').unwrap();
            let data: Value = serde_json::from_str(&rest[index..]).unwrap();
            if data[0] == "rd-notice" {
                return (rest[..index].to_string(), data[1].clone());
            }
        }
    }
}

async fn prepare_attachment(
    f: &BuildFixture,
    prefix: &str,
) -> (Socket, Socket, tokio::task::JoinHandle<()>) {
    sqlx::query("UPDATE devices SET public_key=? WHERE user_id='owner'")
        .bind(BASE64.encode([9; 32]))
        .execute(&*f.db)
        .await
        .unwrap();
    let app = if prefix.is_empty() {
        f.app.clone()
    } else {
        Router::new().nest(prefix, f.app.clone())
    };
    let (address, server) = spawn(app).await;
    let mut host = connect_scope(address, prefix, &f.desktop_token, "machine-scoped").await;
    let mut source = connect_scope(address, prefix, &f.mobile_token, "user-scoped").await;
    event(&mut host, 1, "rd-register", json!({"version":1})).await;
    assert_eq!(acknowledgement(&mut host, 1).await["ok"], true);
    let mut request = call("desktop", 15_000);
    request["attachId"] = json!("attachment-a");
    event(&mut source, 2, "rd-call", request).await;
    let (id, request) = next_request(&mut host).await;
    assert_eq!(request["attachId"], "attachment-a");
    reply(
        &mut host,
        &id,
        json!({"encrypted_data":"answer","nonce":"nonce","$rdAttachment":"accepted"}),
    )
    .await;
    let (id, ready) = next_notice(&mut host).await;
    assert_eq!(
        ready,
        json!({"version":1,"attachId":"attachment-a","kind":"ready"})
    );
    reply(&mut host, &id, json!({"ok":true,"attachId":"attachment-a"})).await;
    let response = acknowledgement(&mut source, 2).await;
    assert_eq!(response["ok"], true);
    assert_eq!(
        response["result"],
        json!({"encrypted_data":"answer","nonce":"nonce"})
    );
    (host, source, server)
}

#[tokio::test]
async fn attachment_credential_binding_survives_registry_restart_but_not_token_replacement() {
    for prefix in ["", "/v1/relay"] {
        let f = client_build_fixture_with_desktop(true).await;
        sqlx::query("UPDATE devices SET public_key=? WHERE user_id='owner'")
            .bind(BASE64.encode([9; 32]))
            .execute(&*f.db)
            .await
            .unwrap();
        let replacement = db::AuthToken::create(&f.db, "owner", "mobile")
            .await
            .unwrap();
        let mut original_binding = None;
        // A fresh router has no attachment registry, exactly as after a Relay
        // process restart. The host must still recognize the original tokens.
        for (token, same_identity) in [
            (f.mobile_token.as_str(), true),
            (f.mobile_token.as_str(), true),
            (replacement.token.as_str(), false),
        ] {
            if !same_identity {
                sqlx::query("DELETE FROM auth_tokens WHERE token=?")
                    .bind(&f.mobile_token)
                    .execute(&*f.db)
                    .await
                    .unwrap();
                assert!(db::AuthToken::find(&f.db, &f.mobile_token)
                    .await
                    .unwrap()
                    .is_none());
            }
            let app = crate::build_relay_router_with_options(
                Arc::new(MemoryAssetStore::new()),
                Instant::now(),
                f.db.clone(),
                "test",
                crate::RelayRuntimeOptions {
                    remote_desktop_pairing: Some(
                        crate::RemoteDesktopPairingConfig::new(
                            "fixture-only-enrollment-key-with-32-bytes",
                        )
                        .unwrap(),
                    ),
                    ..Default::default()
                },
            );
            let app = if prefix.is_empty() {
                app
            } else {
                Router::new().nest(prefix, app)
            };
            let (address, server) = spawn(app).await;
            let mut host = connect_scope(address, prefix, &f.desktop_token, "machine-scoped").await;
            let mut source = connect_scope(address, prefix, token, "user-scoped").await;
            event(&mut host, 1, "rd-register", json!({"version":1})).await;
            assert_eq!(acknowledgement(&mut host, 1).await["ok"], true);
            let mut scoped = call("desktop", 15_000);
            scoped["attachId"] = json!("attachment-a");
            // A controller-supplied binding must never become the host's fact.
            scoped["credentialBinding"] = json!("controller-forged-binding");
            event(&mut source, 2, "rd-call", scoped).await;
            let (id, forwarded) = next_request(&mut host).await;
            let binding = forwarded["credentialBinding"]
                .as_str()
                .expect("Relay must bind the original credential pair before host dispatch");
            assert_eq!(binding.len(), 64);
            assert!(binding
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
            assert!(!binding.contains(token));
            if let Some(original) = &original_binding {
                assert_eq!(binding == original, same_identity);
            } else {
                original_binding = Some(binding.to_owned());
            }
            // The fixture has no native host: do not accept an attachment.
            reply(
                &mut host,
                &id,
                json!({"encrypted_data":"state","nonce":"n"}),
            )
            .await;
            assert_eq!(acknowledgement(&mut source, 2).await["ok"], true);
            host.close(None).await.unwrap();
            source.close(None).await.unwrap();
            server.abort();
        }
    }
}

#[tokio::test]
async fn turn_credentials_require_accepted_link_original_participants_and_live_keys() {
    use hmac::{Hmac, Mac};
    for prefix in ["", "/v1/relay"] {
        let mut f = client_build_fixture_with_desktop(true).await;
        let secret = "fixture-signing-material-never-used-for-deployment";
        f.app = crate::build_relay_router_with_options(
            Arc::new(MemoryAssetStore::new()),
            Instant::now(),
            f.db.clone(),
            "test",
            crate::RelayRuntimeOptions {
                remote_desktop_pairing: Some(
                    crate::RemoteDesktopPairingConfig::new(
                        "fixture-only-enrollment-key-with-32-bytes",
                    )
                    .unwrap(),
                ),
                remote_desktop_turn: Some(
                    crate::RemoteDesktopTurnConfig::new(
                        vec!["turn:relay.example:3478?transport=udp".into()],
                        secret.into(),
                    )
                    .unwrap(),
                ),
                ..Default::default()
            },
        );
        let app = if prefix.is_empty() {
            f.app.clone()
        } else {
            Router::new().nest(prefix, f.app.clone())
        };
        let path = format!(
            "{prefix}/api/remote-desktop/turn?target_device_id=desktop&attach_id=attachment-a"
        );
        let info =
            json_body(request(&app, "GET", &format!("{prefix}/api/info"), "", Value::Null).await)
                .await;
        assert!(info["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == "remote_desktop_turn_v1"));
        assert_eq!(
            request(&app, "GET", &path, &f.mobile_token, Value::Null)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        let (mut host, _source, server) = prepare_attachment(&f, prefix).await;
        let response = request(&app, "GET", &path, &f.mobile_token, Value::Null).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let first = json_body(response).await;
        let second =
            json_body(request(&app, "GET", &path, &f.mobile_token, Value::Null).await).await;
        assert_eq!(first, second);
        assert_eq!(first["attach_id"], "attachment-a");
        assert!(!first.to_string().contains(secret));
        assert!(!first.to_string().contains(&f.mobile_token));
        let now = chrono::Utc::now().timestamp();
        let expiry = first["expires_at"].as_i64().unwrap();
        assert!((now + 299..=now + 600).contains(&expiry));
        let ice = &first["ice_servers"][0];
        let username = ice["username"].as_str().unwrap();
        assert!(username.starts_with(&format!("{expiry}:rd:")));
        let mut hmac = Hmac::<sha1::Sha1>::new_from_slice(secret.as_bytes()).unwrap();
        hmac.update(username.as_bytes());
        assert_eq!(
            ice["credential"],
            BASE64.encode(hmac.finalize().into_bytes())
        );
        let host_credentials =
            json_body(request(&app, "GET", &path, &f.desktop_token, Value::Null).await).await;
        assert_ne!(
            host_credentials["ice_servers"][0]["username"],
            first["ice_servers"][0]["username"]
        );
        assert_eq!(
            request(&app, "GET", &path, &f.outsider_token, Value::Null)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        let delegated = db::AuthToken::create_delegated(&f.db, "owner", "desktop")
            .await
            .unwrap();
        assert_eq!(
            request(&app, "GET", &path, &delegated.token, Value::Null)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        let replacement = db::AuthToken::create(&f.db, "owner", "mobile")
            .await
            .unwrap();
        assert_eq!(
            request(&app, "GET", &path, &replacement.token, Value::Null)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        db::DeviceRow::upsert(
            &f.db,
            "another-device",
            "owner",
            "another-device",
            Some("mobile"),
            None,
        )
        .await
        .unwrap();
        let other = db::AuthToken::create(&f.db, "owner", "another-device")
            .await
            .unwrap();
        assert_eq!(
            request(&app, "GET", &path, &other.token, Value::Null)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        sqlx::query("UPDATE devices SET public_key=? WHERE user_id='owner' AND device_id='mobile'")
            .bind(BASE64.encode([3; 32]))
            .execute(&*f.db)
            .await
            .unwrap();
        assert_eq!(
            request(&app, "GET", &path, &f.desktop_token, Value::Null)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        sqlx::query("UPDATE devices SET public_key=? WHERE user_id='owner' AND device_id='mobile'")
            .bind(BASE64.encode([9; 32]))
            .execute(&*f.db)
            .await
            .unwrap();
        event(
            &mut host,
            55,
            "rd-end",
            json!({"version":1,"attachId":"attachment-a"}),
        )
        .await;
        let (notice_id, notice) = next_notice(&mut host).await;
        assert_eq!(notice["kind"], "ended");
        reply(
            &mut host,
            &notice_id,
            json!({"ok":true,"attachId":"attachment-a"}),
        )
        .await;
        assert_eq!(acknowledgement(&mut host, 55).await["ok"], true);
        assert_eq!(
            request(&app, "GET", &path, &f.desktop_token, Value::Null)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        server.abort();
    }
}

#[tokio::test]
async fn turn_configuration_is_optional_and_failed_issuance_never_falls_back() {
    let f = client_build_fixture_with_desktop(true).await;
    let info = json_body(request(&f.app, "GET", "/api/info", "", Value::Null).await).await;
    assert!(!info["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .any(|value| value == "remote_desktop_turn_v1"));
    let response = request(
        &f.app,
        "GET",
        "/api/remote-desktop/turn?target_device_id=desktop&attach_id=a",
        &f.mobile_token,
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        json_body(response).await["error"]["code"],
        "turn_unavailable"
    );
}

#[tokio::test]
async fn attachment_key_rotation_notifies_the_original_host_before_releasing_the_link() {
    for prefix in ["", "/v1/relay"] {
        let f = client_build_fixture_with_desktop(true).await;
        let (mut host, mut source, server) = prepare_attachment(&f, prefix).await;
        sqlx::query("UPDATE devices SET public_key=? WHERE user_id='owner' AND device_id='mobile'")
            .bind(BASE64.encode([8; 32]))
            .execute(&*f.db)
            .await
            .unwrap();
        let (id, notice) = next_notice(&mut host).await;
        assert_eq!(notice["kind"], "revoked");
        assert_eq!(notice["attachId"], "attachment-a");
        reply(&mut host, &id, json!({"ok":true,"attachId":"attachment-a"})).await;
        // The old, non-attachment lane still works; a lifecycle stop does not
        // delete sessions or turn into an account-wide connection shutdown.
        event(&mut source, 3, "rd-call", call("desktop", 2000)).await;
        let (id, _) = next_request(&mut host).await;
        reply(
            &mut host,
            &id,
            json!({"encrypted_data":"capabilities","nonce":"n"}),
        )
        .await;
        assert_eq!(acknowledgement(&mut source, 3).await["ok"], true);
        host.close(None).await.unwrap();
        source.close(None).await.unwrap();
        server.abort();
    }
}

#[tokio::test]
async fn lost_notice_ack_closes_only_the_affected_host_socket() {
    let f = client_build_fixture_with_desktop(true).await;
    let (mut host, mut source, server) = prepare_attachment(&f, "").await;
    sqlx::query("UPDATE devices SET public_key=? WHERE user_id='owner' AND device_id='mobile'")
        .bind(BASE64.encode([8; 32]))
        .execute(&*f.db)
        .await
        .unwrap();
    let (_, notice) = next_notice(&mut host).await;
    assert_eq!(notice["kind"], "revoked");
    // Do not acknowledge: removing the route alone cannot stop a direct PC.
    loop {
        if packet(&mut host).await == "41" {
            break;
        }
    }
    event(&mut source, 4, "rd-call", call("desktop", 1000)).await;
    assert_eq!(
        acknowledgement(&mut source, 4).await["error"],
        "target_unavailable"
    );
    source.close(None).await.unwrap();
    server.abort();
}

#[tokio::test]
async fn a_same_device_replacement_token_cannot_take_over_the_original_attachment() {
    let f = client_build_fixture_with_desktop(true).await;
    sqlx::query("UPDATE devices SET public_key=? WHERE user_id='owner'")
        .bind(BASE64.encode([9; 32]))
        .execute(&*f.db)
        .await
        .unwrap();
    let (address, server) = spawn(f.app.clone()).await;
    let mut host = connect_scope(address, "", &f.desktop_token, "machine-scoped").await;
    let mut source = connect_scope(address, "", &f.mobile_token, "user-scoped").await;
    event(&mut host, 1, "rd-register", json!({"version":1})).await;
    acknowledgement(&mut host, 1).await;
    let mut request = call("desktop", 15_000);
    request["attachId"] = json!("attachment-a");
    event(&mut source, 2, "rd-call", request.clone()).await;
    let (id, _) = next_request(&mut host).await;
    reply(
        &mut host,
        &id,
        json!({"encrypted_data":"answer","nonce":"n","$rdAttachment":"accepted"}),
    )
    .await;
    let (id, _) = next_notice(&mut host).await;
    reply(&mut host, &id, json!({"ok":true,"attachId":"attachment-a"})).await;
    assert_eq!(acknowledgement(&mut source, 2).await["ok"], true);
    let replacement = db::AuthToken::create(&f.db, "owner", "mobile")
        .await
        .unwrap()
        .token;
    let mut replacement = connect_scope(address, "", &replacement, "machine-scoped").await;
    // Still online, same device/key; the request must not change the source
    // token captured by attachment-a.
    event(&mut replacement, 3, "rd-call", request).await;
    assert_eq!(
        acknowledgement(&mut replacement, 3).await["error"],
        "attachment_identity_changed"
    );
    sqlx::query("DELETE FROM auth_tokens WHERE token=?")
        .bind(&f.mobile_token)
        .execute(&*f.db)
        .await
        .unwrap();
    let (id, notice) = next_notice(&mut host).await;
    assert_eq!(notice["kind"], "revoked");
    reply(&mut host, &id, json!({"ok":true,"attachId":"attachment-a"})).await;
    assert_eq!(
        db::DeviceRow::list_by_user(&f.db, "owner")
            .await
            .unwrap()
            .into_iter()
            .find(|row| row.device_id == "mobile")
            .unwrap()
            .online,
        1
    );
    host.close(None).await.unwrap();
    replacement.close(None).await.unwrap();
    server.abort();
}

#[tokio::test]
async fn explicit_same_token_recovery_rebinds_after_loss_without_overriding_the_old_identity() {
    let f = client_build_fixture_with_desktop(true).await;
    sqlx::query("UPDATE devices SET public_key=? WHERE user_id='owner'")
        .bind(BASE64.encode([9; 32]))
        .execute(&*f.db)
        .await
        .unwrap();
    let (address, server) = spawn(f.app.clone()).await;
    let mut host = connect_scope(address, "", &f.desktop_token, "machine-scoped").await;
    let mut source = connect_scope(address, "", &f.mobile_token, "user-scoped").await;
    event(&mut host, 1, "rd-register", json!({"version":1})).await;
    acknowledgement(&mut host, 1).await;
    let mut scoped = call("desktop", 15_000);
    scoped["attachId"] = json!("a");
    event(&mut source, 2, "rd-call", scoped.clone()).await;
    let (id, _) = next_request(&mut host).await;
    reply(
        &mut host,
        &id,
        json!({"encrypted_data":"cipher","nonce":"n","$rdAttachment":"accepted"}),
    )
    .await;
    let (id, _) = next_notice(&mut host).await;
    reply(&mut host, &id, json!({"ok":true,"attachId":"a"})).await;
    assert_eq!(acknowledgement(&mut source, 2).await["ok"], true);
    source.close(None).await.unwrap();
    let (id, unknown) = next_notice(&mut host).await;
    assert_eq!(unknown["kind"], "unknown");
    reply(&mut host, &id, json!({"ok":true,"attachId":"a"})).await;
    let mut source = connect_scope(address, "", &f.mobile_token, "user-scoped").await;
    event(&mut source, 3, "rd-call", scoped).await;
    let (id, request) = next_request(&mut host).await;
    assert_eq!(request["attachId"], "a");
    reply(
        &mut host,
        &id,
        json!({"encrypted_data":"cipher","nonce":"n","$rdAttachment":"accepted"}),
    )
    .await;
    let (id, ready) = next_notice(&mut host).await;
    assert_eq!(ready["kind"], "ready");
    reply(&mut host, &id, json!({"ok":true,"attachId":"a"})).await;
    assert_eq!(acknowledgement(&mut source, 3).await["ok"], true);
    host.close(None).await.unwrap();
    source.close(None).await.unwrap();
    server.abort();
}

#[tokio::test]
async fn host_unregister_ends_the_attachment_and_cli_targets_are_explicitly_unsupported() {
    let f = client_build_fixture_with_desktop(true).await;
    let (mut host, mut source, server) = prepare_attachment(&f, "").await;
    event(&mut host, 4, "rd-unregister", json!({})).await;
    let (id, notice) = next_notice(&mut host).await;
    assert_eq!(notice["kind"], "ended");
    reply(&mut host, &id, json!({"ok":true,"attachId":"attachment-a"})).await;
    assert_eq!(acknowledgement(&mut host, 4).await["ok"], true);
    event(&mut source, 5, "rd-call", call("desktop", 1000)).await;
    assert_eq!(
        acknowledgement(&mut source, 5).await["error"],
        "target_unavailable"
    );
    sqlx::query(
        "UPDATE devices SET device_kind='cli' WHERE user_id='owner' AND device_id='desktop'",
    )
    .execute(&*f.db)
    .await
    .unwrap();
    event(&mut source, 6, "rd-call", call("desktop", 1000)).await;
    assert_eq!(
        acknowledgement(&mut source, 6).await["error"],
        "unsupported"
    );
    host.close(None).await.unwrap();
    source.close(None).await.unwrap();
    server.abort();
}
