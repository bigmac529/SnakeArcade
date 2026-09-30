<#
.SYNOPSIS
  Package a SnakeArcade checkout (with production node_modules already installed)
  into an immutable build zip: snakearcade-<Tag>.zip + .sha256 + build-info.json.

  Used by .github/workflows/build-and-deploy-test.yml (pwsh on windows-latest).
  Everything except .git\ and .github\ goes in, the same set the old deploy
  mirrored from the checkout.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string]$SourceDir,
  [Parameter(Mandatory)] [string]$OutDir,
  [Parameter(Mandatory)] [string]$Tag,
  [Parameter(Mandatory)] [string]$Sha,
  [Parameter(Mandatory)] [int]$Number,
  [string]$Ref = "",
  [string]$RunUrl = ""
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem

if ($Tag -notmatch '^build-\d+-[0-9a-f]{7}$') { throw "Bad tag '$Tag' (want build-<number>-<sha7>)." }
if ($Sha -notmatch '^[0-9a-f]{40}$') { throw "Bad commit SHA '$Sha'." }
$SourceDir = (Resolve-Path -LiteralPath $SourceDir).Path
foreach ($need in @("server.js", "package.json", "node_modules")) {
  if (-not (Test-Path -LiteralPath (Join-Path $SourceDir $need))) {
    throw "$need missing in $SourceDir (run npm ci --omit=dev first)."
  }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path
$stage = Join-Path $OutDir "stage"
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

Get-ChildItem -LiteralPath $SourceDir -Force |
  Where-Object { $_.Name -notin @(".git", ".github") } |
  ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $stage -Recurse -Force }

$info = [ordered]@{
  tag     = $Tag
  number  = $Number
  sha     = $Sha
  ref     = $Ref
  runUrl  = $RunUrl
  builtAt = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
  node    = (& node --version 2>$null)
}
$info | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage "build-info.json") -Encoding utf8

$zipName = "snakearcade-$Tag.zip"
$zip = Join-Path $OutDir $zipName
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
Remove-Item -LiteralPath $stage -Recurse -Force

$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $zipName" | Set-Content -LiteralPath "$zip.sha256" -Encoding ascii -NoNewline
$count = ([System.IO.Compression.ZipFile]::OpenRead($zip)).Entries.Count
Write-Host ("{0}: {1:N1} MB, {2} entries, sha256 {3}" -f $zipName, ((Get-Item -LiteralPath $zip).Length / 1MB), $count, $hash)

if ($env:GITHUB_OUTPUT) {
  [IO.File]::AppendAllText($env:GITHUB_OUTPUT, "zip=$zip`nsha256=$hash`n")
}
