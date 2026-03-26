//! Message History Manager
//!
//! Manages in-memory session message history.

use crate::agentic::core::Message;
use crate::util::errors::BitFunResult;
use dashmap::DashMap;
use log::debug;
use std::sync::Arc;

/// Message history manager
pub struct MessageHistoryManager {
    /// Message history in memory (by session ID)
    histories: Arc<DashMap<String, Vec<Message>>>,
}

impl MessageHistoryManager {
    pub fn new() -> Self {
        Self {
            histories: Arc::new(DashMap::new()),
        }
    }

    /// Create session history
    pub async fn create_session(&self, session_id: &str) -> BitFunResult<()> {
        self.histories.insert(session_id.to_string(), vec![]);
        debug!("Created session history: session_id={}", session_id);
        Ok(())
    }

    /// Add message
    pub async fn add_message(&self, session_id: &str, message: Message) -> BitFunResult<()> {
        if let Some(mut messages) = self.histories.get_mut(session_id) {
            messages.push(message);
        } else {
            self.histories.insert(session_id.to_string(), vec![message]);
        }
        Ok(())
    }

    /// Get message history
    pub async fn get_messages(&self, session_id: &str) -> BitFunResult<Vec<Message>> {
        if let Some(messages) = self.histories.get(session_id) {
            return Ok(messages.clone());
        }
        Ok(vec![])
    }

    /// Get paginated message history
    pub async fn get_messages_paginated(
        &self,
        session_id: &str,
        limit: usize,
        before_message_id: Option<&str>,
    ) -> BitFunResult<(Vec<Message>, bool)> {
        let messages = self.get_messages(session_id).await?;

        if messages.is_empty() {
            return Ok((vec![], false));
        }

        let end_idx = if let Some(before_id) = before_message_id {
            messages.iter().position(|m| m.id == before_id).unwrap_or(0)
        } else {
            messages.len()
        };

        if end_idx == 0 {
            return Ok((vec![], false));
        }

        let start_idx = end_idx.saturating_sub(limit);
        let has_more = start_idx > 0;

        Ok((messages[start_idx..end_idx].to_vec(), has_more))
    }

    /// Get recent N messages
    pub async fn get_recent_messages(
        &self,
        session_id: &str,
        count: usize,
    ) -> BitFunResult<Vec<Message>> {
        let messages = self.get_messages(session_id).await?;
        let start = messages.len().saturating_sub(count);
        Ok(messages[start..].to_vec())
    }

    /// Get message count
    pub async fn count_messages(&self, session_id: &str) -> usize {
        if let Some(messages) = self.histories.get(session_id) {
            messages.len()
        } else {
            0
        }
    }

    /// Clear message history
    pub async fn clear_messages(&self, session_id: &str) -> BitFunResult<()> {
        if let Some(mut messages) = self.histories.get_mut(session_id) {
            messages.clear();
        }

        debug!("Cleared session message history: session_id={}", session_id);
        Ok(())
    }

    /// Delete session
    pub async fn delete_session(&self, session_id: &str) -> BitFunResult<()> {
        self.histories.remove(session_id);

        debug!("Deleted session history: session_id={}", session_id);
        Ok(())
    }

    /// Restore session into the in-memory cache.
    pub async fn restore_session(
        &self,
        session_id: &str,
        messages: Vec<Message>,
    ) -> BitFunResult<()> {
        self.histories.insert(session_id.to_string(), messages);
        debug!("Restored session history: session_id={}", session_id);
        Ok(())
    }
}
