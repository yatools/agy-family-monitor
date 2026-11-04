param()
$ErrorActionPreference='Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    if(-not (Test-Path -LiteralPath 'artifacts/AgyFamilyMonitor.exe')){throw 'Build the Windows client with scripts/build-agent.ps1 before publishing downloads'}
    npm run build
    if($LASTEXITCODE -ne 0){throw 'Build failed; deployment stopped'}
    node scripts/wrangler.mjs deploy --config apps/worker/wrangler.jsonc
    if($LASTEXITCODE -ne 0){throw 'Cloudflare deployment failed'}
} finally {Pop-Location}
