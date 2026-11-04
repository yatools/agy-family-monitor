param(
    [Parameter(Mandatory=$true)][string]$AdminEmail,
    [string]$AdminName='家庭管理员',
    [switch]$Remote
)
$ErrorActionPreference='Stop'
$taskAddress=[System.Net.Mail.MailAddress]::new($AdminEmail).Address.ToLowerInvariant()
if ($taskAddress -ne $AdminEmail.ToLowerInvariant()) { throw 'Supply an email address without a display name' }
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    New-Item -ItemType Directory -Force -Path '.local' | Out-Null
    $taskFile=Join-Path (Get-Location) '.local/bootstrap-admin.sql'
    $taskId=[guid]::NewGuid().ToString()
    $taskNow=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $taskEmailSql=$taskAddress.Replace("'","''")
    $taskNameSql=$AdminName.Replace("'","''")
    $taskSql="INSERT OR IGNORE INTO members(id,email,display_name,role,created_at_ms) SELECT '$taskId','$taskEmailSql','$taskNameSql','admin',$taskNow WHERE NOT EXISTS(SELECT 1 FROM members WHERE role='admin');"
    [IO.File]::WriteAllText($taskFile,$taskSql,[Text.UTF8Encoding]::new($false))
    $taskMode=if($Remote){'--remote'}else{'--local'}
    node scripts/wrangler.mjs d1 execute agy-family-monitor --config apps/worker/wrangler.jsonc $taskMode --file $taskFile
    if($LASTEXITCODE -ne 0){throw 'Administrator bootstrap failed'}
} finally {Pop-Location}
