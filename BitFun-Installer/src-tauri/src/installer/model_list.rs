//! Remote model listing for installer (copied behavior from main app AI client; no bitfun_core dependency).
use crate::installer::types::{ModelConfig, RemoteModelInfo};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, AUTHORIZATION};
use serde::Deserialize;
use std::time::Duration;

#[derive(Debug, Deserialize)]
struct OpenAIModelsResponse {
    data: Vec<OpenAIModelEntry>,
}

#[derive(Debug, Deserialize)]
struct OpenAIModelEntry {
    id: String,
}

#[derive(Debug, Deserialize)]
struct AnthropicModelsResponse {
    data: Vec<AnthropicModelEntry>,
}

#[derive(Debug, Deserialize)]
struct AnthropicModelEntry {
    id: String,
    #[serde(default)]
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GeminiModelsResponse {
    #[serde(default)]
    models: Vec<GeminiModelEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeminiModelEntry {
    name: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    supported_generation_methods: Vec<String>,
}

fn normalize_base_url_for_discovery(base_url: &str) -> String {
    base_url
        .trim()
        .trim_end_matches('#')
        .trim_end_matches('/')
        .to_string()
}

fn resolve_openai_models_url(base_url: &str) -> String {
    let mut base = normalize_base_url_for_discovery(base_url);
    for suffix in ["/chat/completions", "/responses", "/models"] {
        if base.ends_with(suffix) {
            base.truncate(base.len() - suffix.len());
            break;
        }
    }
    if base.is_empty() {
        return "models".to_string();
    }
    format!("{}/models", base)
}

fn resolve_anthropic_models_url(base_url: &str) -> String {
    let mut base = normalize_base_url_for_discovery(base_url);
    if base.ends_with("/v1/messages") {
        base.truncate(base.len() - "/v1/messages".len());
        return format!("{}/v1/models", base);
    }
    if base.ends_with("/v1/models") {
        return base;
    }
    if base.ends_with("/v1") {
        return format!("{}/models", base);
    }
    if base.is_empty() {
        return "v1/models".to_string();
    }
    format!("{}/v1/models", base)
}

fn gemini_base_url(url: &str) -> &str {
    let mut u = url;
    if let Some(pos) = u.find("/v1beta") {
        u = &u[..pos];
    }
    if let Some(pos) = u.find("/models/") {
        u = &u[..pos];
    }
    u.trim_end_matches('/')
}

fn resolve_gemini_models_url(base_url: &str) -> String {
    let base = normalize_base_url_for_discovery(base_url);
    let base = gemini_base_url(&base);
    format!("{}/v1beta/models", base)
}

fn dedupe_remote_models(models: Vec<RemoteModelInfo>) -> Vec<RemoteModelInfo> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for m in models {
        if seen.insert(m.id.clone()) {
            out.push(m);
        }
    }
    out
}

fn list_format_for_dispatch(model: &ModelConfig) -> String {
    let f = model.format.trim().to_ascii_lowercase();
    match f.as_str() {
        "anthropic" => "anthropic".to_string(),
        "gemini" | "google" => "gemini".to_string(),
        "openai" | "response" | "responses" => "openai".to_string(),
        _ => "openai".to_string(),
    }
}

fn build_list_headers(model: &ModelConfig, format: &str) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    match format {
        "anthropic" => {
            let api_key = HeaderValue::from_str(model.api_key.trim())
                .map_err(|_| "apiKey contains unsupported header characters".to_string())?;
            headers.insert(HeaderName::from_static("x-api-key"), api_key);
            headers.insert(
                HeaderName::from_static("anthropic-version"),
                HeaderValue::from_static("2023-06-01"),
            );
        }
        "gemini" => {
            let api_key = HeaderValue::from_str(model.api_key.trim())
                .map_err(|_| "apiKey contains unsupported header characters".to_string())?;
            headers.insert(HeaderName::from_static("x-goog-api-key"), api_key.clone());
            let bearer = format!("Bearer {}", model.api_key.trim());
            let auth = HeaderValue::from_str(&bearer)
                .map_err(|_| "apiKey contains unsupported header characters".to_string())?;
            headers.insert(AUTHORIZATION, auth);
        }
        _ => {
            let bearer = format!("Bearer {}", model.api_key.trim());
            let auth = HeaderValue::from_str(&bearer)
                .map_err(|_| "apiKey contains unsupported header characters".to_string())?;
            headers.insert(AUTHORIZATION, auth);
        }
    }
    Ok(headers)
}

pub async fn list_remote_models(model: &ModelConfig) -> Result<Vec<RemoteModelInfo>, String> {
    let dispatch = list_format_for_dispatch(model);
    match dispatch.as_str() {
        "openai" => list_openai_models(model).await,
        "anthropic" => list_anthropic_models(model).await,
        "gemini" => list_gemini_models(model).await,
        _ => Err(format!("Unsupported format for model listing: {}", dispatch)),
    }
}

async fn list_openai_models(model: &ModelConfig) -> Result<Vec<RemoteModelInfo>, String> {
    let url = resolve_openai_models_url(&model.base_url);
    let headers = build_list_headers(model, "openai")?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .danger_accept_invalid_certs(model.skip_ssl_verify.unwrap_or(false))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get(&url)
        .headers(headers)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), body.chars().take(400).collect::<String>()));
    }

    let payload: OpenAIModelsResponse = serde_json::from_str(&body)
        .map_err(|e| format!("Invalid OpenAI models response: {}", e))?;

    Ok(dedupe_remote_models(
        payload
            .data
            .into_iter()
            .map(|m| RemoteModelInfo {
                id: m.id,
                display_name: None,
            })
            .collect(),
    ))
}

async fn list_anthropic_models(model: &ModelConfig) -> Result<Vec<RemoteModelInfo>, String> {
    let url = resolve_anthropic_models_url(&model.base_url);
    let headers = build_list_headers(model, "anthropic")?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .danger_accept_invalid_certs(model.skip_ssl_verify.unwrap_or(false))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get(&url)
        .headers(headers)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), body.chars().take(400).collect::<String>()));
    }

    let payload: AnthropicModelsResponse = serde_json::from_str(&body)
        .map_err(|e| format!("Invalid Anthropic models response: {}", e))?;

    Ok(dedupe_remote_models(
        payload
            .data
            .into_iter()
            .map(|m| RemoteModelInfo {
                id: m.id,
                display_name: m.display_name,
            })
            .collect(),
    ))
}

async fn list_gemini_models(model: &ModelConfig) -> Result<Vec<RemoteModelInfo>, String> {
    let url = resolve_gemini_models_url(&model.base_url);
    let headers = build_list_headers(model, "gemini")?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .danger_accept_invalid_certs(model.skip_ssl_verify.unwrap_or(false))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get(&url)
        .headers(headers)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), body.chars().take(400).collect::<String>()));
    }

    let payload: GeminiModelsResponse = serde_json::from_str(&body)
        .map_err(|e| format!("Invalid Gemini models response: {}", e))?;

    Ok(dedupe_remote_models(
        payload
            .models
            .into_iter()
            .filter(|m| {
                m.supported_generation_methods.is_empty()
                    || m.supported_generation_methods
                        .iter()
                        .any(|method| method == "generateContent")
            })
            .map(|m| {
                let id = m
                    .name
                    .strip_prefix("models/")
                    .unwrap_or(&m.name)
                    .to_string();
                RemoteModelInfo {
                    id,
                    display_name: m.display_name,
                }
            })
            .collect(),
    ))
}
