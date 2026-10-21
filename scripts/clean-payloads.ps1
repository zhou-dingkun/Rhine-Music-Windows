<#
.SYNOPSIS
  Removes stale Rhine Player runtime payloads from the local app data folder.

.DESCRIPTION
  Every build extracts its run resources to %LOCALAPPDATA%\Rhine Music\app-v<version>,
  and nothing deletes the previous ones, so the folder grows by roughly 90 MB per build.
  This script keeps the payload used by the running executable plus the newest N payloads
  and deletes the rest. The library data folder (music-data-v3) is never touched: only
  directories named app-v<major>.<minor>.<patch>[-dev.<n>] are considered.

.PARAMETER Keep
  Number of newest payloads to keep in addition to the one the running executable uses.

.PARAMETER WhatIf
  Report what would be deleted without removing anything.
#>
param(
  [string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'Rhine Music'),
  [int]$Keep = 1,
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $DataRoot -PathType Container)) {
  throw "Rhine Player data folder not found: $DataRoot"
}
$resolvedRoot = (Resolve-Path -LiteralPath $DataRoot).Path.TrimEnd('\')
if ($resolvedRoot -notmatch 'Rhine Music$') {
  throw "Refusing to clean '$resolvedRoot'; expected the Rhine Music data folder."
}

# Payload folders are exactly app-v<version>; anything else in the data folder is left alone.
$payloadPattern = '^app-v\d+\.\d+\.\d+(?:-dev\.\d+)?$'
$payloads = Get-ChildItem -LiteralPath $resolvedRoot -Directory |
  Where-Object { $_.Name -match $payloadPattern } |
  Sort-Object LastWriteTime -Descending

# Never delete the payload the running executable booted from.
$activeVersion = $null
foreach ($process in Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*Rhine*Desktop*' }) {
  try {
    $productVersion = (Get-Item -LiteralPath $process.Path).VersionInfo.ProductVersion
    if ($productVersion -match '^\d+\.\d+\.\d+(?:-dev\.\d+)?$') { $activeVersion = $productVersion }
  } catch {
    # A process whose path is unavailable (elevated or already exiting) simply does not protect more.
  }
}
$activeName = if ($activeVersion) { "app-v$activeVersion" } else { $null }

$protected = @()
if ($activeName) { $protected += $activeName }
$protected += ($payloads | Where-Object { $_.Name -ne $activeName } | Select-Object -First $Keep).Name
$victims = $payloads | Where-Object { $protected -notcontains $_.Name }

if (-not $payloads.Count) {
  "No runtime payloads found in $resolvedRoot."
  exit 0
}

"Data folder : $resolvedRoot"
"Running     : $(if ($activeName) { $activeName } else { '(no Rhine Player process detected)' })"
"Keeping     : $(if ($protected.Count) { $protected -join ', ' } else { '(none)' })"
"Removing    : $($victims.Count) payload(s)"

$freed = 0L
foreach ($victim in $victims) {
  $path = $victim.FullName
  if (-not $path.StartsWith($resolvedRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to delete outside the data folder: $path"
  }
  if ($protected -contains $victim.Name) { continue }
  $size = (Get-ChildItem -LiteralPath $path -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
  if ($WhatIf) {
    "  would remove {0} ({1:N1} MB)" -f $victim.Name, ($size / 1MB)
    $freed += $size
    continue
  }
  try {
    Remove-Item -LiteralPath $path -Recurse -Force
    "  removed {0} ({1:N1} MB)" -f $victim.Name, ($size / 1MB)
    $freed += $size
  } catch {
    "  skipped {0}: {1}" -f $victim.Name, $_.Exception.Message
  }
}

$label = if ($WhatIf) { 'Would free' } else { 'Freed' }
"{0} {1:N1} MB of payload space." -f $label, ($freed / 1MB)
