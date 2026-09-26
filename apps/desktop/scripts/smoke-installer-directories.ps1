# Exercise the production NSIS directory transaction with private installation directories.
param(
  [Parameter(Mandatory)][string]$Makensis,
  [Parameter(Mandatory)][string]$SevenZip,
  [string]$FrameLibrary,
  [scriptblock]$SignExecutable
)
$ErrorActionPreference = 'Stop'
$Makensis = [System.IO.Path]::GetFullPath($Makensis)
$SevenZip = [System.IO.Path]::GetFullPath($SevenZip)
if ($FrameLibrary) { $FrameLibrary = [System.IO.Path]::GetFullPath($FrameLibrary) }
$scratch = [System.IO.Directory]::CreateTempSubdirectory('dsh-directory-smoke-').FullName
$fixture = Join-Path $PSScriptRoot '../tests/fixtures/installer-directory-smoke.nsi'

function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
  & $Executable @Arguments | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "$Executable exited with $LASTEXITCODE" }
}

try {
  $payload = Join-Path $scratch 'payload'
  New-Item -ItemType Directory -Path $payload | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $payload 'asset.txt'), 'new asset')
  $deepPayload = Join-Path $payload (('nested-' * 20) + '\asset-' + ('x' * 60) + '.txt')
  [IO.Directory]::CreateDirectory((Split-Path $deepPayload -Parent)) | Out-Null
  [IO.File]::WriteAllText($deepPayload, 'long path asset')
  $archive = Join-Path $scratch 'payload.7z'
  Invoke-Checked $SevenZip @('a', '-bd', '-t7z', $archive, "$payload/*")
  $brokenArchive = Join-Path $scratch 'broken.7z'
  [System.IO.File]::WriteAllText($brokenArchive, 'invalid archive')

  foreach ($mode in @('first', 'upgrade', 'locked', 'missing-stage', 'broken', 'cancelled')) {
    $caseRoot = Join-Path $scratch $mode
    $target = Join-Path $caseRoot 'Application'
    New-Item -ItemType Directory -Path $caseRoot | Out-Null
    if ($mode -ne 'first') {
      New-Item -ItemType Directory -Path $target | Out-Null
      [System.IO.File]::WriteAllText((Join-Path $target 'asset.txt'), 'old asset')
      [System.IO.File]::WriteAllText((Join-Path $target 'obsolete.txt'), 'old only')
      $oldDeep = Join-Path $target ([IO.Path]::GetRelativePath($payload, $deepPayload))
      [IO.Directory]::CreateDirectory((Split-Path $oldDeep -Parent)) | Out-Null
      [IO.File]::WriteAllText($oldDeep, 'old long path asset')
    }
    $probe = Join-Path $caseRoot 'probe.exe'
    $caseArchive = if ($mode -eq 'broken') { $brokenArchive } else { $archive }
    $reportDir = Join-Path $caseRoot 'installer-logs'
    $compileArgs = @('/V2', "/DOUTPUT_FILE=$probe", "/DPAYLOAD_FILE=$caseArchive", "/DTARGET_DIR=$target", "/DDSH_SEVENZIP_PATH=$SevenZip")
    if ($FrameLibrary) { $compileArgs += @("/DSOURCE_DLL=$FrameLibrary", "/DREPORT_DIR=$reportDir") }
    if ($mode -eq 'missing-stage') { $compileArgs += '/DMISSING_STAGE' }
    if ($mode -eq 'cancelled') { $compileArgs += '/DCANCELLED' }
    Invoke-Checked $Makensis ($compileArgs + $fixture)
    if ($null -ne $SignExecutable) { & $SignExecutable $probe }
    $handle = $null
    $process = $null
    try {
      if ($mode -eq 'locked') {
        $handle = [System.IO.File]::Open((Join-Path $target 'asset.txt'), 'Open', 'Read', 'Read')
      }
      $process = Start-Process -FilePath $probe -ArgumentList '/S' -WindowStyle Hidden -PassThru
      if (-not $process.WaitForExit(60000)) {
        $process.Kill($true)
        $process.WaitForExit()
        throw "Directory smoke $mode did not exit within 60 seconds"
      }
      $expectedExit = if ($mode -in @('first', 'upgrade')) { 0 } else { 2 }
      if ($process.ExitCode -ne $expectedExit) {
        throw "Directory smoke $mode exited with $($process.ExitCode), expected $expectedExit"
      }
    } finally {
      if ($null -ne $handle) { $handle.Dispose() }
      if ($null -ne $process) { $process.Dispose() }
    }
    $expectedAsset = if ($mode -in @('first', 'upgrade')) { 'new asset' } else { 'old asset' }
    if ([System.IO.File]::ReadAllText((Join-Path $target 'asset.txt')) -ne $expectedAsset) {
      throw "Directory smoke $mode changed the wrong version"
    }
    $expectObsolete = $mode -notin @('first', 'upgrade')
    if ((Test-Path -LiteralPath (Join-Path $target 'obsolete.txt')) -ne $expectObsolete) {
      throw "Directory smoke $mode did not preserve the expected old-only file state"
    }
    if (@(Get-ChildItem -LiteralPath $caseRoot -Directory | Where-Object Name -notin @('Application', 'installer-logs')).Count -ne 0) {
      throw "Directory smoke $mode left transaction directories behind"
    }
    if ($FrameLibrary) {
      # Only an extraction failure writes a report; it must quote 7-Zip's verdict so support can read the cause.
      $reports = @(if (Test-Path -LiteralPath $reportDir) { Get-ChildItem -LiteralPath $reportDir -File })
      if ($mode -eq 'broken') {
        if ($reports.Count -ne 1 -or $reports[0].Name -notmatch '^extract-failure-20\d{6}-\d{6}\.log$') {
          throw "Directory smoke $mode did not save exactly one extraction report"
        }
        $report = Get-Content -LiteralPath $reports[0].FullName -Raw -Encoding UTF8
        foreach ($expected in @('Result: 7-Zip exit code 2 (fatal error)', "Archive: $caseArchive", 'Cannot open the file as [7z] archive')) {
          if (-not $report.Contains($expected)) { throw "Directory smoke $mode report lacks '$expected'" }
        }
      } elseif ($reports.Count -ne 0) {
        throw "Directory smoke $mode saved an unexpected extraction report"
      }
    }
    Write-Output "Directory replacement smoke passed: $mode"
  }
} finally {
  $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  $resolvedScratch = [System.IO.Path]::GetFullPath($scratch)
  if (-not $resolvedScratch.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing cleanup outside the temporary root: $resolvedScratch"
  }
  Remove-Item -LiteralPath $resolvedScratch -Recurse -Force
}
