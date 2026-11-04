# Contributing / 参与贡献

问题与 PR 可使用中文或英文。Issues and pull requests in Chinese or English are welcome.

## Development / 开发

1. Fork and clone the repository. Use a `codex/` or descriptive feature branch.
2. Install Rust 1.98+, a Windows C/C++ toolchain, Node.js 24 and npm 11.
3. Run `npm ci`, then copy `apps/worker/wrangler.example.jsonc` to `apps/worker/wrangler.jsonc`.
4. Run `./scripts/check.ps1`. For the demo UI, run `npm run dev:web` and add `?demo=1`.
5. For parser changes, add synthetic regression fixtures and preserve the four-counter semantics.

修改后执行 / Required checks:

```text
cargo fmt --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
npm test
npm run typecheck
npm run build
```

## Invariants / 必须保留的行为

- Upload only whitelisted metadata. Never include prompts, conversations, credentials, local paths or raw session IDs.
- Keep parsing independent of Tauri and UI. Never count reasoning twice or guess historical models.
- The latest JSONL row for a step wins; changed files must be reparsed.
- Unknown prices remain NULL/unpriced. Preserve immutable price versions and UTC timestamps.
- Six members share one pool. Never sum duplicate readings or add 5-hour and weekly limits.
- Add migrations rather than changing applied migrations. Retain CC Switch attribution and pinned provenance.
- Keep real deployment configuration, `.local`, backups and member data out of commits.

## Reports and pull requests / 报告与 PR

Describe the trigger, expected/actual behavior and validation. Use synthetic fixtures;
do not attach original transcripts or private databases. For UI changes, include a screenshot
with synthetic data. Update both READMEs when public behavior changes.

请说明触发条件、预期和实际结果及验证方式。截图只能包含合成数据。
自动化测试不能代替真实多设备验收，参见 [acceptance](docs/ACCEPTANCE.md)。
