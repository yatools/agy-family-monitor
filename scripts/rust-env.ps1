# Dot-source before using Cargo when the repository contains non-ASCII path segments.
# MinGW's linker cannot reliably open Unicode output paths. Keep build output in TEMP.
if (-not $env:CARGO_TARGET_DIR) {
    $env:CARGO_TARGET_DIR = Join-Path ([IO.Path]::GetTempPath()) 'agy-family-monitor-target'
}

