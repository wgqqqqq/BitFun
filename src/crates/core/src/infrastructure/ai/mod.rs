//! AI infrastructure
//!
//! Provides AI clients and related services

pub mod client_factory;
pub mod tool_call_accumulator;

pub use bitfun_ai_adapters::providers;
pub use bitfun_ai_adapters::stream as ai_stream_handlers;

pub use bitfun_ai_adapters::{AIClient, StreamResponse};
pub use client_factory::{
    get_global_ai_client_factory, initialize_global_ai_client_factory, AIClientFactory,
};
