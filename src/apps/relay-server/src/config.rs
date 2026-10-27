//! Relay server configuration.

use anyhow::Context;
use std::net::SocketAddr;

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(super) struct RelayConfig {
    pub listen_addr: SocketAddr,
    pub heartbeat_interval_secs: u64,
    pub heartbeat_timeout_secs: u64,
    pub static_dir: Option<String>,
    /// Directory for published Page assets.
    pub asset_dir: String,
    /// Global capacity for content-addressed Page assets.
    pub asset_store_max_bytes: u64,
    pub cors_allow_origins: Vec<String>,
    /// Browser-visible base URL used for published Page content.
    pub page_public_base_url: Option<String>,
    /// Browser-visible base URL used for trusted Relay Page login.
    pub page_auth_base_url: Option<String>,
    /// Path to the SQLite database file used for account storage.
    /// Required at startup; every device connection is account-authenticated.
    pub db_path: Option<String>,
    pub remote_desktop_turn: Option<openbitfun_relay_service::RemoteDesktopTurnConfig>,
    pub remote_desktop_pairing: Option<openbitfun_relay_service::RemoteDesktopPairingConfig>,
}

impl Default for RelayConfig {
    fn default() -> Self {
        Self {
            listen_addr: ([0, 0, 0, 0], 9700).into(),
            heartbeat_interval_secs: 30,
            heartbeat_timeout_secs: 90,
            static_dir: None,
            // Also stores published OpenBitFun Pages under `{asset_dir}/pages/{user_id}/{slug}/`.
            asset_dir: "/tmp/openbitfun-room-web".to_string(),
            asset_store_max_bytes: openbitfun_relay_service::DEFAULT_DISK_ASSET_STORE_MAX_BYTES,
            cors_allow_origins: Vec::new(),
            page_public_base_url: None,
            page_auth_base_url: None,
            db_path: None,
            remote_desktop_turn: None,
            remote_desktop_pairing: None,
        }
    }
}

impl RelayConfig {
    pub(super) fn from_env() -> anyhow::Result<Self> {
        let mut cfg = Self::default();
        if let Ok(port) = std::env::var("RELAY_PORT") {
            if let Ok(p) = port.parse::<u16>() {
                cfg.listen_addr = ([0, 0, 0, 0], p).into();
            }
        }
        if let Ok(addr) = std::env::var("RELAY_LISTEN_ADDR") {
            cfg.listen_addr = addr
                .parse()
                .context("RELAY_LISTEN_ADDR must be an IP socket address")?;
        }
        if let Ok(dir) = std::env::var("RELAY_STATIC_DIR") {
            cfg.static_dir = (!dir.trim().is_empty()).then_some(dir);
        }
        // Keep the previous storage location readable during upgrades.
        if let Ok(dir) =
            std::env::var("RELAY_ASSET_DIR").or_else(|_| std::env::var("RELAY_ROOM_WEB_DIR"))
        {
            cfg.asset_dir = dir;
        }
        if let Ok(limit) = std::env::var("RELAY_ASSET_STORE_MAX_BYTES") {
            if let Ok(bytes) = limit.parse::<u64>() {
                cfg.asset_store_max_bytes = bytes;
            }
        }
        if let Ok(path) = std::env::var("RELAY_DB_PATH") {
            if path.is_empty() {
                cfg.db_path = None;
            } else {
                cfg.db_path = Some(path);
            }
        }
        if let Ok(origins) = std::env::var("RELAY_CORS_ALLOW_ORIGINS") {
            cfg.cors_allow_origins = origins
                .split(',')
                .map(str::trim)
                .filter(|origin| !origin.is_empty())
                .map(str::to_string)
                .collect();
        }
        cfg.page_public_base_url = std::env::var("RELAY_PAGE_PUBLIC_BASE_URL")
            .ok()
            .filter(|value| !value.trim().is_empty());
        cfg.page_auth_base_url = std::env::var("RELAY_PAGE_AUTH_BASE_URL")
            .ok()
            .filter(|value| !value.trim().is_empty());
        cfg.remote_desktop_turn = turn_config(
            std::env::var("RELAY_REMOTE_DESKTOP_TURN_URLS")
                .ok()
                .as_deref(),
            std::env::var("RELAY_REMOTE_DESKTOP_TURN_SECRET_FILE")
                .ok()
                .as_deref(),
        )?;
        cfg.remote_desktop_pairing = std::env::var("REMOTE_DESKTOP_PAIRING_KEY_FILE")
            .ok()
            .map(|path| {
                read_private_secret(&path).and_then(|key| {
                    openbitfun_relay_service::RemoteDesktopPairingConfig::new(&key)
                        .map_err(anyhow::Error::msg)
                })
            })
            .transpose()?;
        if cfg.remote_desktop_pairing.is_none() && cfg.remote_desktop_turn.is_some() {
            anyhow::bail!("TURN configuration requires an independent remote desktop service (REMOTE_DESKTOP_PAIRING_KEY_FILE)");
        }
        if cfg.remote_desktop_pairing.is_some()
            && (cfg.page_public_base_url.is_some()
                || cfg.page_auth_base_url.is_some()
                || cfg.static_dir.is_some())
        {
            anyhow::bail!(
                "The remote desktop service cannot host account login or published Pages"
            );
        }
        Ok(cfg)
    }
}

fn read_private_secret(path: &str) -> anyhow::Result<String> {
    let metadata = std::fs::symlink_metadata(path)
        .context("Cannot inspect remote desktop pairing key file")?;
    if !metadata.is_file() || metadata.len() > 258 {
        anyhow::bail!("Pairing key must be a small regular file");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            anyhow::bail!("Pairing key file must not be readable by group/others");
        }
    }
    let key =
        std::fs::read_to_string(path).context("Cannot read remote desktop pairing key file")?;
    Ok(key.trim_end_matches(['\r', '\n']).into())
}

fn turn_config(
    urls: Option<&str>,
    secret_file: Option<&str>,
) -> anyhow::Result<Option<openbitfun_relay_service::RemoteDesktopTurnConfig>> {
    match (urls, secret_file) {
        (None, None) => Ok(None),
        (Some(urls), Some(path)) => {
            let metadata = std::fs::symlink_metadata(path).context("Cannot inspect TURN secret file")?;
            if !metadata.is_file() || metadata.len() > 258 { anyhow::bail!("TURN secret must be a small regular file"); }
            #[cfg(unix)] {
                use std::os::unix::fs::PermissionsExt;
                if metadata.permissions().mode() & 0o077 != 0 { anyhow::bail!("TURN secret file must not be readable by group/others"); }
            }
            let secret = std::fs::read_to_string(path).context("Cannot read TURN secret file")?;
            let config = openbitfun_relay_service::RemoteDesktopTurnConfig::new(
                urls.split(',').map(str::trim).map(str::to_string).collect(),
                secret.trim_end_matches(['\r', '\n']).into(),
            ).map_err(anyhow::Error::msg)?;
            Ok(Some(config))
        }
        _ => anyhow::bail!("RELAY_REMOTE_DESKTOP_TURN_URLS and RELAY_REMOTE_DESKTOP_TURN_SECRET_FILE must be configured together"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_desktop_turn_is_opt_in_and_requires_a_private_secret_file() {
        assert!(turn_config(None, None).unwrap().is_none());
        assert!(turn_config(Some("turn:host:3478"), None).is_err());
        assert!(turn_config(None, Some("missing")).is_err());
        let path = std::env::temp_dir().join(format!(
            "openbitfun-turn-config-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
        let _cleanup = Cleanup(path.clone());
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let secret = "fixture-material-not-used-for-deployment";
        use std::io::Write;
        writeln!(options.open(&path).unwrap(), "{secret}").unwrap();
        let config = turn_config(Some("turn:host:3478?transport=udp"), path.to_str())
            .unwrap()
            .unwrap();
        assert!(!format!("{config:?}").contains(secret));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert!(turn_config(Some("turn:host:3478"), path.to_str()).is_err());
        }
    }
}
