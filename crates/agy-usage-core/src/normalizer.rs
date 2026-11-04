use crate::{Source, UsageEvent};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

/// Only this explicit allowlist may enter the upload queue; no raw JSON flattening.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UploadEvent {
    pub event_id: String,
    pub session_key: String,
    pub step_index: u64,
    pub model_display: String,
    pub model_id: String,
    pub occurred_at_ms: i64,
    pub tokens: UploadTokens,
    pub source: Source,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UploadTokens {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

pub struct Pseudonymizer {
    mac: Hmac<Sha256>,
}

impl Pseudonymizer {
    pub fn new(key: &[u8]) -> Result<Self, &'static str> {
        if key.len() < 32 {
            return Err("Pseudonym key must contain at least 32 bytes");
        }
        Ok(Self {
            mac: Hmac::<Sha256>::new_from_slice(key).map_err(|_| "Invalid pseudonym key")?,
        })
    }

    pub fn sanitize(&self, event: &UsageEvent) -> UploadEvent {
        let mut session = self.mac.clone();
        session.update(b"agy-session-v1\0");
        session.update(event.session_id.as_bytes());
        let mut id = self.mac.clone();
        id.update(b"agy-event-v1\0");
        id.update(&(event.session_id.len() as u64).to_be_bytes());
        id.update(event.session_id.as_bytes());
        id.update(&event.step_index.to_be_bytes());
        UploadEvent {
            event_id: hex::encode(id.finalize().into_bytes()),
            session_key: hex::encode(session.finalize().into_bytes()),
            step_index: event.step_index,
            model_display: event.model_display.clone(),
            model_id: event.model_id.clone(),
            occurred_at_ms: event.occurred_at_ms,
            tokens: UploadTokens {
                input: event.tokens.input_tokens,
                output: event.tokens.output_tokens,
                cache_read: event.tokens.cache_read_tokens,
                cache_write: event.tokens.cache_write_tokens,
            },
            source: event.source,
        }
    }
}
