//! Standalone, read-only Antigravity usage extraction. No Tauri or network dependency.

pub mod discovery;
pub mod model_resolver;
pub mod native_models;
pub mod normalizer;
pub mod parser;
pub mod records;
pub mod types;

pub use parser::{parse_transcript, ParseResult};
pub use types::{Source, Tokens, UsageEvent};

/// The immutable source revision used to audit extraction semantics.
pub const UPSTREAM_COMMIT: &str = "51fce968bca807aeee93be9420c651afb582c2c8";

#[cfg(test)]
mod tests {
    #[test]
    fn upstream_is_pinned() {
        assert_eq!(super::UPSTREAM_COMMIT.len(), 40);
    }
}
