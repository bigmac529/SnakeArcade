#Requires -Version 5.1

<#

.SYNOPSIS

  Post-deploy setup for SnakeArcade on socha3 (IIS + WinSW Node service).



.DESCRIPTION

  Run this on the Windows origin AFTER app files are in C:\WebApps\SnakeArcade

  (or pass -AppRoot). It installs npm deps, ensures data/ + web.config, restarts

  SnakeArcadeNode, and smoke-tests the local Node port.

  Defaults are production. For the test site pass its values, e.g.
  -AppRoot C:\WebApps\SnakeArcadeTest -Port 3107 -ServiceName SnakeArcadeTestNode
  -SiteName SnakeArcadeTest -PublicUrl https://test.snakearcade.socha3.com/

  An existing web.config is never changed (the test site's carries a
  Let's Encrypt renewal rule); one is only created when missing.

  The GitHub Actions pipeline does not use this script (it uses deploy.ps1);
  it is for manual repair and first-time setup.



.EXAMPLE

  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\post-deploy.ps1



.EXAMPLE

  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\post-deploy.ps1 -AppRoot C:\WebApps\SnakeArcade

.EXAMPLE

  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\post-deploy.ps1 -AppRoot C:\WebApps\SnakeArcadeTest -Port 3107 -ServiceName SnakeArcadeTestNode -SiteName SnakeArcadeTest -PublicUrl https://test.snakearcade.socha3.com/

#>

[CmdletBinding()]

param(

  [string]$AppRoot = "",

  [int]$Port = 3105,

  [string]$ServiceName = "SnakeArcadeNode",

  # IIS site / app pool name (only used in the closing hint).
  [string]$SiteName = "SnakeArcade",

  # Public URL, printed at the end.
  [string]$PublicUrl = "https://snakearcade.socha3.com/",

  [switch]$SkipNpm

)



$ErrorActionPreference = "Stop"

$ProgressPreference = "SilentlyContinue"



function Write-Step([string]$Message) {

  Write-Host ""

  Write-Host "=== $Message ===" -ForegroundColor Cyan

}



if (-not $AppRoot) {

  # scripts/ -> repo root; if already running from deployed tree, prefer that folder

  $here = $PSScriptRoot

  if ($here -and (Split-Path -Leaf $here) -eq "scripts") {

    $AppRoot = Split-Path -Parent $here

  } else {

    $AppRoot = "C:\WebApps\SnakeArcade"

  }

}



$AppRoot = [System.IO.Path]::GetFullPath($AppRoot)

Write-Step "AppRoot: $AppRoot"

if (-not (Test-Path -LiteralPath (Join-Path $AppRoot "server.js"))) {

  throw "server.js not found under $AppRoot - copy the app first, then re-run."

}



$webConfigPath = Join-Path $AppRoot "web.config"

$dataDir = Join-Path $AppRoot "data"

$node = "C:\Program Files\nodejs\node.exe"

$npm = "C:\Program Files\nodejs\npm.cmd"



Write-Step "Ensure data directory"

New-Item -ItemType Directory -Path $dataDir -Force | Out-Null



Write-Step "Ensure IIS ARR web.config (create only if missing)"

if (-not (Test-Path -LiteralPath $webConfigPath)) {

  @"

<?xml version="1.0" encoding="UTF-8"?>

<configuration>

  <system.webServer>

    <rewrite>

      <rules>

        <clear />

        <rule name="SnakeArcadeNode" stopProcessing="true">

          <match url="(.*)" />

          <action type="Rewrite" url="http://localhost:$Port/{R:1}" />

        </rule>

      </rules>

    </rewrite>

    <httpErrors existingResponse="PassThrough" />

    <webSocket enabled="true" />

  </system.webServer>

</configuration>

"@ | Set-Content -LiteralPath $webConfigPath -Encoding UTF8

  Write-Host "Wrote new web.config -> localhost:$Port"

} else {

  Write-Host "Keeping existing web.config"

}



if (-not $SkipNpm) {

  Write-Step "npm install (omit dev)"

  if (-not (Test-Path -LiteralPath $npm)) {

    throw "npm not found at $npm"

  }

  Push-Location $AppRoot

  try {

    if (Test-Path -LiteralPath (Join-Path $AppRoot "package-lock.json")) {

      & $npm ci --omit=dev

      if ($LASTEXITCODE -ne 0) {

        Write-Warning "npm ci failed; falling back to npm install --omit=dev"

        & $npm install --omit=dev

      }

    } else {

      & $npm install --omit=dev

    }

    if ($LASTEXITCODE -ne 0) {

      throw "npm install failed with exit $LASTEXITCODE"

    }

  } finally {

    Pop-Location

  }

} else {

  Write-Step "Skipping npm (-SkipNpm)"

}



Write-Step "Restart service $ServiceName"

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue

if (-not $svc) {

  throw "Service '$ServiceName' not found. Install the WinSW service first (C:\Tools\WinSW\$ServiceName.exe)."

}

# Restart-Service also starts a stopped service (first deploy).
Restart-Service -Name $ServiceName -Force

Start-Sleep -Seconds 2

$svc = Get-Service -Name $ServiceName

if ($svc.Status -ne "Running") {

  throw "Service $ServiceName is $($svc.Status) after restart"

}

Write-Host "Service status: $($svc.Status)"



Write-Step "Smoke test Node on localhost:$Port"
if (-not (Test-Path -LiteralPath $node)) {
  throw "node.exe not found at $node"
}

$healthUrl = "http://localhost:$Port/api/health"
$homeUrl = "http://localhost:$Port/"
$playersUrl = "http://localhost:$Port/api/players"
try {
  $health = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 15
  Write-Host ("GET /api/health -> {0} {1}" -f [int]$health.StatusCode, $health.Content)
} catch {
  throw "Smoke test failed for ${healthUrl}: $($_.Exception.Message)"
}
try {
  $homePage = Invoke-WebRequest -Uri $homeUrl -UseBasicParsing -TimeoutSec 15
  Write-Host ("GET / -> {0}" -f [int]$homePage.StatusCode)
} catch {
  throw "Smoke test failed for ${homeUrl}: $($_.Exception.Message)"
}
try {
  $players = Invoke-WebRequest -Uri $playersUrl -UseBasicParsing -TimeoutSec 15
  Write-Host ("GET /api/players -> {0}" -f [int]$players.StatusCode)
} catch {
  throw "Smoke test failed for ${playersUrl}: $($_.Exception.Message)"
}

Write-Host ""

Write-Host "POST-DEPLOY OK" -ForegroundColor Green

Write-Host "Public URL: $PublicUrl"

Write-Host "If IIS still shows old content, recycle: Restart-WebAppPool $SiteName"

