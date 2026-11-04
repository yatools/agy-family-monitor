use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Source {
    #[serde(rename = "antigravity_cli")]
    Cli,
    #[serde(rename = "antigravity_ide")]
    Ide,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Tokens {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

impl Tokens {
    /// D1 stores signed 64-bit integers. Reject overflows instead of wrapping.
    pub fn total(self) -> Option<u64> {
        let total = self
            .input_tokens
            .checked_add(self.output_tokens)?
            .checked_add(self.cache_read_tokens)?
            .checked_add(self.cache_write_tokens)?;
        (total <= i64::MAX as u64).then_some(total)
    }

    pub fn checked_add(self, other: Self) -> Option<Self> {
        Some(Self {
            input_tokens: self.input_tokens.checked_add(other.input_tokens)?,
            output_tokens: self.output_tokens.checked_add(other.output_tokens)?,
            cache_read_tokens: self
                .cache_read_tokens
                .checked_add(other.cache_read_tokens)?,
            cache_write_tokens: self
                .cache_write_tokens
                .checked_add(other.cache_write_tokens)?,
        })
    }
}

/// Local-only record: deliberately does not implement Serialize.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageEvent {
    pub session_id: String,
    pub step_index: u64,
    pub model_display: String,
    pub model_id: String,
    pub occurred_at_ms: i64,
    pub tokens: Tokens,
    pub source: Source,
}
