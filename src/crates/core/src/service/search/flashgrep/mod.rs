mod client;
pub mod error;
mod protocol;
mod repo_session;
mod rpc_client;
mod types;

pub(crate) use client::{ManagedClient, RepoSession};
pub(crate) use protocol::{
    ClientCapabilities, ClientInfo, FileMatch, GlobParams, InitializeParams, MatchLocation,
    RepoRef, Request, Response, SearchHit, SearchLine, SearchParams, TaskRef,
};
pub(crate) use repo_session::FlashgrepRepoSession;
pub(crate) use rpc_client::{drain_content_length_messages, ProtocolClient};
pub(crate) use types::{
    ConsistencyMode, DirtyFileStats, FileCount, GlobOutcome, GlobRequest, OpenRepoParams,
    PathScope, QuerySpec, RefreshPolicyConfig, RepoConfig, RepoPhase, RepoStatus, SearchBackend,
    SearchModeConfig, SearchOutcome, SearchRequest, SearchResults, TaskKind, TaskPhase, TaskState,
    TaskStatus, WorkspaceOverlayStatus,
};
