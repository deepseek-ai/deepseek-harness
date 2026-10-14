# Start the existing registered runner with explicit machine configuration and a scrubbed environment.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$RunnerRoot, [Parameter(Mandatory=$true)][string]$ConfigRoot, [switch]$CheckOnly)
$ErrorActionPreference='Stop'
$pwshRoot=Join-Path $RunnerRoot 'tools/pwsh-7.6.6'
$runnerPath = $pwshRoot + ';' + [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
$keep=@('SystemRoot','windir','SystemDrive','ComSpec','TEMP','TMP','USERPROFILE','HOMEDRIVE','HOMEPATH','LOCALAPPDATA','APPDATA','ProgramData','ProgramFiles','ProgramFiles(x86)','CommonProgramFiles','CommonProgramFiles(x86)','CommonProgramW6432','ProgramW6432','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','OS','PATHEXT','USERNAME','USERDOMAIN','COMPUTERNAME','PUBLIC','ALLUSERSPROFILE')
foreach($entry in @(Get-ChildItem Env:)) {
    if($entry.Name -notin $keep) { [Environment]::SetEnvironmentVariable($entry.Name,$null,'Process') }
}
$env:PATH=$runnerPath
if (-not [IO.Path]::IsPathRooted($ConfigRoot) -or -not (Test-Path -LiteralPath $ConfigRoot -PathType Container)) { throw 'ConfigRoot must identify an existing absolute directory' }
if ($ConfigRoot -notmatch '^[A-Za-z]:[\\/]') { throw 'ConfigRoot requires an absolute local drive directory' }
$drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot([IO.Path]::GetFullPath($ConfigRoot)))
if ($drive.DriveType -ne [IO.DriveType]::Fixed) { throw 'ConfigRoot requires a fixed local drive' }
$env:DSH_PACKAGING_CONFIG_DIR=[IO.Path]::GetFullPath($ConfigRoot)
$env:DSH_TELEMETRY_DISABLED='1'
$env:POWERSHELL_TELEMETRY_OPTOUT='1'
foreach($tool in @('pwsh','node','git','tar','python')) {
    $resolved=Get-Command $tool -CommandType Application -ErrorAction Stop | Select-Object -First 1
    Write-Output ('Tool: '+$tool+' -> '+$resolved.Source)
}
$env:PYTHON=(Get-Command python -CommandType Application | Select-Object -First 1).Source
& pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
if($LASTEXITCODE -ne 0){throw 'PowerShell probe failed'}
& node --version
if($LASTEXITCODE -ne 0){throw 'Node probe failed'}
& python --version
if($LASTEXITCODE -ne 0){throw 'Python probe failed'}
$vswhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$visualStudio=& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if($LASTEXITCODE -ne 0 -or -not $visualStudio){throw 'Visual C++ tools unavailable'}
Write-Output 'Visual C++ tools located.'
if($CheckOnly){Write-Output 'Runner environment check passed.'; exit 0}
if(Get-Process -Name Runner.Listener -ErrorAction SilentlyContinue){throw 'A runner listener is already running; inspect before starting another.'}
Set-Location $RunnerRoot
& .\run.cmd
exit $LASTEXITCODE
