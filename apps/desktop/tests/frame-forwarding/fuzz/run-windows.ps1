<#
.SYNOPSIS
Builds and runs the frame-forwarding native fuzz targets with MSVC AddressSanitizer and libFuzzer.

.DESCRIPTION
Compiles the harnesses in this directory against a native source snapshot, never against the working tree, so a fuzz
run is unaffected by edits in flight. The snapshot is the directory that contains `transport.cc` and `transport.h`, for example an export of `git archive HEAD
packages/experimental/frame-forwarding/native`.

`cl.exe` is not on PATH. The script locates `vcvarsall.bat`, builds through it, and puts the MSVC bin directory that
holds `clang_rt.asan_dynamic-x86_64.dll` on PATH for the runs.

.PARAMETER NativeDir
Directory of the native source snapshot to compile. Required.

.PARAMETER WorkDir
Directory for binaries, the generated corpus, crash artifacts, and logs. Defaults to `%TEMP%\dsh-frame-forwarding-fuzz\work`.

.PARAMETER CorpusDir
Checked-in seed corpus merged into the generated corpus. Defaults to `corpus` beside this script.

.PARAMETER Targets
Fuzz targets to handle: `packet`, `endpoint`, or both. Defaults to both.

.PARAMETER MaxTotalTime
Seconds each fuzz target runs. Defaults to 600.

.PARAMETER Build
Build only, or build before running.

.PARAMETER Run
Run only, or build before running. Passing neither builds and runs.

.EXAMPLE
.\run-windows.ps1 -NativeDir "$env:TEMP\dsh-frame-forwarding-fuzz\src\packages\experimental\frame-forwarding\native" -Build
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$NativeDir,
  [string]$WorkDir = (Join-Path $env:TEMP 'dsh-frame-forwarding-fuzz\work'),
  [string]$CorpusDir = (Join-Path $PSScriptRoot 'corpus'),
  [ValidateSet('packet', 'endpoint')][string[]]$Targets = @('packet', 'endpoint'),
  [int]$MaxTotalTime = 600,
  [switch]$Build,
  [switch]$Run,
  [string]$VcVarsAll = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# The longest input each target needs: a packet with a full text, or a credential built from a few hundred bytes.
$maxLengths = @{ packet = 20000; endpoint = 4096 }

function Find-VcVarsAll {
  if ($VcVarsAll) {
    if (-not (Test-Path -LiteralPath $VcVarsAll)) { throw "vcvarsall.bat not found: $VcVarsAll" }
    return $VcVarsAll
  }
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  $roots = @()
  if (Test-Path -LiteralPath $vswhere) {
    $roots = @(& $vswhere -all -products * -property installationPath 2>$null)
  }
  $roots += @(
    'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools',
    'C:\Program Files\Microsoft Visual Studio\2022\BuildTools',
    'C:\Program Files\Microsoft Visual Studio\2022\Community'
  )
  foreach ($root in $roots) {
    $candidate = Join-Path $root 'VC\Auxiliary\Build\vcvarsall.bat'
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  throw 'vcvarsall.bat not found; pass -VcVarsAll with the Visual Studio developer environment script.'
}

function Find-AsanRuntimeDirectory {
  # vcvarsall.bat sits in <installation>\VC\Auxiliary\Build; the MSVC tools are under the same VC directory.
  $vc = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $script:vcvars))
  $tools = Join-Path $vc 'Tools\MSVC'
  if (-not (Test-Path -LiteralPath $tools)) { throw "MSVC tools directory not found: $tools" }
  $directory = Get-ChildItem -LiteralPath $tools -Directory |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName 'bin\Hostx64\x64' } |
      Where-Object { Test-Path -LiteralPath (Join-Path $_ 'clang_rt.asan_dynamic-x86_64.dll') } |
      Select-Object -First 1
  if (-not $directory) { throw 'clang_rt.asan_dynamic-x86_64.dll not found under the MSVC tools directories.' }
  return $directory
}

# Run a command line inside the developer environment of vcvarsall.bat.
function Invoke-DeveloperCommand([string]$CommandLine) {
  $batch = Join-Path $WorkDir 'invoke-developer-command.bat'
  @(
    '@echo off',
    "cd /d `"$WorkDir`"",
    "call `"$script:vcvars`" x64 >nul || exit /b 1",
    $CommandLine
  ) | Set-Content -LiteralPath $batch -Encoding ascii
  & cmd.exe /c $batch
  if ($LASTEXITCODE -ne 0) { throw "developer command failed ($LASTEXITCODE): $CommandLine" }
}

function Build-Target([string]$Name, [string]$Source, [string]$Extra) {
  $native = (Resolve-Path -LiteralPath $NativeDir).Path
  $exe = Join-Path $WorkDir "$Name.exe"
  Write-Host "building $Name"
  Invoke-DeveloperCommand "cl /nologo /std:c++17 /O1 /Zi /EHsc /MD $Extra /D_WIN32_WINNT=0x0602 /I`"$native`" `"$Source`" /Fe:`"$exe`" /Fd:`"$WorkDir\$Name.pdb`" /Fo:`"$WorkDir\$Name.obj`" /link /DEBUG /INCREMENTAL:NO d3d11.lib dxgi.lib advapi32.lib bcrypt.lib"
  return $exe
}

# Each target keeps its own corpus: a wire packet is meaningless to the credential parser and the other way round.
function New-Corpus([string]$Target) {
  $corpus = Join-Path $WorkDir "corpus-$Target"
  New-Item -ItemType Directory -Force -Path $corpus | Out-Null
  if (Test-Path -LiteralPath $CorpusDir) {
    Copy-Item -Path (Join-Path $CorpusDir '*.bin') -Destination $corpus -Force -ErrorAction SilentlyContinue
  }
  $generator = Join-Path $WorkDir 'corpus-gen.exe'
  & $generator $corpus 'extras'
  if ($LASTEXITCODE -ne 0) { throw 'corpus-gen failed' }
  return $corpus
}

$script:vcvars = Find-VcVarsAll
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
if (-not $Build -and -not $Run) { $Build = $true; $Run = $true }

if ($Build) {
  Build-Target 'corpus-gen' (Join-Path $PSScriptRoot 'corpus-gen.cc') '' | Out-Null
  $sanitized = '/fsanitize=address /fsanitize=fuzzer'
  foreach ($target in $Targets) {
    Build-Target "$target-fuzzer" (Join-Path $PSScriptRoot "$target-fuzzer.cc") $sanitized | Out-Null
  }
}

if ($Run) {
  $env:PATH = "$(Find-AsanRuntimeDirectory);$env:PATH"
  $logs = Join-Path $WorkDir 'logs'
  New-Item -ItemType Directory -Force -Path $logs | Out-Null
  foreach ($target in $Targets) {
    $corpus = New-Corpus $target
    $artifacts = Join-Path $WorkDir "artifacts-$target"
    New-Item -ItemType Directory -Force -Path $artifacts | Out-Null
    $log = Join-Path $logs "$target-fuzzer.log"
    Write-Host "fuzzing $target for $MaxTotalTime s; log $log"
    & (Join-Path $WorkDir "$target-fuzzer.exe") `
        "-max_total_time=$MaxTotalTime" '-timeout=10' '-rss_limit_mb=2048' "-max_len=$($maxLengths[$target])" `
        '-print_final_stats=1' "-artifact_prefix=$artifacts/" $corpus 2>&1 | Tee-Object -FilePath $log
    if ($LASTEXITCODE -ne 0) { Write-Warning "$target fuzzer exited with $LASTEXITCODE; see $artifacts" }
  }
}
