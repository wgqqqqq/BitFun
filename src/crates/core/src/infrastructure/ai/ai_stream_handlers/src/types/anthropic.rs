use super::unified::{UnifiedResponse, UnifiedTokenUsage, UnifiedToolCall};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct MessageStart {
    pub message: Message,
}

#[derive(Debug, Deserialize)]
pub struct Message {
    pub usage: Usage,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Usage {
    input_tokens: Option<u32>,
    output_tokens: Option<u32>,
    cache_read_input_tokens: Option<u32>,
}

impl Default for Usage {
    fn default() -> Self {
        Self {
            input_tokens: None,
            output_tokens: None,
            cache_read_input_tokens: None,
        }
    }
}

impl Usage {
    pub fn update(&mut self, other: &Usage) {
        if other.input_tokens.is_some() {
            self.input_tokens = other.input_tokens;
        }
        if other.output_tokens.is_some() {
            self.output_tokens = other.output_tokens;
        }
        if other.cache_read_input_tokens.is_some() {
            self.cache_read_input_tokens = other.cache_read_input_tokens;
        }
    }
}

impl From<Usage> for UnifiedTokenUsage {
    fn from(value: Usage) -> Self {
        let prompt_token_count =
            value.input_tokens.unwrap_or(0) + value.cache_read_input_tokens.unwrap_or(0);
        let candidates_token_count = value.output_tokens.unwrap_or(0);
        Self {
            prompt_token_count,
            candidates_token_count,
            total_token_count: prompt_token_count + candidates_token_count,
            cached_content_token_count: value.cache_read_input_tokens,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct MessageDelta {
    pub delta: MessageDeltaDelta,
    pub usage: Usage,
}

#[derive(Debug, Deserialize)]
pub struct MessageDeltaDelta {
    pub stop_reason: String,
}

impl From<MessageDelta> for UnifiedResponse {
    fn from(value: MessageDelta) -> Self {
        Self {
            text: None,
            reasoning_content: None,
            thinking_signature: None,
            tool_call: None,
            usage: Some(UnifiedTokenUsage::from(value.usage)),
            finish_reason: Some(value.delta.stop_reason),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct ContentBlockStart {
    pub content_block: ContentBlock,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
    #[serde(rename = "thinking")]
    Thinking,
    #[serde(rename = "text")]
    Text,
    #[serde(rename = "tool_use")]
    ToolUse { id: String, name: String },
}

impl From<ContentBlockStart> for UnifiedResponse {
    fn from(value: ContentBlockStart) -> Self {
        let mut result = UnifiedResponse::default();
        match value.content_block {
            ContentBlock::ToolUse { id, name } => {
                let tool_call = UnifiedToolCall {
                    id: Some(id),
                    name: Some(name),
                    arguments: None,
                };
                result.tool_call = Some(tool_call);
            }
            _ => {}
        }
        result
    }
}

#[derive(Debug, Deserialize)]
pub struct ContentBlockDelta {
    delta: Delta,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum Delta {
    #[serde(rename = "thinking_delta")]
    ThinkingDelta { thinking: String },
    #[serde(rename = "text_delta")]
    TextDelta { text: String },
    #[serde(rename = "input_json_delta")]
    InputJsonDelta { partial_json: String },
    #[serde(rename = "signature_delta")]
    SignatureDelta { signature: String },
}

impl TryFrom<ContentBlockDelta> for UnifiedResponse {
    type Error = String;
    fn try_from(value: ContentBlockDelta) -> Result<Self, Self::Error> {
        let mut result = UnifiedResponse::default();
        match value.delta {
            Delta::ThinkingDelta { thinking } => {
                result.reasoning_content = Some(thinking);
            }
            Delta::TextDelta { text } => {
                result.text = Some(text);
            }
            Delta::InputJsonDelta { partial_json } => {
                let tool_call = UnifiedToolCall {
                    id: None,
                    name: None,
                    arguments: Some(partial_json),
                };
                result.tool_call = Some(tool_call);
            }
            Delta::SignatureDelta { signature } => {
                result.thinking_signature = Some(signature);
            }
        }
        Ok(result)
    }
}

#[derive(Debug, Deserialize)]
pub struct AnthropicSSEError {
    pub error: AnthropicSSEErrorDetails,
}

#[derive(Debug, Deserialize)]
pub struct AnthropicSSEErrorDetails {
    #[serde(rename = "type")]
    pub error_type: String,
    pub message: String,
}

impl From<AnthropicSSEErrorDetails> for String {
    fn from(value: AnthropicSSEErrorDetails) -> Self {
        format!("{}: {}", value.error_type, value.message)
    }
}
