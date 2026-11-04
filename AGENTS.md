# Agy Family Monitor

## Project goal

Read local Antigravity usage metadata and eventually upload only sanitized token
statistics to Cloudflare. The authoritative requirements are in `SPEC.md`.

## Mandatory rules

- Work P0 → P1 → P2 → P3 → P4 → P5. P1 real Windows/CC Switch reconciliation is a hard gate before P2.
- Do not build an AI proxy, quota sharing service or Telegram bot.
- Never collect Google credentials, upload prompts, conversations, original session IDs or local paths.
- Never count reasoning twice, guess historical models, or treat unpriced models as free.
- Read source logs and native databases only; tolerate unavailable roots and busy databases.
- Latest JSONL row per step wins. Reparse changed files; do not rely on append-only offsets.
- Keep parser independent of Tauri. Use typed API contracts, D1 migrations and UTC storage.
- Preserve CC Switch MIT attribution and immutable commit in `docs/upstream-lock.json`.
- Keep secrets and real member data out of Git. `.local` contains private local validation artifacts.
- Follow `docs/ACCEPTANCE.md`; do not label a milestone complete until its real acceptance passes.

## Documentation

Use Context7 MCP for current library/SDK/CLI/cloud documentation: first
`resolve-library-id`, then `query-docs`, each scoped to one concept. If the connector
is unavailable, `scripts/context7.mjs` calls the same public MCP endpoint without
changing the user's configuration. Queries must not contain personal data or secrets.

## Required checks

```text
cargo fmt --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
npm test
npm run typecheck
npm run build
```

Do not deploy, enroll devices or access real usage remotely before the relevant gate.
Do not push a repository without an explicitly configured destination.

