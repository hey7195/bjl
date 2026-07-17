$ErrorActionPreference = "Stop"

$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) {
    throw "Chrome not found: $chrome"
}

$profile = Join-Path $PSScriptRoot "chrome_debug_profile"
$url = "http://6.zd10086.com/"

New-Item -ItemType Directory -Force -Path $profile | Out-Null

Start-Process -FilePath $chrome -ArgumentList @(
    "--remote-debugging-port=9222",
    "--user-data-dir=$profile",
    "--no-first-run",
    "--disable-features=Translate",
    $url
)

Write-Host "Chrome debug started."
Write-Host "URL: $url"
Write-Host "DevTools: http://127.0.0.1:9222/json"
Write-Host "Profile: $profile"
