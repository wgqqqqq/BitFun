#![cfg(feature = "remote-ssh")]

use bitfun_services_integrations::remote_ssh::{
    RemoteWorkspace, SSHAuthMethod, SSHConnectionConfig, SavedAuthType, SavedConnection,
};

#[test]
fn remote_ssh_legacy_agent_auth_maps_to_default_private_key() {
    let config: SSHConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": "conn-1",
        "name": "dev",
        "host": "example.com",
        "port": 22,
        "username": "alice",
        "auth": { "type": "Agent" },
        "defaultWorkspace": "/repo"
    }))
    .unwrap();

    match config.auth {
        SSHAuthMethod::PrivateKey {
            key_path,
            passphrase,
        } => {
            assert_eq!(key_path, "~/.ssh/id_rsa");
            assert_eq!(passphrase, None);
        }
        SSHAuthMethod::Password { .. } => panic!("legacy agent auth must map to private key"),
    }

    let saved: SavedConnection = serde_json::from_value(serde_json::json!({
        "id": "conn-1",
        "name": "dev",
        "host": "example.com",
        "port": 22,
        "username": "alice",
        "authType": { "type": "Agent" },
        "defaultWorkspace": "/repo",
        "lastConnected": 1
    }))
    .unwrap();

    match saved.auth_type {
        SavedAuthType::PrivateKey { key_path } => assert_eq!(key_path, "~/.ssh/id_rsa"),
        SavedAuthType::Password => panic!("legacy agent auth type must map to private key"),
    }
}

#[test]
fn remote_workspace_defaults_keep_older_files_loadable() {
    let workspace: RemoteWorkspace = serde_json::from_value(serde_json::json!({
        "connectionId": "conn-1"
    }))
    .unwrap();

    assert_eq!(workspace.connection_id, "conn-1");
    assert_eq!(workspace.remote_path, "");
    assert_eq!(workspace.connection_name, "");
    assert_eq!(workspace.ssh_host, "");
}
