use std::{future::Future, pin::Pin, time::Duration};

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

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct GeneratedPlan {
    pub summary: String,
    pub operations: Vec<Value>,
}

pub type ProviderFuture<'a> =
    Pin<Box<dyn Future<Output = Result<GeneratedPlan, ProviderError>> + Send + 'a>>;

pub trait AiProvider: Send + Sync {
    fn generate<'a>(&'a self, prompt: &'a str, project_context: &'a str) -> ProviderFuture<'a>;
}

pub struct OpenAiCompatibleProvider {
    config: AiProviderConfig,
    api_key: String,
    client: Client,
}

impl OpenAiCompatibleProvider {
    pub fn new(config: AiProviderConfig) -> Result<Self, ProviderError> {
        validate_config(&config)?;
        let api_key = config
            .api_key
            .as_deref()
            .filter(|key| !key.trim().is_empty())
            .map(str::to_owned)
            .or_else(|| std::env::var("ASTER_AI_API_KEY").ok())
            .ok_or(ProviderError::MissingApiKey)?;
        let client = Client::builder().timeout(Duration::from_secs(45)).build()?;
        Ok(Self {
            config,
            api_key,
            client,
        })
    }
}

impl AiProvider for OpenAiCompatibleProvider {
    fn generate<'a>(&'a self, prompt: &'a str, project_context: &'a str) -> ProviderFuture<'a> {
        Box::pin(async move {
            let endpoint = format!(
                "{}/chat/completions",
                self.config.base_url.trim_end_matches('/')
            );
            let body = request_body(&self.config.model, prompt, project_context);
            let response = self
                .client
                .post(endpoint)
                .bearer_auth(&self.api_key)
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
            parse_provider_response(status.as_u16(), &bytes)
        })
    }
}

pub async fn generate_plan(
    config: AiProviderConfig,
    prompt: &str,
    project_summary: &str,
) -> Result<GeneratedPlan, ProviderError> {
    OpenAiCompatibleProvider::new(config)?
        .generate(prompt, project_summary)
        .await
}

fn request_body(model: &str, prompt: &str, project_context: &str) -> Value {
    let system = r#"You are the operation planner inside Aster, a GPU-first motion graphics editor.
Return only valid JSON with this shape: {"summary":"...","operations":[...]}. Never return markdown.
Allowed operation types are addLayer, removeLayer, renameLayer, reorderLayer, toggleLayer,
setProperty, addKeyframe, addEffect, removeEffect, and setEffectParameter. Use the exact IDs and
property paths in the project context. Prefer editable keyframes and GPU effects. Do not invent
asset paths, execute code, or include secrets. Keep every plan reversible and under 12 operations."#;
    json!({
        "model": model,
        "temperature": 0.2,
        "response_format": { "type": "json_object" },
        "messages": [
            { "role": "system", "content": system },
            {
                "role": "user",
                "content": format!("Project context:\n{project_context}\n\nIntent:\n{prompt}")
            }
        ]
    })
}

fn parse_provider_response(status: u16, bytes: &[u8]) -> Result<GeneratedPlan, ProviderError> {
    let value: Value = serde_json::from_slice(bytes)?;
    if !(200..300).contains(&status) {
        let message = value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("provider rejected the request");
        return Err(ProviderError::Provider {
            status,
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

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    struct FakeProvider(AtomicBool);

    impl AiProvider for FakeProvider {
        fn generate<'a>(&'a self, prompt: &'a str, project_context: &'a str) -> ProviderFuture<'a> {
            self.0.store(true, Ordering::Relaxed);
            Box::pin(async move {
                Ok(GeneratedPlan {
                    summary: format!("{prompt}:{project_context}"),
                    operations: vec![json!({ "type": "renameLayer" })],
                })
            })
        }
    }

    #[test]
    fn provider_trait_supports_network_free_implementations() {
        let provider = FakeProvider(AtomicBool::new(false));
        let future = provider.generate("intent", "context");
        assert!(provider.0.load(Ordering::Relaxed));
        drop(future);
    }

    #[test]
    fn parses_json_and_markdown_wrapped_compatible_responses() {
        let response = json!({
            "choices": [{
                "message": {
                    "content": "```json\n{\"summary\":\"Tint\",\"operations\":[{\"type\":\"addEffect\"}]}\n```"
                }
            }]
        });
        let plan = parse_provider_response(200, &serde_json::to_vec(&response).unwrap()).unwrap();
        assert_eq!(plan.summary, "Tint");
        assert_eq!(plan.operations.len(), 1);
    }
}
