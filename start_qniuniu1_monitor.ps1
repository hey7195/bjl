param(
    [Parameter(Position = 0)]
    [string]$TableName = ""
)

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) {
    throw "Chrome not found: $chrome"
}

$profile = Join-Path $root "chrome_debug_profile"
$url = "http://6.zd10086.com/"
$port = 9222

New-Item -ItemType Directory -Force -Path $profile | Out-Null

try {
    Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/json/version" -TimeoutSec 1 | Out-Null
    Write-Host "DevTools port already available: $port"
} catch {
    Start-Process -FilePath $chrome -ArgumentList @(
        "--remote-debugging-port=$port",
        "--user-data-dir=$profile",
        "--no-first-run",
        "--disable-features=Translate",
        $url
    )
    Write-Host "Chrome debug started: $url"
    Start-Sleep -Seconds 3
}

if ([string]::IsNullOrWhiteSpace($TableName)) {
    $TableName = "Q" + [char]0x725B + [char]0x725B + "1" + [char]0x53F7
}

$safeLabel = $TableName -replace '[^A-Za-z0-9\u4e00-\u9fff]+', '_'
$safeLabel = $safeLabel.Trim('_')
if ([string]::IsNullOrWhiteSpace($safeLabel)) {
    $safeLabel = "target_table"
}

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$out = Join-Path $root "recordings\${safeLabel}_monitor_$stamp"
New-Item -ItemType Directory -Force -Path $out | Out-Null

Write-Host ""
Write-Host "Output dir:"
Write-Host $out
Write-Host ""
Write-Host "Monitoring target table from the real browser WebSocket:"
Write-Host $TableName
Write-Host "Console only prints target table and target results. All sent/received frames are still saved."
Write-Host "Stop with Ctrl+C. Summary will be written on normal stop."
Write-Host ""

$nodeArgs = @(
    "--experimental-websocket",
    (Join-Path $root "baccarat_one_monitor.js"),
    "--port", "$port",
    "--target", "6.zd10086.com",
    "--ws-filter", "gate1/socket.io",
    "--seconds", "0",
    "--label", "$safeLabel",
    "--table-name", "$TableName",
    "--table-short", "",
    "--table-code", "",
    "--out", "$out"
)
& node @nodeArgs
