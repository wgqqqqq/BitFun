//! Workspace service module
//!
//! Full workspace management system: open, manage, scan, statistics, etc.

pub mod context_generator;
pub mod factory;
pub mod manager;
pub mod provider;
pub mod service;

// Re-export main components
pub use context_generator::{
    ContextGenerationOptions, ContextLanguage, GeneratedWorkspaceContext,
    GitInfo as ContextGitInfo, WorkspaceContextGenerator,
    WorkspaceStatistics as ContextWorkspaceStatistics,
};
pub use factory::WorkspaceFactory;
pub use manager::{
    GitInfo, ScanOptions, WorkspaceInfo, WorkspaceManager, WorkspaceManagerConfig,
    WorkspaceManagerStatistics, WorkspaceStatistics, WorkspaceStatus, WorkspaceSummary,
    WorkspaceType,
};
pub use provider::{WorkspaceCleanupResult, WorkspaceProvider, WorkspaceSystemSummary};
pub use service::{
    get_global_workspace_service, set_global_workspace_service, BatchImportResult,
    BatchRemoveResult, WorkspaceCreateOptions, WorkspaceExport, WorkspaceHealthStatus,
    WorkspaceImportResult, WorkspaceInfoUpdates, WorkspaceQuickSummary, WorkspaceService,
};
