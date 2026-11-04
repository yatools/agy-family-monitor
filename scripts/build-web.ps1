$ErrorActionPreference = 'Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Web/Worker build failed' }
} finally { Pop-Location }

