//! Bot integration for Remote Connect.
//!
//! Supports Feishu and Telegram bots as relay channels.
//! Shared command logic lives in `command_router`; platform-specific
//! I/O is handled by `telegram` and `feishu`.

pub mod command_router;
pub mod feishu;
pub mod telegram;

use serde::{Deserialize, Serialize};

pub use command_router::{BotChatState, HandleResult, ForwardRequest};

/// Configuration for a bot-based connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "bot_type", rename_all = "snake_case")]
pub enum BotConfig {
    Feishu {
        app_id: String,
        app_secret: String,
    },
    Telegram {
        bot_token: String,
    },
}

/// Pairing state for bot-based connections.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotPairingInfo {
    pub pairing_code: String,
    pub bot_type: String,
    pub bot_link: String,
    pub expires_at: i64,
}

/// Persisted bot connection — saved to disk so reconnect survives restarts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedBotConnection {
    pub bot_type: String,
    pub chat_id: String,
    pub config: BotConfig,
    pub chat_state: BotChatState,
    pub connected_at: i64,
}

/// All persisted bot connections (one per bot type at most).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BotPersistenceData {
    pub connections: Vec<SavedBotConnection>,
}

impl BotPersistenceData {
    pub fn upsert(&mut self, conn: SavedBotConnection) {
        self.connections.retain(|c| c.bot_type != conn.bot_type);
        self.connections.push(conn);
    }

    pub fn remove(&mut self, bot_type: &str) {
        self.connections.retain(|c| c.bot_type != bot_type);
    }

    pub fn get(&self, bot_type: &str) -> Option<&SavedBotConnection> {
        self.connections.iter().find(|c| c.bot_type == bot_type)
    }
}

const BOT_PERSISTENCE_FILENAME: &str = "bot_connections.json";

pub fn bot_persistence_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|home| home.join(".bitfun").join(BOT_PERSISTENCE_FILENAME))
}

pub fn load_bot_persistence() -> BotPersistenceData {
    let Some(path) = bot_persistence_path() else {
        return BotPersistenceData::default();
    };
    match std::fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => BotPersistenceData::default(),
    }
}

pub fn save_bot_persistence(data: &BotPersistenceData) {
    let Some(path) = bot_persistence_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(data) {
        if let Err(e) = std::fs::write(&path, json) {
            log::error!("Failed to save bot persistence: {e}");
        }
    }
}
