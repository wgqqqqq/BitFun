//! Explicit, one-shot developer validation of external workspace access.
//!
//! This answers what the sandbox rules alone cannot: whether an authorized
//! directory behaves like an ordinary path for the product - in-process file
//! IO, and child processes that inherit the grant. A grant that only works
//! in-process cannot carry the agent's shell, git or tooling.
use super::workspace_access::{self, AuthorizedDirectory};
use std::path::{Path, PathBuf};

static REQUESTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn request(enabled: bool) {
    REQUESTED.store(enabled, std::sync::atomic::Ordering::Release);
}

/// Where the authorized URI is remembered, so a later run proves persistence.
fn remembered_grant_file() -> Option<PathBuf> {
    let home = std::env::var("OPENBITFUN_HOME").ok()?;
    Some(PathBuf::from(home).join("harmony-workspace-grant.json"))
}

pub fn run_if_requested() {
    if !REQUESTED.swap(false, std::sync::atomic::Ordering::AcqRel) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        log::info!("HarmonyOS workspace access diagnostic started");
        match workspace_access::capability().await {
            Ok(capability) => log::info!(
                "HarmonyOS workspace access capability: folder_authorization={} folder_selection={}",
                capability.folder_authorization,
                capability.folder_selection
            ),
            Err(error) => {
                log::warn!("HarmonyOS workspace access capability probe failed: {error}");
                return;
            }
        }
        report_home();
        report_unauthorized_baseline();
        check_startup_grant();
        let directory = match acquire_directory().await {
            Some(directory) => directory,
            None => {
                log::warn!(
                    "HarmonyOS workspace access diagnostic stopped: no authorized directory"
                );
                return;
            }
        };
        log::info!(
            "HarmonyOS workspace authorized: uri={} path={}",
            directory.uri,
            directory.path
        );
        remember(&directory);
        let root = PathBuf::from(&directory.path);
        check_in_process(&root);
        check_child_process(&root);
    });
}

/// The process home, and the home a child actually sees.
///
/// The system hands the application a HOME outside the sandbox; the Ability
/// replaces it. Tooling only benefits if the replacement is what a child
/// process inherits, so report both rather than just the in-process value.
fn report_home() {
    let home = std::env::var("HOME").unwrap_or_else(|_| "<unset>".into());
    let readable = std::fs::read_dir(&home).is_ok();
    log::info!("HarmonyOS process home: path={home} readable={readable}");
    match std::process::Command::new("/system/bin/sh")
        .arg("-c")
        .arg("printf '%s' \"$HOME\"")
        .stdin(std::process::Stdio::null())
        .output()
    {
        Ok(output) => {
            let child = String::from_utf8_lossy(&output.stdout).trim().to_string();
            log::info!(
                "HarmonyOS child process home: path={child} inherited={}",
                child == home
            );
        }
        Err(error) => log::warn!("HarmonyOS child process home could not be read: {error}"),
    }
}

/// Baseline: what the sandbox exposes before any grant exists.
fn report_unauthorized_baseline() {
    for candidate in [
        "/storage/Users/currentUser",
        "/storage/Users/currentUser/Documents",
        "/storage/Users/currentUser/Desktop",
        "/storage/Users/currentUser/Download",
    ] {
        match std::fs::read_dir(candidate) {
            Ok(entries) => log::info!(
                "HarmonyOS unauthorized baseline: {candidate} listed {} entries",
                entries.count()
            ),
            Err(error) => log::info!(
                "HarmonyOS unauthorized baseline: {candidate} denied ({})",
                error.kind()
            ),
        }
    }
}

/// Does a grant restored at startup - one this code never activated - reach a
/// child process? That is the path the agent's shell, git and tooling take, and
/// nothing in the product reactivates a workspace per run, so a "no" here means
/// tooling can only ever see the sandbox.
fn check_startup_grant() {
    for candidate in [
        "/storage/Users/currentUser/Documents",
        "/storage/Users/currentUser/Documents/obf-new-project",
    ] {
        let Some(quoted) = shell_quote(Path::new(candidate)) else {
            continue;
        };
        // The probe file is removed again; a diagnostic must not litter a user directory.
        let script = format!(
            "cd {quoted} || exit 91; ls -la . > /dev/null 2>&1 || exit 92; \
             printf 'OBF_STARTUP_OK' > obf-startup-probe.txt 2>/dev/null || exit 93; \
             cat obf-startup-probe.txt || exit 94; rm -f obf-startup-probe.txt"
        );
        match std::process::Command::new("/system/bin/sh")
            .arg("-c")
            .arg(&script)
            .stdin(std::process::Stdio::null())
            .output()
        {
            Ok(output) => log::info!(
                "HarmonyOS startup grant in a child process: path={candidate} status={:?} inherited={} stderr={:?}",
                output.status.code(),
                String::from_utf8_lossy(&output.stdout).contains("OBF_STARTUP_OK"),
                String::from_utf8_lossy(&output.stderr).trim()
            ),
            Err(error) => {
                log::warn!("HarmonyOS startup grant child could not start: {candidate}: {error}")
            }
        }
    }
}

/// Reactivate a remembered grant when present; otherwise ask the user once.
async fn acquire_directory() -> Option<AuthorizedDirectory> {
    if let Some(uri) = remembered_uri() {
        log::info!("HarmonyOS workspace grant remembered from an earlier run: uri={uri}");
        match workspace_access::activate(vec![uri.clone()], true).await {
            Ok(directories) => {
                if let Some(directory) = directories.into_iter().next() {
                    log::info!("HarmonyOS workspace grant survived the restart and reactivated");
                    return Some(directory);
                }
                log::warn!("HarmonyOS workspace grant reactivation returned no directory");
            }
            Err(error) => log::warn!("HarmonyOS workspace grant reactivation failed: {error}"),
        }
    }
    log::info!("HarmonyOS workspace access diagnostic is requesting a folder from the user");
    match workspace_access::pick_folder(true).await {
        Ok(directories) => directories.into_iter().next(),
        Err(error) => {
            log::warn!("HarmonyOS workspace folder selection failed: {error}");
            None
        }
    }
}

fn remembered_uri() -> Option<String> {
    let raw = std::fs::read_to_string(remembered_grant_file()?).ok()?;
    let directory: AuthorizedDirectory = serde_json::from_str(&raw).ok()?;
    Some(directory.uri)
}

fn remember(directory: &AuthorizedDirectory) {
    let Some(path) = remembered_grant_file() else {
        return;
    };
    match serde_json::to_string(directory).map(|raw| std::fs::write(&path, raw)) {
        Ok(Ok(())) => log::info!("HarmonyOS workspace grant stored for the next run"),
        result => log::warn!("HarmonyOS workspace grant could not be stored: {result:?}"),
    }
}

/// In-process file IO on the authorized directory.
fn check_in_process(root: &Path) {
    match std::fs::read_dir(root) {
        Ok(entries) => {
            let names: Vec<String> = entries
                .filter_map(|entry| Some(entry.ok()?.file_name().to_string_lossy().into_owned()))
                .take(12)
                .collect();
            log::info!("HarmonyOS workspace read_dir succeeded: entries={names:?}");
        }
        Err(error) => log::warn!("HarmonyOS workspace read_dir failed: {error}"),
    }
    let nested = root.join("obf-access-probe");
    if let Err(error) = std::fs::create_dir_all(&nested) {
        log::warn!("HarmonyOS workspace create_dir failed: {error}");
        return;
    }
    let file = nested.join("in-process.txt");
    match std::fs::write(&file, b"OBF_IN_PROCESS_OK") {
        Ok(()) => match std::fs::read_to_string(&file) {
            Ok(content) => log::info!(
                "HarmonyOS workspace in-process write/read: marker={}",
                content == "OBF_IN_PROCESS_OK"
            ),
            Err(error) => log::warn!("HarmonyOS workspace in-process read failed: {error}"),
        },
        Err(error) => log::warn!("HarmonyOS workspace in-process write failed: {error}"),
    }
    // A rename inside the directory is what editors and git both depend on.
    let renamed = nested.join("in-process-renamed.txt");
    match std::fs::rename(&file, &renamed) {
        Ok(()) => log::info!("HarmonyOS workspace in-process rename succeeded"),
        Err(error) => log::warn!("HarmonyOS workspace in-process rename failed: {error}"),
    }
}

/// The decisive check: does a child process inherit the directory grant?
fn check_child_process(root: &Path) {
    let Some(quoted) = shell_quote(root) else {
        log::warn!("HarmonyOS workspace path is not safe to pass to a shell: {root:?}");
        return;
    };
    let script = format!(
        "cd {quoted} || exit 91; ls -la . > /dev/null 2>&1 || exit 92; \
         printf 'OBF_CHILD_OK' > obf-access-probe/child.txt 2>/dev/null || exit 93; \
         cat obf-access-probe/child.txt 2>/dev/null || exit 94"
    );
    let child = std::process::Command::new("/system/bin/sh")
        .arg("-c")
        .arg(&script)
        .stdin(std::process::Stdio::null())
        .output();
    match child {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            log::info!(
                "HarmonyOS workspace child process: status={:?} inherited_grant={} stdout={:?} stderr={:?}",
                output.status.code(),
                stdout.contains("OBF_CHILD_OK"),
                stdout.trim(),
                stderr.trim()
            );
        }
        Err(error) => log::warn!("HarmonyOS workspace child process could not start: {error}"),
    }
    // Separate the grant from the working directory: a child may inherit one
    // without the other, and the agent needs both.
    let listing = std::process::Command::new("/system/bin/sh")
        .arg("-c")
        .arg(format!("ls -la {quoted}"))
        .current_dir(std::env::temp_dir())
        .stdin(std::process::Stdio::null())
        .output();
    match listing {
        Ok(output) => log::info!(
            "HarmonyOS workspace child listing from an unrelated cwd: status={:?} bytes={} stderr={:?}",
            output.status.code(),
            output.stdout.len(),
            String::from_utf8_lossy(&output.stderr).trim()
        ),
        Err(error) => log::warn!("HarmonyOS workspace child listing could not start: {error}"),
    }
}

/// Only single-quote paths that cannot terminate the quoting.
fn shell_quote(path: &Path) -> Option<String> {
    let path = path.to_str()?;
    (!path.contains('\'') && !path.contains('\n')).then(|| format!("'{path}'"))
}
