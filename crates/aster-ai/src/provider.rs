use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;

const MAX_PROVIDER_RESPONSE_BYTES: usize = 1_048_576;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderConfig {
    pub base_url: String,
    pub api_key: Option<String>,
    pub model: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GeneratedPlan {
    pub summary: String,
    pub operations: Vec<Value>,
}

pub async fn generate_plan(
    config: AiProviderConfig,
    prompt: &str,
    project_summary: &str,
) -> Result<GeneratedPlan, ProviderError> {
    validate_config(&config)?;
    let api_key = config
        .api_key
        .filter(|key| !key.trim().is_empty())
        .or_else(|| std::env::var("ASTER_AI_API_KEY").ok())
        .ok_or(ProviderError::MissingApiKey)?;
    let endpoint = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
    let system = r#"You are the operation planner inside Aster, a GPU-first motion graphics editor.
Return only valid JSON with this shape: {"summary":"...","operations":[...]}. Never return markdown.
Allowed operation types are addLayer, removeLayer, renameLayer, reorderLayer, toggleLayer,
setProperty, addKeyframe, addEffect, removeEffect, and setEffectParameter. Use the exact IDs and
property paths in the project context. Prefer editable keyframes and GPU effects. Do not invent
asset paths, execute code, or include secrets. Keep every plan reversible and under 12 operations."#;
    let body = json!({
        "model": config.model,
        "temperature": 0.2,
        "response_format": { "type": "json_object" },
        "messages": [
            { "role": "system", "content": system },
            {
                "role": "user",
                "content": format!("Project context:\n{project_summary}\n\nIntent:\n{prompt}")
            }
        ]
    });
    let response = Client::builder()
        .timeout(Duration::from_secs(45))
        .build()?
        .post(endpoint)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await?;
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PROVIDER_RESPONSE_BYTES as u64)
    {
        return Err(ProviderError::ResponseTooLarge);
    }
    let bytes = response.bytes().await?;
    if bytes.len() > MAX_PROVIDER_RESPONSE_BYTES {
        return Err(ProviderError::ResponseTooLarge);
    }
    let value: Value = serde_json::from_slice(&bytes)?;
    if !status.is_success() {
        let message = value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("provider rejected the request");
        return Err(ProviderError::Provider {
            status: status.as_u16(),
            message: message.to_owned(),
        });
    }
    let content = value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or(ProviderError::MissingContent)?;
    let cleaned = content
        .trim()
        .strip_prefix("```json")
        .unwrap_or(content.trim())
        .strip_suffix("```")
        .unwrap_or(content.trim())
        .trim();
    let plan: GeneratedPlan = serde_json::from_str(cleaned)?;
    if plan.operations.is_empty() {
        return Err(ProviderError::EmptyPlan);
    }
    Ok(plan)
}

fn validate_config(config: &AiProviderConfig) -> Result<(), ProviderError> {
    if !(config.base_url.starts_with("https://")
        || config.base_url.starts_with("http://127.0.0.1")
        || config.base_url.starts_with("http://localhost"))
    {
        return Err(ProviderError::InvalidBaseUrl);
    }
    if config.model.trim().is_empty() {
        return Err(ProviderError::MissingModel);
    }
    Ok(())
}

#[derive(Debug, Error)]
pub enum ProviderError {
    #[error("AI provider base URL must use HTTPS or localhost")]
    InvalidBaseUrl,
    #[error("AI provider model is required")]
    MissingModel,
    #[error("AI provider API key is not configured")]
    MissingApiKey,
    #[error("AI provider request failed: {0}")]
    Request(#[from] reqwest::Error),
    #[error("AI provider returned invalid operation JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("AI provider returned no message content")]
    MissingContent,
    #[error("AI provider returned an empty operation plan")]
    EmptyPlan,
    #[error("AI provider response exceeded the 1 MiB safety limit")]
    ResponseTooLarge,
    #[error("AI provider error ({status}): {message}")]
    Provider { status: u16, message: String },
}
