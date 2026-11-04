# Third-party notices

## CC Switch

- Repository: https://github.com/farion1231/cc-switch
- Immutable revision: `51fce968bca807aeee93be9420c651afb582c2c8`
- License: MIT, **Copyright (c) 2025 Jason Young**.
- Full license: [licenses/CC-Switch-MIT.txt](licenses/CC-Switch-MIT.txt).
- Audited source hashes: [docs/upstream-lock.json](docs/upstream-lock.json).
- The ignored `.upstream/cc-switch` checkout is a development reference, not a runtime dependency.

The independent Rust crate adapts these narrowly scoped behaviors:

| Upstream file | Scope |
| --- | --- |
| `src-tauri/src/services/session_usage_agy.rs` | Settings-change parsing, display-to-ID conversion, known-model selection, ordered model inheritance, exact four-counter semantics |
| `src-tauri/src/session_manager/providers/agy.rs` | CLI/IDE/private-profile discovery, latest-step JSONL records, duplicate-session precedence |
| `src-tauri/src/services/session_usage_agy/native_models.rs` | Read-only native SQLite, step-to-generation reference and protobuf field mappings |
| `src-tauri/src/session_manager/providers/utils.rs` | Seconds/milliseconds/RFC3339 timestamp interpretation |
| `src-tauri/src/agy_config.rs` | Home-relative CLI/IDE and private profile layout |
| `src-tauri/src/services/subscription_agy.rs` | Read-only official CLI /usage response structure and four quota bucket IDs; no credential or account-switching code |
| `src-tauri/src/services/usage_stats.rs` | Central pricing lookup concept, exact model / explicit tier-suffix fallback |
| `src-tauri/src/proxy/usage/calculator.rs` | Four-category pricing concept, reimplemented using integer micro-USD and BigInt; no proxy runtime |
| `src-tauri/src/database/schema.rs` | Three fixed-source reference price rows: Gemini 3.8 Flash, Gemini 3.1 Pro Preview, Claude Opus 4.6 |

Tauri, UI, OAuth, subscription management and proxy code are excluded. Project behavior
intentionally differs from upstream's zero-cost fallback: missing prices must be NULL/unpriced.

Version 0.2.0 adds independently reviewed current price facts from Google's and Anthropic's
official pricing documentation. Sources and effective dates are recorded in migration
0004_official_prices.sql and docs/MONITORING.md. Google cache creation uses standard input
rates; Anthropic cache creation uses the 5-minute rate because logs do not expose cache TTL.

