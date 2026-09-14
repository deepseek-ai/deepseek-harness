# Run native Electron cleanup and NSIS replacement checks against the prepared Windows target.
param(
  [Parameter(Mandatory)][string]$Electron,
  [Parameter(Mandatory)][string]$Makensis,
  [Parameter(Mandatory)][string]$SevenZip,
  [Parameter(Mandatory)][string]$PluginDir
)
$ErrorActionPreference = 'Stop'
$desktopRoot = Split-Path $PSScriptRoot -Parent
$scratch = [System.IO.Directory]::CreateTempSubdirectory('dsh-desktop-native-').FullName
$fixtureRoot = Join-Path $desktopRoot 'tests/fixtures'

function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
  & $Executable @Arguments | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "$Executable exited with $LASTEXITCODE" }
}

try {
  $previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
  try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    Invoke-Checked $electron @((Join-Path $fixtureRoot 'owned-directory-smoke.mjs'))
  } finally { $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode }

  $cleanupExe = Join-Path $scratch 'cleanup.exe'
  $cleanupResult = Join-Path $scratch 'cleanup.txt'
  Invoke-Checked $Makensis @('/V2', "/DOUTPUT_FILE=$cleanupExe", "/DRESULT_FILE=$cleanupResult", (Join-Path $fixtureRoot 'installer-cleanup-smoke.nsi'))
  Invoke-Checked $cleanupExe @('/S')
  if ((Get-Content -LiteralPath $cleanupResult -Raw) -ne 'scratch removed; archive, plugin, rollback, registers and error flags preserved') {
    throw 'NSIS cleanup did not preserve its sentinels'
  }

  $payload = Join-Path $scratch 'payload'
  New-Item -ItemType Directory -Path $payload | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $payload 'locked.txt'), 'new runtime')
  [System.IO.File]::WriteAllText((Join-Path $payload 'asset.txt'), 'new asset')
  $archive = Join-Path $scratch 'payload.7z'
  Invoke-Checked $SevenZip @('a', '-bd', '-t7z', $archive, "$payload/*")
  foreach ($mode in @('copy', 'direct')) {
    $target = Join-Path $scratch $mode
    New-Item -ItemType Directory -Path $target | Out-Null
    $locked = Join-Path $target 'locked.txt'
    [System.IO.File]::WriteAllText($locked, 'old runtime')
    $probeExe = Join-Path $scratch "$mode.exe"
    $probeResult = Join-Path $scratch "$mode.txt"
    $compileArgs = @('/V2', "/DOUTPUT_FILE=$probeExe", "/DRESULT_FILE=$probeResult", "/DPAYLOAD_FILE=$archive", "/DTARGET_DIR=$target", "/DPLUGIN_DIR=$PluginDir")
    if ($mode -eq 'direct') { $compileArgs += '/DDIRECT' }
    $compileArgs += Join-Path $fixtureRoot 'installer-write-failure-smoke.nsi'
    Invoke-Checked $Makensis $compileArgs
    $handle = [System.IO.File]::Open($locked, 'Open', 'Read', 'Read')
    try { Invoke-Checked $probeExe @('/S') }
    finally { $handle.Dispose() }
    $flag = if ($mode -eq 'copy') { 'true' } else { 'false' }
    $expected = "errorFlag=$flag`nlocked=old runtime`nasset=new asset"
    if ((Get-Content -LiteralPath $probeResult -Raw).Replace("`r`n", "`n").TrimEnd() -ne $expected) {
      throw "Unexpected NSIS $mode replacement result"
    }
  }
  Write-Output 'Electron cleanup and NSIS cleanup/replacement smokes passed.'
} finally {
  $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  $resolvedScratch = [System.IO.Path]::GetFullPath($scratch)
  if (-not $resolvedScratch.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing cleanup outside the temporary root: $resolvedScratch"
  }
  Remove-Item -LiteralPath $resolvedScratch -Recurse -Force
}
