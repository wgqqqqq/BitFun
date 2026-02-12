//! Temporary Image Storage API

use bitfun_core::agentic::tools::image_context::{
    ImageContextData as CoreImageContextData, ImageContextProvider,
};
use dashmap::DashMap;
use log::{debug, warn};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

static IMAGE_STORAGE: Lazy<DashMap<String, (ImageContextData, u64)>> = Lazy::new(DashMap::new);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageContextData {
    pub id: String,
    pub image_path: Option<String>,
    pub data_url: Option<String>,
    pub mime_type: String,
    pub image_name: String,
    pub file_size: usize,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub source: String,
}

impl From<ImageContextData> for CoreImageContextData {
    fn from(data: ImageContextData) -> Self {
        CoreImageContextData {
            id: data.id,
            image_path: data.image_path,
            data_url: data.data_url,
            mime_type: data.mime_type,
            image_name: data.image_name,
            file_size: data.file_size,
            width: data.width,
            height: data.height,
            source: data.source,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct UploadImageContextRequest {
    pub images: Vec<ImageContextData>,
}

#[tauri::command]
pub async fn upload_image_contexts(request: UploadImageContextRequest) -> Result<(), String> {
    let timestamp =
        current_unix_timestamp().map_err(|e| format!("Failed to get current timestamp: {}", e))?;

    for image in request.images {
        let image_id = image.id.clone();
        IMAGE_STORAGE.insert(image_id.clone(), (image, timestamp));
        debug!("Stored image context: image_id={}", image_id);
    }

    cleanup_expired_images(300);

    Ok(())
}

pub fn get_image_context(image_id: &str) -> Option<ImageContextData> {
    IMAGE_STORAGE.get(image_id).map(|entry| entry.0.clone())
}

pub fn remove_image_context(image_id: &str) {
    if IMAGE_STORAGE.remove(image_id).is_some() {
        debug!("Removed image context: image_id={}", image_id);
    }
}

fn cleanup_expired_images(max_age_secs: u64) {
    let now = match current_unix_timestamp() {
        Ok(timestamp) => timestamp,
        Err(e) => {
            warn!(
                "Failed to cleanup expired images due to timestamp error: {}",
                e
            );
            return;
        }
    };

    let expired_keys: Vec<String> = IMAGE_STORAGE
        .iter()
        .filter(|entry| now.saturating_sub(entry.value().1) > max_age_secs)
        .map(|entry| entry.key().clone())
        .collect();

    for key in expired_keys {
        IMAGE_STORAGE.remove(&key);
        debug!("Cleaned up expired image: image_id={}", key);
    }
}

#[derive(Debug)]
pub struct GlobalImageContextProvider;

impl ImageContextProvider for GlobalImageContextProvider {
    fn get_image(&self, image_id: &str) -> Option<CoreImageContextData> {
        get_image_context(image_id).map(|data| data.into())
    }

    fn remove_image(&self, image_id: &str) {
        remove_image_context(image_id);
    }
}

pub fn create_image_context_provider() -> GlobalImageContextProvider {
    GlobalImageContextProvider
}

fn current_unix_timestamp() -> Result<u64, std::time::SystemTimeError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
}
