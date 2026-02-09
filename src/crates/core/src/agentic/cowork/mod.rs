//! Cowork - multi-agent collaboration for daily work
//!
//! This module provides a platform-agnostic orchestration layer inspired by eigent's
//! "workforce" concept: decompose -> edit/approve -> assign/schedule -> visualize.
//!
//! Transport/UI integration is done via custom events (`cowork://...`) emitted through
//! the existing BackendEventSystem (see `crate::infrastructure::events`).

pub mod manager;
pub mod planning;
pub mod scheduler;
pub mod types;

pub use manager::{get_global_cowork_manager, CoworkManager};
pub use types::*;

