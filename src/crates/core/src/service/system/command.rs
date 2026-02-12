//! System command utilities
//!
//! Provides command detection and execution.

use crate::util::process_manager;
use log::error;

/// Command check result
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CheckCommandResult {
    /// Whether the command exists
    pub exists: bool,
    /// Full path to the command (if it exists)
    pub path: Option<String>,
}

/// Command execution result
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CommandOutput {
    /// Exit code
    pub exit_code: i32,
    /// Stdout
    pub stdout: String,
    /// Stderr
    pub stderr: String,
    /// Whether the command succeeded (`exit_code == 0`)
    pub success: bool,
}

/// System command error
#[derive(Debug, thiserror::Error)]
pub enum SystemError {
    #[error("Command execution failed: {0}")]
    ExecutionFailed(String),

    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("Command not found: {0}")]
    CommandNotFound(String),
}

/// Checks whether a command exists.
///
/// Uses the `which` crate for cross-platform command detection.
///
/// # Parameters
/// - `cmd`: Command name (e.g. "git", "npm", "cargo")
///
/// # Returns
/// - `CheckCommandResult`: Contains existence and full path
///
/// # Example
/// ```rust
/// let result = check_command("git");
/// if result.exists {
///     if let Some(path) = result.path.as_deref() {
///         println!("Git path: {}", path);
///     }
/// }
/// ```
pub fn check_command(cmd: &str) -> CheckCommandResult {
    match which::which(cmd) {
        Ok(path) => CheckCommandResult {
            exists: true,
            path: Some(path.to_string_lossy().to_string()),
        },
        Err(_) => CheckCommandResult {
            exists: false,
            path: None,
        },
    }
}

/// Checks multiple commands in batch.
///
/// # Parameters
/// - `commands`: List of command names
///
/// # Returns
/// - `Vec<(String, CheckCommandResult)>`: List of command names and results
pub fn check_commands(commands: &[&str]) -> Vec<(String, CheckCommandResult)> {
    commands
        .iter()
        .map(|cmd| (cmd.to_string(), check_command(cmd)))
        .collect()
}

/// Runs a system command.
///
/// # Parameters
/// - `cmd`: Command name
/// - `args`: Command arguments
/// - `cwd`: Working directory (optional)
/// - `env`: Environment variables (optional)
///
/// # Returns
/// - `Result<CommandOutput, SystemError>`: Command output or error
pub async fn run_command(
    cmd: &str,
    args: &[String],
    cwd: Option<&str>,
    env: Option<&[(String, String)]>,
) -> Result<CommandOutput, SystemError> {
    let mut command = process_manager::create_tokio_command(cmd);

    command.args(args);

    if let Some(dir) = cwd {
        command.current_dir(dir);
    }

    if let Some(env_vars) = env {
        for (key, value) in env_vars {
            command.env(key, value);
        }
    }

    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    let output = command.output().await.map_err(|e| {
        error!("Command execution failed: command={}, error={}", cmd, e);
        SystemError::ExecutionFailed(e.to_string())
    })?;

    let exit_code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let success = output.status.success();

    Ok(CommandOutput {
        exit_code,
        stdout,
        stderr,
        success,
    })
}

/// Runs a system command (simplified version, without environment variables).
pub async fn run_command_simple(
    cmd: &str,
    args: &[String],
    cwd: Option<&str>,
) -> Result<CommandOutput, SystemError> {
    run_command(cmd, args, cwd, None).await
}
