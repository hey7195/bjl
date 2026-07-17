param(
    [Parameter(Position = 0)]
    [string]$TableName = ""
)

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
Set-Location $root

if ([string]::IsNullOrWhiteSpace($TableName)) {
    $TableName = "Q" + [char]0x725B + [char]0x725B + "1" + [char]0x53F7
}

$safeLabel = $TableName -replace '[^A-Za-z0-9\u4e00-\u9fff]+', '_'
$safeLabel = $safeLabel.Trim('_')
if ([string]::IsNullOrWhiteSpace($safeLabel)) {
    $safeLabel = "target_table"
}

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$out = Join-Path $root "recordings\${safeLabel}_raw_monitor_$stamp"
New-Item -ItemType Directory -Force -Path $out | Out-Null

Write-Host ""
Write-Host "Raw socket monitor, no browser."
Write-Host "Target table:"
Write-Host $TableName
Write-Host ""
Write-Host "Output dir:"
Write-Host $out
Write-Host ""
Write-Host "Stop with Ctrl+C. Summary will be written on normal stop."
Write-Host ""

$nodeArgs = @(
    "--experimental-websocket",
    (Join-Path $root "raw_table_monitor.js"),
    "--table", "$TableName",
    "--label", "$safeLabel",
    "--out", "$out"
)
& node @nodeArgs
