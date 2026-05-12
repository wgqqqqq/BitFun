//! MCP server data contracts.

/// MCP server type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MCPServerType {
    Local,
    Remote,
}

/// MCP server status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MCPServerStatus {
    Uninitialized,
    Starting,
    Connected,
    Healthy,
    NeedsAuth,
    Reconnecting,
    Failed,
    Stopping,
    Stopped,
}
