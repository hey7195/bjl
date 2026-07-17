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
$out = Join-Path $root "recordings\browser_real_ws_$stamp"
New-Item -ItemType Directory -Force -Path $out | Out-Null

Write-Host ""
Write-Host "Output dir:"
Write-Host $out
Write-Host ""
Write-Host "Use the opened Chrome window normally."
Write-Host "Capturing real browser WebSocket frames for gate1/socket.io."
Write-Host "Stop with Ctrl+C or close this window."
Write-Host ""

$nodeArgs = @(
    "--experimental-websocket",
    (Join-Path $root "browser_ws_capture.js"),
    "--port", "$port",
    "--target", "6.zd10086.com",
    "--ws-filter", "gate1/socket.io",
    "--seconds", "0",
    "--out", "$out"
)
& node @nodeArgs
