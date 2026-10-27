//! Independent self-hosted desktop enrollment and credential storage. The
//! product's account session store and identity provider are never consulted.
use super::{account, device_crypto};
use crate::remote_persistence::{self, AccountSessionRecord, MachineBinding};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::{path::Path, time::Duration};

pub const SERVICE_PRINCIPAL: &str = "remote-desktop-self-hosted";
const PENDING: &str = "pairing-pending:";

/// Credentials may only be submitted to the explicitly configured deployment.
/// Public deployments require TLS; loopback HTTP remains available for tests
/// and an operator's local reverse-proxy tunnel.
pub fn service_url(value: &str) -> Result<String> {
    let mut url = account::validate_relay_base_url(value)?;
    let official = reqwest::Url::parse(openbitfun_product_domains::account::DEFAULT_RELAY_URL)?;
    if url.host_str() == official.host_str() {
        bail!("remote_desktop_service_required");
    }
    let local = url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if url.scheme() != "https" && !local {
        bail!("remote_desktop_requires_https");
    }
    let path = url.path().trim_end_matches('/').to_owned();
    url.set_path(&path);
    Ok(url.as_str().trim_end_matches('/').into())
}

fn client() -> Result<reqwest::Client> {
    // Enrollment never follows a redirect carrying a deployment secret.
    Ok(crate::reqwest_client_builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()?)
}

pub fn load(directory: &Path) -> Result<Option<AccountSessionRecord>> {
    let record =
        remote_persistence::read_current_account_session(directory, &MachineBinding::current())?;
    if let Some(record) = &record {
        if record.user_id != SERVICE_PRINCIPAL
            || service_url(&record.relay_url)? != record.relay_url
            || record.device_id.is_none()
        {
            bail!("Remote desktop credential scope is invalid; stored data was retained");
        }
    }
    Ok(record)
}

pub fn enrolled(record: &AccountSessionRecord) -> bool {
    !record.token.starts_with(PENDING)
}

/// Persist the exact request identity before sending. A lost response or restart
/// retries the same enrollment instead of replacing an existing device/key.
pub async fn pair(
    directory: &Path,
    endpoint: &str,
    pairing_key: &str,
    name: &str,
) -> Result<AccountSessionRecord> {
    let endpoint = service_url(endpoint)?;
    if name.trim().is_empty() || name.len() > 256 || name.chars().any(char::is_control) {
        bail!("invalid_device_name");
    }
    let http = client()?;
    let info = http
        .get(format!("{endpoint}/api/info"))
        .send()
        .await
        .context("Remote desktop discovery unavailable")?;
    if !info.status().is_success() {
        bail!("remote_desktop_service_required");
    }
    #[derive(Deserialize)]
    struct Info {
        capabilities: Vec<String>,
    }
    let info: Info = info.json().await?;
    if !info
        .capabilities
        .iter()
        .any(|c| c == "remote_desktop_pairing_v1")
    {
        bail!("remote_desktop_service_required");
    }
    let mut record = match load(directory)? {
        Some(record) if record.relay_url == endpoint => record,
        Some(_) => bail!("Remote desktop service changed; existing credentials were retained"),
        None => AccountSessionRecord {
            token: format!("{PENDING}{}", uuid::Uuid::new_v4()),
            user_id: SERVICE_PRINCIPAL.into(),
            master_key: device_crypto::generate_secret(),
            relay_url: endpoint.clone(),
            device_id: Some(uuid::Uuid::new_v4().simple().to_string()),
        },
    };
    remote_persistence::write_current_account_session(
        directory,
        &MachineBinding::current(),
        &record,
    )?;
    let request_id = match record.token.strip_prefix(PENDING) {
        Some(pending) => uuid::Uuid::parse_str(pending)?,
        None => uuid::Uuid::parse_str(
            record
                .device_id
                .as_deref()
                .context("Missing remote desktop device identity")?,
        )?,
    }
    .to_string();
    let response = http
        .post(format!("{endpoint}/api/remote-desktop/pair"))
        .bearer_auth(pairing_key)
        .json(&serde_json::json!({
            "device_id":record.device_id, "device_name":name, "device_kind":"desktop",
            "public_key":device_crypto::public_key_base64(&record.master_key),
            "request_id":request_id,
        }))
        .send()
        .await
        .context("Remote desktop pairing delivery is unknown; retry the same service")?;
    if !response.status().is_success() {
        bail!(
            "{}",
            match response.status().as_u16() {
                401 | 403 => "remote_desktop_pairing_rejected",
                409 => "remote_desktop_device_conflict",
                429 => "remote_desktop_pairing_rate_limited",
                _ => "remote_desktop_pairing_unavailable",
            }
        );
    }
    #[derive(Deserialize)]
    struct Issued {
        token: String,
        user_id: String,
        device_id: String,
    }
    let issued: Issued = response.json().await?;
    if issued.user_id != SERVICE_PRINCIPAL
        || Some(&issued.device_id) != record.device_id.as_ref()
        || issued.token.is_empty()
        || issued.token.len() > 1024
        || issued.token.starts_with(PENDING)
    {
        bail!("invalid_pairing_response");
    }
    record.token = issued.token;
    remote_persistence::write_current_account_session(
        directory,
        &MachineBinding::current(),
        &record,
    )?;
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn self_hosted_urls_do_not_accept_official_login_endpoints_or_plaintext_public_servers() {
        for url in [
            openbitfun_product_domains::account::DEFAULT_RELAY_URL,
            "http://remote.example",
            "https://u:secret@example.test",
            "https://example.test/?token=x",
        ] {
            assert!(service_url(url).is_err(), "{url}");
        }
        assert_eq!(
            service_url("https://example.test/desktop/").unwrap(),
            "https://example.test/desktop"
        );
        assert_eq!(
            service_url("http://127.0.0.1:9701/").unwrap(),
            "http://127.0.0.1:9701"
        );
    }

    #[test]
    fn desktop_credentials_use_an_independent_encrypted_store_and_keep_unreadable_data() {
        let directory = tempfile::tempdir().unwrap();
        let login = directory.path().join("login");
        let desktop = directory.path().join("desktop");
        let record = AccountSessionRecord {
            token: "private-desktop-token".into(),
            user_id: SERVICE_PRINCIPAL.into(),
            relay_url: "https://self-hosted.example".into(),
            master_key: [7; 32],
            device_id: Some("a".repeat(32)),
        };
        remote_persistence::write_current_account_session(
            &desktop,
            &MachineBinding::current(),
            &record,
        )
        .unwrap();
        assert!(remote_persistence::read_current_account_session(
            &login,
            &MachineBinding::current()
        )
        .unwrap()
        .is_none());
        assert_eq!(load(&desktop).unwrap(), Some(record));
        let path = desktop.join("account_session.enc");
        std::fs::write(&path, "unreadable-kept-data").unwrap();
        assert!(load(&desktop).is_err());
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            "unreadable-kept-data"
        );
    }
}
