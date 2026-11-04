param([string]$OutputFile)
$ErrorActionPreference='Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    if(-not $OutputFile){$OutputFile=Join-Path (Get-Location) ('.local/backups/agy-'+[DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss')+'.sql')}
    $taskPath=[IO.Path]::GetFullPath($OutputFile)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $taskPath)|Out-Null
    $taskExportLog = node scripts/wrangler.mjs d1 export agy-family-monitor --config apps/worker/wrangler.jsonc --remote --output $taskPath 2>&1
    if($LASTEXITCODE -ne 0){throw 'D1 export failed'}
    $taskExportLog | Where-Object { "$_" -notmatch 'X-Amz-' } | Write-Output
    (Get-FileHash -LiteralPath $taskPath -Algorithm SHA256).Hash.ToLowerInvariant()|Set-Content -LiteralPath ($taskPath+'.sha256')
    Write-Output $taskPath
} finally {Pop-Location}
