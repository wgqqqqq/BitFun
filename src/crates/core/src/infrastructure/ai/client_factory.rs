//! AI client factory - centrally manages client instances for all models
//!
//! Responsibilities:
//! 1. Create and cache AI clients on demand
//! 2. Manage agent model configuration
//! 3. Invalidate cache when configuration changes
//! 4. Provide global singleton access

use crate::infrastructure::ai::AIClient;
use crate::service::config::{get_global_config_service, ConfigService};
use crate::util::errors::{BitFunError, BitFunResult};
use crate::util::types::AIConfig;
use anyhow::{anyhow, Result};
use log::{debug, info, warn};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock};

pub struct AIClientFactory {
    config_service: Arc<ConfigService>,
    client_cache: RwLock<HashMap<String, Arc<AIClient>>>,
}

impl AIClientFactory {
    fn new(config_service: Arc<ConfigService>) -> Self {
        Self {
            config_service,
            client_cache: RwLock::new(HashMap::new()),
        }
    }

    /// Get the main agent's AI client
    /// Falls back to primary when no dedicated model is configured
    pub async fn get_client_by_agent(&self, agent_name: &str) -> Result<Arc<AIClient>> {
        let global_config: crate::service::config::GlobalConfig =
            self.config_service.get_config(None).await?;

        match global_config.ai.agent_models.get(agent_name) {
            Some(model_id) => self.get_client_resolved(model_id).await,
            None => self.get_client_resolved("primary").await,
        }
    }

    /// Get a functional agent's AI client
    /// Prefer func_agent_models, fall back to agent_models (legacy), then fast
    pub async fn get_client_by_func_agent(&self, func_agent_name: &str) -> Result<Arc<AIClient>> {
        let global_config: crate::service::config::GlobalConfig =
            self.config_service.get_config(None).await?;

        let model_id = global_config
            .ai
            .func_agent_models
            .get(func_agent_name)
            .or_else(|| global_config.ai.agent_models.get(func_agent_name))
            .map(String::as_str)
            .unwrap_or("fast");

        self.get_client_resolved(model_id).await
    }

    pub async fn get_client_by_id(&self, model_id: &str) -> Result<Arc<AIClient>> {
        self.get_or_create_client(model_id).await
    }

    /// Get a client (supports resolving primary/fast)
    pub async fn get_client_resolved(&self, model_id: &str) -> Result<Arc<AIClient>> {
        let resolved_model_id = match model_id {
            "primary" => {
                let global_config: crate::service::config::GlobalConfig =
                    self.config_service.get_config(None).await?;
                global_config
                    .ai
                    .default_models
                    .primary
                    .ok_or_else(|| anyhow!("Primary model not configured"))?
            }
            "fast" => {
                let global_config: crate::service::config::GlobalConfig =
                    self.config_service.get_config(None).await?;

                match global_config.ai.default_models.fast {
                    Some(fast_id) => fast_id,
                    None => global_config.ai.default_models.primary.ok_or_else(|| {
                        anyhow!("Fast model not configured and primary model not configured")
                    })?,
                }
            }
            _ => model_id.to_string(),
        };

        self.get_or_create_client(&resolved_model_id).await
    }

    pub fn invalidate_cache(&self) {
        let mut cache = match self.client_cache.write() {
            Ok(cache) => cache,
            Err(poisoned) => {
                warn!("AI client cache write lock poisoned during invalidate_cache, recovering");
                poisoned.into_inner()
            }
        };
        let count = cache.len();
        cache.clear();
        info!("AI client cache cleared (removed {} clients)", count);
    }

    pub fn get_cache_size(&self) -> usize {
        let cache = match self.client_cache.read() {
            Ok(cache) => cache,
            Err(poisoned) => {
                warn!("AI client cache read lock poisoned during get_cache_size, recovering");
                poisoned.into_inner()
            }
        };
        cache.len()
    }

    pub fn invalidate_model(&self, model_id: &str) {
        let mut cache = match self.client_cache.write() {
            Ok(cache) => cache,
            Err(poisoned) => {
                warn!("AI client cache write lock poisoned during invalidate_model, recovering");
                poisoned.into_inner()
            }
        };
        if cache.remove(model_id).is_some() {
            debug!("Client cache cleared for model: {}", model_id);
        }
    }

    async fn get_or_create_client(&self, model_id: &str) -> Result<Arc<AIClient>> {
        {
            let cache = match self.client_cache.read() {
                Ok(cache) => cache,
                Err(poisoned) => {
                    warn!(
                        "AI client cache read lock poisoned during get_or_create_client, recovering"
                    );
                    poisoned.into_inner()
                }
            };
            if let Some(client) = cache.get(model_id) {
                return Ok(client.clone());
            }
        }

        debug!("Creating new AI client: model_id={}", model_id);

        let global_config: crate::service::config::GlobalConfig =
            self.config_service.get_config(None).await?;
        let model_config = global_config
            .ai
            .models
            .iter()
            .find(|m| m.id == model_id)
            .ok_or_else(|| anyhow!("Model configuration not found: {}", model_id))?;

        let ai_config = AIConfig::try_from(model_config.clone())
            .map_err(|e| anyhow!("AI configuration conversion failed: {}", e))?;

        let proxy_config = if global_config.ai.proxy.enabled {
            Some(global_config.ai.proxy.clone())
        } else {
            None
        };

        let client = Arc::new(AIClient::new_with_proxy(ai_config, proxy_config));

        {
            let mut cache = match self.client_cache.write() {
                Ok(cache) => cache,
                Err(poisoned) => {
                    warn!(
                        "AI client cache write lock poisoned during get_or_create_client, recovering"
                    );
                    poisoned.into_inner()
                }
            };
            cache.insert(model_id.to_string(), client.clone());
        }

        debug!(
            "AI client created: model_id={}, name={}",
            model_id, model_config.name
        );

        Ok(client)
    }
}

static GLOBAL_AI_CLIENT_FACTORY: OnceLock<Arc<tokio::sync::RwLock<Option<Arc<AIClientFactory>>>>> =
    OnceLock::new();

impl AIClientFactory {
    /// Initialize the global AIClientFactory singleton
    pub async fn initialize_global() -> BitFunResult<()> {
        if Self::is_global_initialized() {
            return Ok(());
        }

        info!("Initializing global AIClientFactory...");

        let config_service = get_global_config_service().await.map_err(|e| {
            BitFunError::service(format!("Failed to get global config service: {}", e))
        })?;

        let factory = Arc::new(AIClientFactory::new(config_service));
        let wrapper = Arc::new(tokio::sync::RwLock::new(Some(factory)));

        GLOBAL_AI_CLIENT_FACTORY.set(wrapper).map_err(|_| {
            BitFunError::service("Failed to initialize global AIClientFactory".to_string())
        })?;

        info!("Global AIClientFactory initialized");
        Ok(())
    }

    /// Get the global AIClientFactory instance
    pub async fn get_global() -> BitFunResult<Arc<AIClientFactory>> {
        let wrapper = GLOBAL_AI_CLIENT_FACTORY.get().ok_or_else(|| {
            BitFunError::service(
                "Global AIClientFactory not initialized. Call initialize_global() first."
                    .to_string(),
            )
        })?;

        let guard = wrapper.read().await;
        guard
            .as_ref()
            .ok_or_else(|| BitFunError::service("Global AIClientFactory is None".to_string()))
            .map(Arc::clone)
    }

    pub fn is_global_initialized() -> bool {
        GLOBAL_AI_CLIENT_FACTORY.get().is_some()
    }

    /// Update the global AIClientFactory instance (used for config reload)
    pub async fn update_global(new_factory: Arc<AIClientFactory>) -> BitFunResult<()> {
        let wrapper = GLOBAL_AI_CLIENT_FACTORY.get().ok_or_else(|| {
            BitFunError::service("Global AIClientFactory not initialized".to_string())
        })?;

        {
            let mut guard = wrapper.write().await;
            *guard = Some(new_factory);
        }

        debug!("Global AIClientFactory updated");
        Ok(())
    }
}

pub async fn get_global_ai_client_factory() -> BitFunResult<Arc<AIClientFactory>> {
    AIClientFactory::get_global().await
}

pub async fn initialize_global_ai_client_factory() -> BitFunResult<()> {
    AIClientFactory::initialize_global().await
}
