#Requires -Version 5.1
<#
.SYNOPSIS
  Deploy a SnakeArcade checkout to the IIS content root and restart the Node service.

.DESCRIPTION
  Used by .github/workflows/deploy.yml on the self-hosted runner (Windows
  PowerShell 5.1). It can also be run by hand on the server.

  Steps:
    1. Pre-flight checks (paths, service, robocopy, node_modules present).
    2. Stop the WinSW service (default SnakeArcadeNode).
    3. Back up data\settings.json outside the content root.
    4. Mirror the checkout into the content root with robocopy /MIR.
       Never copied or purged: data\, .git\, .github\, logs\, .vs\,
       web.config, *.log, WinSW wrapper files (<ServiceName>.exe/.xml/...),
       plus anything passed in -ExtraExcludeDirs / -ExtraExcludeFiles.
    5. Verify data\settings.json is byte-identical (restore from backup if not).
    6. Start the service.
    7. Poll http://localhost:<Port>/api/health until it answers ok=true,
       then (optionally) the public URL.

  Robocopy exit codes 0-7 are success; 8 or higher is a failure.

  Exit code: 0 on success, 1 on any failure.

.EXAMPLE
  # Preview what would be copied / purged, without touching anything:
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy.ps1 -DryRun

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy.ps1 `
    -SourceDir C:\actions-runner\_work\SnakeArcade\SnakeArcade `
    -AppRoot C:\WebApps\SnakeArcade -ServiceName SnakeArcadeNode -Port 3105
#>
[CmdletBinding()]
param(
  # ---- Parameters (defaults match production; the workflow passes them explicitly) ----
  [string]$SourceDir = "",
  [string]$AppRoot = "C:\WebApps\SnakeArcade",
  [string]$ServiceName = "SnakeArcadeNode",
  [int]$Port = 3105,
  [string]$PublicUrl = "https://snakearcade.socha3.com/",
  [switch]$RequirePublicHealthy,
  [string]$BackupRoot = "C:\WebApps\SnakeArcade-backups",
  [int]$KeepBackups = 20,
  [int]$HealthRetries = 30,
  [int]$HealthDelaySeconds = 2,
  [int]$ServiceTimeoutSeconds = 60,
  [string[]]$ExtraExcludeDirs = @(),
  [string[]]$ExtraExcludeFiles = @(),
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "=== $Message ===" -ForegroundColor Cyan
}

function Resolve-FullPath([string]$PathValue) {
  return ([System.IO.Path]::GetFullPath($PathValue)).TrimEnd("\")
}

function Get-FileSha256([string]$PathValue) {
  if (-not (Test-Path -LiteralPath $PathValue -PathType Leaf)) {
    return $null
  }
  return (Get-FileHash -LiteralPath $PathValue -Algorithm SHA256).Hash
}

function Wait-ServiceStatus([string]$Name, [string]$Status, [int]$TimeoutSeconds) {
  $svcObj = Get-Service -Name $Name
  try {
    $svcObj.WaitForStatus($Status, [TimeSpan]::FromSeconds($TimeoutSeconds))
  } catch {
    $svcObj.Refresh()
    throw "Service $Name did not reach '$Status' within $TimeoutSeconds s (now: $($svcObj.Status))."
  }
}

function Start-AppService([string]$Name, [int]$TimeoutSeconds) {
  $svcObj = Get-Service -Name $Name
  if ($svcObj.Status -ne "Running") {
    Start-Service -Name $Name
  }
  Wait-ServiceStatus -Name $Name -Status "Running" -TimeoutSeconds $TimeoutSeconds
  Write-Host "Service ${Name}: Running"
}

function Test-HealthUrl([string]$Url, [int]$Retries, [int]$DelaySeconds, [int]$ExpectedPort) {
  for ($i = 1; $i -le $Retries; $i++) {
    try {
      # Cache-busting query: IIS ARR caches /api/health briefly and ignores the
      # request Cache-Control header, so a stale 200 could mask a 502.
      $sep = if ($Url.Contains("?")) { "&" } else { "?" }
      $probe = "$Url${sep}nocache=$([DateTime]::UtcNow.Ticks)"
      $resp = Invoke-WebRequest -Uri $probe -UseBasicParsing -TimeoutSec 10 `
        -Headers @{ "Cache-Control" = "no-cache" }
      $body = $resp.Content | ConvertFrom-Json
      if ([int]$resp.StatusCode -eq 200 -and $body.ok -eq $true) {
        Write-Host ("[{0}/{1}] {2} -> 200 {3}" -f $i, $Retries, $Url, $resp.Content)
        if ($ExpectedPort -gt 0 -and [int]$body.port -ne $ExpectedPort) {
          Write-Warning "Health reports port $($body.port), expected $ExpectedPort."
        }
        return $true
      }
      Write-Host ("[{0}/{1}] {2} -> {3} (ok != true)" -f $i, $Retries, $Url, [int]$resp.StatusCode)
    } catch {
      Write-Host ("[{0}/{1}] {2} -> {3}" -f $i, $Retries, $Url, $_.Exception.Message)
    }
    if ($i -lt $Retries) {
      Start-Sleep -Seconds $DelaySeconds
    }
  }
  return $false
}

$serviceStopped = $false
$exitCode = 0

try {
  # ------------------------------------------------------------------ pre-flight
  Write-Step "Pre-flight"

  if (-not $SourceDir) {
    if ($PSScriptRoot -and (Split-Path -Leaf $PSScriptRoot) -eq "scripts") {
      $SourceDir = Split-Path -Parent $PSScriptRoot
    } else {
      throw "-SourceDir not given and the script is not inside <repo>\scripts."
    }
  }
  $SourceDir = Resolve-FullPath $SourceDir
  $AppRoot = Resolve-FullPath $AppRoot
  $BackupRoot = Resolve-FullPath $BackupRoot

  Write-Host "SourceDir   : $SourceDir"
  Write-Host "AppRoot     : $AppRoot"
  Write-Host "ServiceName : $ServiceName"
  Write-Host "Port        : $Port"
  Write-Host "PublicUrl   : $PublicUrl"
  Write-Host "BackupRoot  : $BackupRoot"
  Write-Host "DryRun      : $DryRun"

  # Guard rails: never mirror onto a drive root, onto the source, or into/over each other.
  if ($AppRoot.Length -le 3 -or ([System.IO.Path]::GetPathRoot($AppRoot)).TrimEnd("\") -eq $AppRoot) {
    throw "Refusing to deploy to drive root '$AppRoot'."
  }
  if ($AppRoot -ieq $SourceDir) {
    throw "SourceDir and AppRoot are the same folder."
  }
  if ($AppRoot.StartsWith("$SourceDir\", [StringComparison]::OrdinalIgnoreCase) -or
      $SourceDir.StartsWith("$AppRoot\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "SourceDir and AppRoot must not be nested inside each other."
  }
  if ($BackupRoot.StartsWith("$AppRoot\", [StringComparison]::OrdinalIgnoreCase) -or $BackupRoot -ieq $AppRoot) {
    throw "BackupRoot must be outside AppRoot (it would be purged by the mirror)."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $SourceDir "server.js") -PathType Leaf)) {
    throw "server.js not found in SourceDir '$SourceDir'."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $SourceDir "node_modules\express") -PathType Container)) {
    throw "node_modules\express missing in SourceDir - run 'npm ci --omit=dev' first."
  }
  if (-not (Test-Path -LiteralPath $AppRoot -PathType Container)) {
    throw "AppRoot '$AppRoot' does not exist. Create it (with web.config and data\) before the first automated deploy."
  }
  if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
    throw "Service '$ServiceName' not found (WinSW wrapper not installed?)."
  }
  $robocopy = Join-Path $env:SystemRoot "System32\robocopy.exe"
  if (-not (Test-Path -LiteralPath $robocopy -PathType Leaf)) {
    throw "robocopy.exe not found at $robocopy."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $AppRoot "web.config") -PathType Leaf)) {
    Write-Warning "No web.config in $AppRoot. The IIS ARR rewrite will not work until one exists (scripts\post-deploy.ps1 can create it). The mirror never creates or deletes web.config."
  }

  # ------------------------------------------------------------------ exclusions
  # Directories are given as full paths (source AND destination side) so only the
  # top-level folders are excluded, not e.g. node_modules\<pkg>\data.
  # Excluded items are neither copied nor purged by /MIR.
  $excludeDirNames = @("data", ".git", ".github", "logs", ".vs") + $ExtraExcludeDirs
  $excludeDirs = @()
  foreach ($name in $excludeDirNames) {
    if (-not $name) { continue }
    $excludeDirs += (Join-Path $SourceDir $name)
    $excludeDirs += (Join-Path $AppRoot $name)
  }
  $excludeFiles = @(
    "web.config",
    "*.log",
    "$ServiceName.exe",
    "$ServiceName.xml",
    "$ServiceName.exe.config",
    "$ServiceName.*.log",
    "*.wrapper.log",
    "*.out.log",
    "*.err.log",
    ".env"
  ) + $ExtraExcludeFiles | Where-Object { $_ }

  $roboArgs = @($SourceDir, $AppRoot, "/MIR", "/XJ", "/R:3", "/W:5", "/NP")
  if ($DryRun) {
    $roboArgs += "/L"
  }
  $roboArgs += "/XD"
  $roboArgs += $excludeDirs
  $roboArgs += "/XF"
  $roboArgs += $excludeFiles

  if ($DryRun) {
    Write-Step "DRY RUN: robocopy /L (nothing is stopped, copied or deleted)"
    & $robocopy @roboArgs
    $rc = $LASTEXITCODE
    Write-Host "robocopy exit code: $rc"
    if ($rc -ge 8) {
      throw "robocopy dry run failed with exit code $rc."
    }
    Write-Host "DRY RUN OK" -ForegroundColor Green
    exit 0
  }

  if (-not (Test-Path -LiteralPath $BackupRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
  }

  # ------------------------------------------------------------------ stop
  Write-Step "Stop service $ServiceName"
  $svc = Get-Service -Name $ServiceName
  if ($svc.Status -ne "Stopped") {
    Stop-Service -Name $ServiceName -Force
  }
  $serviceStopped = $true
  Wait-ServiceStatus -Name $ServiceName -Status "Stopped" -TimeoutSeconds $ServiceTimeoutSeconds
  Write-Host "Service ${ServiceName}: Stopped"

  # ------------------------------------------------------------------ backup data
  Write-Step "Back up player data"
  $settingsPath = Join-Path $AppRoot "data\settings.json"
  $hashBefore = Get-FileSha256 $settingsPath
  $backupFile = $null
  if ($hashBefore) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupFile = Join-Path $BackupRoot "settings-$stamp.json"
    Copy-Item -LiteralPath $settingsPath -Destination $backupFile -Force
    Write-Host "Backed up $settingsPath -> $backupFile (sha256 $hashBefore)"
    Get-ChildItem -LiteralPath $BackupRoot -Filter "settings-*.json" |
      Sort-Object LastWriteTime -Descending |
      Select-Object -Skip $KeepBackups |
      Remove-Item -Force
  } else {
    Write-Host "No $settingsPath yet (server.js creates it on first start)."
  }

  # ------------------------------------------------------------------ mirror
  Write-Step "Mirror $SourceDir -> $AppRoot"
  Write-Host "::group::robocopy output"
  & $robocopy @roboArgs
  $rc = $LASTEXITCODE
  Write-Host "::endgroup::"
  Write-Host "robocopy exit code: $rc (0-7 = success, 8+ = failure)"
  $global:LASTEXITCODE = 0
  if ($rc -ge 8) {
    throw "robocopy failed with exit code $rc."
  }

  # ------------------------------------------------------------------ verify data
  Write-Step "Verify player data untouched"
  New-Item -ItemType Directory -Path (Join-Path $AppRoot "data") -Force | Out-Null
  $hashAfter = Get-FileSha256 $settingsPath
  if ($hashBefore -and ($hashAfter -ne $hashBefore)) {
    Copy-Item -LiteralPath $backupFile -Destination $settingsPath -Force
    throw "data\settings.json changed during the mirror (before $hashBefore, after $hashAfter). Restored it from $backupFile."
  }
  Write-Host "data\settings.json OK"

  # ------------------------------------------------------------------ start
  Write-Step "Start service $ServiceName"
  Start-AppService -Name $ServiceName -TimeoutSeconds $ServiceTimeoutSeconds
  $serviceStopped = $false

  # ------------------------------------------------------------------ health
  Write-Step "Health check (local)"
  $localHealth = "http://localhost:$Port/api/health"
  if (-not (Test-HealthUrl -Url $localHealth -Retries $HealthRetries -DelaySeconds $HealthDelaySeconds -ExpectedPort $Port)) {
    throw "Local health check failed: $localHealth did not return ok=true after $HealthRetries tries."
  }

  if ($PublicUrl) {
    Write-Step "Health check (public)"
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $publicHealth = $PublicUrl.TrimEnd("/") + "/api/health"
    $publicRetries = [Math]::Max(1, [int]($HealthRetries / 3))
    if (-not (Test-HealthUrl -Url $publicHealth -Retries $publicRetries -DelaySeconds $HealthDelaySeconds -ExpectedPort 0)) {
      if ($RequirePublicHealthy) {
        throw "Public health check failed: $publicHealth"
      }
      Write-Host "::warning::Public health check failed for $publicHealth (local check passed; not fatal without -RequirePublicHealthy)."
    }
  }

  Write-Host ""
  Write-Host "DEPLOY OK" -ForegroundColor Green
} catch {
  $exitCode = 1
  Write-Host "::error::Deploy failed: $($_.Exception.Message)"
  if ($serviceStopped) {
    # Do not leave the site down: try to bring the service back up, but still fail the job.
    try {
      Write-Host "Attempting to start $ServiceName after failure..."
      Start-AppService -Name $ServiceName -TimeoutSeconds $ServiceTimeoutSeconds
    } catch {
      Write-Host "::error::Could not restart ${ServiceName}: $($_.Exception.Message)"
    }
  }
}

exit $exitCode
