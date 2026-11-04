param([switch]$RegistryFallback)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'rust-env.ps1')
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    cargo fmt --check
    if ($LASTEXITCODE -ne 0) { throw 'Rust formatting failed' }
    if ($RegistryFallback) {
        node scripts/fetch-rust.mjs test --workspace --locked --offline
    } else { cargo test --workspace --locked }
    if ($LASTEXITCODE -ne 0) { throw 'Rust tests failed' }
    if ($RegistryFallback) {
        node scripts/fetch-rust.mjs clippy --workspace --all-targets --all-features --locked --offline -- -D warnings
    } else { cargo clippy --workspace --all-targets --all-features --locked -- -D warnings }
    if ($LASTEXITCODE -ne 0) { throw 'Rust lint failed' }
    npm test
    if ($LASTEXITCODE -ne 0) { throw 'Worker tests failed' }
    npm run typecheck
    if ($LASTEXITCODE -ne 0) { throw 'Type checking failed' }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Web/Worker build failed' }
} finally { Pop-Location }
