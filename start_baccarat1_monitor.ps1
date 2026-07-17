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

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$out = Join-Path $root "recordings\baccarat1_monitor_$stamp"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$tableName = [string]([char]0x767E) + [char]0x5BB6 + [char]0x4E50 + "1" + [char]0x53F7
$tableShort = [string]([char]0x767E) + "1"

Write-Host ""
Write-Host "Output dir:"
Write-Host $out
Write-Host ""
Write-Host "Monitoring baccarat table 1 from the real browser WebSocket."
Write-Host "Stop with Ctrl+C. Summary will be written on normal stop."
Write-Host ""

$nodeArgs = @(
    "--experimental-websocket",
    (Join-Path $root "baccarat_one_monitor.js"),
    "--port", "$port",
    "--target", "6.zd10086.com",
    "--ws-filter", "gate1/socket.io",
    "--seconds", "0",
    "--label", "baccarat1",
    "--table-name", "$tableName",
    "--table-short", "$tableShort",
    "--table-code", "",
    "--out", "$out"
)
& node @nodeArgs
