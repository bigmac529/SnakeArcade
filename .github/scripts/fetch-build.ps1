#Requires -Version 5.1
<#
.SYNOPSIS
  Download a SnakeArcade build zip from its GitHub Release, check its SHA-256
  against the value the workflow already verified, and extract it to a clean
  staging folder. Runs on the self-hosted runner (Windows PowerShell 5.1).

  Writes STAGING_DIR=<folder> to $GITHUB_ENV for the deploy step.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string]$Tag,
  [Parameter(Mandatory)] [string]$Sha256,
  [Parameter(Mandatory)] [string]$WorkDir,
  [string]$Repo = $env:GITHUB_REPOSITORY,
  # Local zip instead of downloading (tests / manual use).
  [string]$ZipPath = ""
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ($Tag -notmatch '^build-\d+-[0-9a-f]{7}$') { throw "Bad build tag '$Tag'." }
$Sha256 = $Sha256.Trim().ToLowerInvariant()
if ($Sha256 -notmatch '^[0-9a-f]{64}$') { throw "Bad SHA-256 '$Sha256'." }

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$zipName = "snakearcade-$Tag.zip"
$zip = Join-Path $WorkDir $zipName
$staging = Join-Path $WorkDir "snakearcade-$Tag"

if ($ZipPath) {
  Copy-Item -LiteralPath $ZipPath -Destination $zip -Force
} else {
  # The repo is public: release assets download without a token.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $url = "https://github.com/$Repo/releases/download/$Tag/$zipName"
  Write-Host "Downloading $url"
  for ($i = 1; $i -le 3; $i++) {
    try {
      Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 300
      break
    } catch {
      if ($i -eq 3) { throw "Download failed: $($_.Exception.Message)" }
      Start-Sleep -Seconds (5 * $i)
    }
  }
}

$actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $Sha256) {
  throw "SHA-256 mismatch for ${zipName}: expected $Sha256, got $actual. Not deploying."
}
Write-Host "SHA-256 OK: $actual"

if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $staging)
Remove-Item -LiteralPath $zip -Force

$infoPath = Join-Path $staging "build-info.json"
if (-not (Test-Path -LiteralPath $infoPath)) { throw "build-info.json missing from $zipName." }
$info = Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json
if ($info.tag -ne $Tag) { throw "build-info.json says '$($info.tag)', expected '$Tag'." }
foreach ($need in @("server.js", "node_modules\express")) {
  if (-not (Test-Path -LiteralPath (Join-Path $staging $need))) { throw "$need missing from $zipName." }
}
Write-Host "Extracted $Tag (commit $($info.sha), built $($info.builtAt)) to $staging"

if ($env:GITHUB_ENV) {
  # UTF-8 without BOM (Out-File -Encoding utf8 adds one on Windows PowerShell 5.1).
  [IO.File]::AppendAllText($env:GITHUB_ENV, "STAGING_DIR=$staging`n")
}
