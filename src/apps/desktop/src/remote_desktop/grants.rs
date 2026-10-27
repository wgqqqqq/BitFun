//! Local-only device grants. Preserve unknown fields and unreadable/newer files.
use anyhow::{anyhow, bail, Context, Result};
use openbitfun_product_domains::remote_desktop::{ViewGrant, ViewGrantFile};
use serde_json::Value;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAX_BYTES: usize = 256 * 1024;

pub(super) struct GrantStore {
    path: PathBuf,
    original: Option<Vec<u8>>,
    document: Value,
    grants: ViewGrantFile,
}

fn read(path: &Path) -> Result<Option<Vec<u8>>> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !file.metadata()?.is_file() {
        bail!("Remote desktop grants are not a regular file");
    }
    let mut bytes = Vec::new();
    file.take((MAX_BYTES + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > MAX_BYTES {
        bail!("Remote desktop grants exceed the storage limit");
    }
    Ok(Some(bytes))
}

impl GrantStore {
    pub(super) fn load(path: PathBuf) -> Result<Self> {
        let original = read(&path)?;
        let document = match &original {
            Some(bytes) => {
                serde_json::from_slice(bytes).context("Remote desktop grants are unreadable")?
            }
            None => serde_json::to_value(ViewGrantFile::default())?,
        };
        let grants: ViewGrantFile = serde_json::from_value(document.clone())?;
        if !grants.supported() {
            bail!("Remote desktop grant schema is unsupported");
        }
        if !document.is_object() {
            bail!("Remote desktop grant document is not an object");
        }
        Ok(Self {
            path,
            original,
            document,
            grants,
        })
    }

    pub(super) fn snapshot(&self) -> ViewGrantFile {
        self.grants.clone()
    }

    /// Caller holds the host's serial owner. Identity/scope must already have
    /// been resolved by the native local approval path.
    pub(super) fn approve(&mut self, grant: ViewGrant) -> Result<ViewGrantFile> {
        let mut next = self.document.clone();
        let entries = next
            .as_object_mut()
            .ok_or_else(|| anyhow!("Invalid grants"))?
            .entry("grants")
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or_else(|| anyhow!("Invalid grants"))?;
        let identity = |entry: &&mut Value| {
            entry["account_id"] == grant.account_id
                && entry["device_id"] == grant.device_id
                && entry["public_key_fingerprint"] == grant.public_key_fingerprint
        };
        let fields = serde_json::to_value(&grant)?;
        if let Some(entry) = entries.iter_mut().find(identity) {
            // Merge known fields; a newer writer's extra fields survive.
            entry
                .as_object_mut()
                .ok_or_else(|| anyhow!("Invalid grant"))?
                .extend(fields.as_object().unwrap().clone());
        } else {
            entries.push(fields);
        }
        // A newly confirmed key replaces trust for that device. A directory
        // rollback must not silently reactivate its previously approved key.
        entries.retain(|entry| {
            !(entry["account_id"] == grant.account_id
                && entry["device_id"] == grant.device_id
                && entry["public_key_fingerprint"] != grant.public_key_fingerprint)
        });
        self.persist(next)
    }

    pub(super) fn revoke(&mut self, account: &str, device: &str) -> Result<ViewGrantFile> {
        let mut next = self.document.clone();
        if let Some(entries) = next.get_mut("grants").and_then(Value::as_array_mut) {
            entries
                .retain(|entry| !(entry["account_id"] == account && entry["device_id"] == device));
        }
        self.persist(next)
    }

    fn persist(&mut self, document: Value) -> Result<ViewGrantFile> {
        let grants: ViewGrantFile = serde_json::from_value(document.clone())?;
        let bytes = serde_json::to_vec_pretty(&document)?;
        if bytes.len() > MAX_BYTES {
            bail!("Remote desktop grants exceed the storage limit");
        }
        if read(&self.path)? != self.original {
            bail!("Remote desktop grants changed externally; reload before editing");
        }
        let parent = self
            .path
            .parent()
            .ok_or_else(|| anyhow!("Invalid grant path"))?;
        fs::create_dir_all(parent)?;
        let mut staged = tempfile::NamedTempFile::new_in(parent)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            staged
                .as_file()
                .set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        staged.write_all(&bytes)?;
        staged.as_file().sync_all()?;
        staged.persist(&self.path).map_err(|error| error.error)?;
        self.original = Some(bytes);
        self.document = document;
        self.grants = grants.clone();
        Ok(grants)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant() -> ViewGrant {
        ViewGrant {
            account_id: "account".into(),
            device_id: "phone".into(),
            public_key_fingerprint: "a".repeat(64),
            display_ids: vec!["display:1".into()],
            control_display_ids: Vec::new(),
        }
    }

    #[test]
    fn remote_desktop_grants_preserve_unknown_fields_and_other_accounts() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("view-grants.json");
        let mut existing = serde_json::to_value(grant()).unwrap();
        existing["future"] = serde_json::json!({"value":7});
        let mut other = existing.clone();
        other["account_id"] = "other".into();
        fs::write(
            &path,
            serde_json::to_vec(
                &serde_json::json!({"version":1,"future_root":[1,2],"grants":[existing,other]}),
            )
            .unwrap(),
        )
        .unwrap();
        let mut store = GrantStore::load(path.clone()).unwrap();
        let mut updated = grant();
        updated.display_ids = vec!["display:2".into()];
        assert_eq!(store.approve(updated).unwrap().grants.len(), 2);
        let written: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(written["future_root"], serde_json::json!([1, 2]));
        assert_eq!(written["grants"][0]["future"]["value"], 7);
        assert_eq!(store.revoke("account", "phone").unwrap().grants.len(), 1);
        assert_eq!(
            GrantStore::load(path.clone()).unwrap().snapshot().grants[0].account_id,
            "other"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn remote_desktop_new_key_approval_retires_the_previous_key_for_that_device() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("grants.json");
        let mut store = GrantStore::load(path.clone()).unwrap();
        store.approve(grant()).unwrap();
        let mut replacement = grant();
        replacement.public_key_fingerprint = "b".repeat(64);
        let grants = store.approve(replacement.clone()).unwrap();
        assert_eq!(grants.grants, vec![replacement.clone()]);
        assert_eq!(
            GrantStore::load(path).unwrap().snapshot().grants,
            vec![replacement]
        );
    }

    #[test]
    fn remote_desktop_control_scope_survives_reload_and_view_only_confirmation_removes_it() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("grants.json");
        let mut store = GrantStore::load(path.clone()).unwrap();
        let mut control = grant();
        control.control_display_ids = control.display_ids.clone();
        store.approve(control.clone()).unwrap();
        let mut reloaded = GrantStore::load(path.clone()).unwrap();
        assert_eq!(reloaded.snapshot().grants, vec![control]);
        // Empty control scope MUST serialize; skipping it would preserve old
        // input authority when known fields are merged for the same key.
        reloaded.approve(grant()).unwrap();
        assert!(GrantStore::load(path.clone()).unwrap().snapshot().grants[0]
            .control_display_ids
            .is_empty());
        let written: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            written["grants"][0]["control_display_ids"],
            serde_json::json!([])
        );
    }

    #[test]
    fn remote_desktop_revoke_and_key_replacement_never_restore_a_previous_control_scope() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("grants.json");
        let mut store = GrantStore::load(path.clone()).unwrap();
        let mut control = grant();
        control.control_display_ids = control.display_ids.clone();
        store.approve(control).unwrap();
        let mut replacement = grant();
        replacement.public_key_fingerprint = "b".repeat(64);
        store.approve(replacement).unwrap();
        let snapshot = GrantStore::load(path.clone()).unwrap().snapshot();
        assert_eq!(snapshot.grants.len(), 1);
        assert!(snapshot.grants[0].control_display_ids.is_empty());
        store.revoke("account", "phone").unwrap();
        store.approve(grant()).unwrap();
        assert!(GrantStore::load(path).unwrap().snapshot().grants[0]
            .control_display_ids
            .is_empty());
    }

    #[test]
    fn remote_desktop_grants_never_reset_unreadable_future_or_changed_data() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("grants.json");
        for bytes in [
            b"not-json".as_slice(),
            br#"{"version":2,"grants":[],"future":true}"#,
            br#"{"version":1,"grants":[null]}"#,
        ] {
            fs::write(&path, bytes).unwrap();
            assert!(GrantStore::load(path.clone()).is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
        fs::remove_file(&path).unwrap();
        let mut store = GrantStore::load(path.clone()).unwrap();
        assert!(store.snapshot().grants.is_empty());
        fs::write(&path, b"externally replaced").unwrap();
        assert!(store.approve(grant()).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"externally replaced");
    }

    #[cfg(unix)]
    #[test]
    fn remote_desktop_grants_refuse_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("other");
        fs::write(&target, b"{}").unwrap();
        let path = root.path().join("grants.json");
        std::os::unix::fs::symlink(&target, &path).unwrap();
        assert!(GrantStore::load(path).is_err());
        assert_eq!(fs::read(target).unwrap(), b"{}");
    }
}
