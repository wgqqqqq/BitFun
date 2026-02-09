//! Agentic Module
//!
//! Core AI Agent service system

// Core module
pub mod core;
pub mod events;
pub mod persistence;

// Session management module
pub mod session;

// Execution engine module
pub mod execution;

// Tools module
pub mod tools;

// Coordination module
pub mod coordination;

// Cowork multi-agent collaboration
pub mod cowork;

// Image analysis module
pub mod image_analysis;

// Agents module
pub mod agents;

mod util;

pub use agents::*;
pub use coordination::*;
pub use core::*;
pub use events::{queue, router, types as event_types};
pub use execution::*;
pub use image_analysis::{ImageAnalyzer, MessageEnhancer};
pub use persistence::PersistenceManager;
pub use session::*;
