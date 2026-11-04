param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[^@\s]+@[^@\s]+\.[^@\s]+$')][string]$From,
    [Parameter(Mandatory=$true)][ValidatePattern('^[^@\s]+@[^@\s]+\.[^@\s]+$')][string]$To,
    [switch]$Remote
)
$ErrorActionPreference='Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    New-Item -ItemType Directory -Force -Path '.local' | Out-Null
    $taskEmail=@{from=$From;to=$To}|ConvertTo-Json -Compress
    $taskEscaped=$taskEmail.Replace("'","''")
    $taskSql="INSERT INTO settings(key,value) VALUES('monitor_email','$taskEscaped') ON CONFLICT(key) DO UPDATE SET value=excluded.value;"
    $taskSql|Set-Content -LiteralPath '.local/configure-email.sql' -Encoding utf8
    $taskMode=if($Remote){'--remote'}else{'--local'}
    node scripts/wrangler.mjs d1 execute agy-family-monitor --config apps/worker/wrangler.jsonc $taskMode --file .local/configure-email.sql
    if($LASTEXITCODE -ne 0){throw 'Email configuration failed'}
    ConvertTo-Json -InputObject @(@{name='ALERT_EMAIL';destination_address=$To;allowed_sender_addresses=@($From)}) -Depth 5 | Set-Content -LiteralPath '.local/email-bindings.json' -Encoding utf8
    Write-Output 'Email configuration saved privately. The destination must be verified in Cloudflare before deployment.'
} finally {Pop-Location}
