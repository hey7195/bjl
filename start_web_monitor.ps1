$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$nodeArgs = @(
    "--experimental-websocket",
    ".\web_monitor\server.js",
    "--port",
    "9333"
)

Write-Host "Starting web monitor..."
Write-Host "URL: http://127.0.0.1:9333"
Write-Host "Data: $PSScriptRoot\web_monitor\data"
Write-Host "Stop with Ctrl+C."
node @nodeArgs
