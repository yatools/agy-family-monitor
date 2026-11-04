param([switch]$RegistryFallback)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'rust-env.ps1')
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    if ($RegistryFallback) {
        node scripts/fetch-rust.mjs build --release --locked --offline --bin AgyFamilyMonitor
    } else {
        cargo build --release --locked --bin AgyFamilyMonitor
    }
    if ($LASTEXITCODE -ne 0) { throw 'Rust build failed' }
    $taskOutput = Join-Path (Get-Location) 'artifacts'
    New-Item -ItemType Directory -Force -Path $taskOutput | Out-Null
    Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'release/AgyFamilyMonitor.exe') -Destination $taskOutput
    Copy-Item -LiteralPath 'THIRD_PARTY_NOTICES.md','LICENSE','licenses/CC-Switch-MIT.txt' -Destination $taskOutput
    Copy-Item -LiteralPath 'docs/INSTALLATION.md' -Destination $taskOutput
    Copy-Item -LiteralPath 'docs/MONITORING.md' -Destination $taskOutput
    Copy-Item -LiteralPath 'docs/MEMBERS.md' -Destination $taskOutput
} finally { Pop-Location }

