param([string]$Worker, [string]$Root, [Parameter(Mandatory)][string]$Electron)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. $Worker
$identity = [Guid]::NewGuid().ToString('N')
$keyRoot = 'Software\DeepSeekHarness\CommandTests\' + $identity
$environmentKey = $keyRoot + '\Environment'
$ownerKey = $keyRoot + '\Owner'
$options = @{ EnvironmentKey=$environmentKey; OwnerKey=$ownerKey; MachinePath=''; MutexName=('Local\DshCommandTest-' + $identity) }
function Require([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function UserPath {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($environmentKey)
    try { return $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    finally { $key.Dispose() }
}
function State([string]$Directory) { return Invoke-DshCommandPath @options -Request @{ operation='inspect'; directory=$Directory } }
function Apply([string]$Operation, [string]$Directory) {
    $state = State $Directory
    return Invoke-DshCommandPath @options -Request @{ operation=$Operation; directory=$Directory; expected=$state.fingerprint }
}
try {
    $desktop = Join-Path $Root ('Desktop space ' + [char]0x4e2d + [char]0x6587)
    $other = Join-Path $Root 'Other Desktop'
    $npm = Join-Path $Root 'npm'
    $system = Join-Path $Root 'system'
    New-Item -ItemType Directory -Force $desktop, $other, $npm, $system | Out-Null
    [IO.File]::WriteAllText((Join-Path $desktop 'dsh.cmd'), 'fixture')
    [IO.File]::WriteAllText((Join-Path $other 'dsh.cmd'), 'fixture')
    [IO.File]::WriteAllText((Join-Path $npm 'dsh.cmd'), 'fixture')
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($environmentKey)
    try { $key.SetValue('Path', $npm, [Microsoft.Win32.RegistryValueKind]::ExpandString) }
    finally { $key.Dispose() }
    $before = State $desktop
    # .NET may expand a CI runner's short temporary-directory name.
    $desktop = $before.directory
    $other = (State $other).directory
    Require ($before.activeCommand -eq (Join-Path $npm 'dsh.cmd')) 'existing npm command was not detected'
    [void](Apply 'install' $desktop)
    Require ((UserPath) -eq ($desktop + ';' + $npm)) 'installation changed unrelated PATH entries'
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($environmentKey, $true)
    try { $key.SetValue('Path', (UserPath) + ';extra-user-entry', [Microsoft.Win32.RegistryValueKind]::ExpandString) }
    finally { $key.Dispose() }
    [void](Apply 'remove' $desktop)
    Require ((UserPath) -eq ($npm + ';extra-user-entry')) 'removal lost concurrent user entries'
    $stale = State $desktop
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($environmentKey, $true)
    try { $key.SetValue('Path', (UserPath) + ';newer-entry', [Microsoft.Win32.RegistryValueKind]::ExpandString) }
    finally { $key.Dispose() }
    $rejected = $false
    try { [void](Invoke-DshCommandPath @options -Request @{ operation='install'; directory=$desktop; expected=$stale.fingerprint }) }
    catch { $rejected = $_.Exception.Data['code'] -eq 'ESTALE' }
    Require $rejected 'stale confirmation was accepted'
    [void](Apply 'install' $desktop)
    [void](Apply 'install' $other)
    $newer = UserPath
    [void](Apply 'remove' $desktop)
    Require ((UserPath) -eq $newer) 'old installation removed the newer command'
    Require ((State $other).managed) 'old installation deleted newer ownership'
    [IO.File]::WriteAllText((Join-Path $system 'dsh.exe'), 'fixture')
    $options.MachinePath = $system
    Require ((State $other).activeCommand -eq (Join-Path $system 'dsh.exe')) 'machine PATH precedence was hidden'
    [void](Apply 'remove' $other)
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($environmentKey, $true)
    $manualPath = $npm + ';' + $desktop + ';' + $desktop
    try { $key.SetValue('Path', $manualPath, [Microsoft.Win32.RegistryValueKind]::ExpandString) }
    finally { $key.Dispose() }
    [void](Apply 'remove' $desktop)
    Require ((UserPath) -eq $manualPath) 'unowned manual PATH entries were removed'
    [void](Apply 'install' $desktop)
    [void](Apply 'install' $desktop)
    Require ((UserPath) -eq ($desktop + ';' + $manualPath)) 'repair adopted or duplicated manual PATH entries'
    [void](Apply 'remove' $desktop)
    Require ((UserPath) -eq $manualPath) 'removal did not preserve preexisting duplicates'
    [void](Apply 'install' $desktop)
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($environmentKey, $true)
    try { $key.SetValue('Path', $manualPath, [Microsoft.Win32.RegistryValueKind]::ExpandString) }
    finally { $key.Dispose() }
    [void](Apply 'remove' $desktop)
    Require ((UserPath) -eq $manualPath) 'removal deleted a retained entry after the owned entry was removed manually'
    [IO.File]::Delete((Join-Path $npm 'dsh.cmd'))
    [IO.File]::WriteAllText((Join-Path $npm 'dsh.ps1'), 'fixture')
    $options.MachinePath = ''
    Require ((State $desktop).activeCommand -eq (Join-Path $npm 'dsh.ps1')) 'PowerShell launcher was not detected'
    $invalidPath = 'C:\invalid|entry;C:\<missing>;' + $npm
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($environmentKey, $true)
    try { $key.SetValue('Path', $invalidPath, [Microsoft.Win32.RegistryValueKind]::ExpandString) }
    finally { $key.Dispose() }
    Require ((State $desktop).activeCommand -eq (Join-Path $npm 'dsh.ps1')) 'invalid PATH entries prevented command discovery'
    [void](Apply 'install' $desktop)
    function Add-Type { throw 'Environment notification is unavailable' }
    try { Send-DshCommandEnvironmentChange } finally { Remove-Item Function:\Add-Type }
    Require ((UserPath) -eq ($desktop + ';' + $invalidPath)) 'a notification failure changed the committed PATH'
    [void](Apply 'remove' $desktop)
    Require ((UserPath) -eq $invalidPath) 'removal changed invalid user PATH entries'
    # Uninstalling A must preserve independently registered B integrations.
    $app = Join-Path $Root 'Uninstall A'
    $bin = Join-Path $app 'resources\runtime\cli\bin'
    New-Item -ItemType Directory -Force $bin | Out-Null
    [IO.File]::WriteAllText((Join-Path $bin 'dsh.cmd'), 'fixture')
    [void](Apply 'install' $other)
    $protocolKey = $keyRoot + '\Protocol'
    $foreignCommand = '"' + (Join-Path $other 'DeepSeek Harness.exe') + '" "%1"'
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($protocolKey + '\shell\open\command')
    try { $key.SetValue('', $foreignCommand) } finally { $key.Dispose() }
    $helper = Join-Path (Split-Path $Worker) 'uninstall-registration.ps1'
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper -Directory $app -EnvironmentKey $environmentKey -OwnerKey $ownerKey -ProtocolKey $protocolKey -ReportPath (Join-Path $Root 'uninstall-report.txt') -MutexName $options.MutexName
    Require ($LASTEXITCODE -eq 0) 'foreign integration cleanup failed'
    Require ((State $other).managed) 'uninstall removed foreign command ownership'
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($protocolKey + '\shell\open\command')
    try { Require ($key.GetValue('') -eq $foreignCommand) 'uninstall removed foreign protocol' } finally { $key.Dispose() }
    [void](Apply 'install' $bin)
    $scheme = 'dsh-command-test-' + $identity
    $protocolKey = 'Software\Classes\' + $scheme
    $launcher = Join-Path $PSScriptRoot 'register-test-protocol.cjs'
    $exe = Join-Path $app 'DeepSeek Harness.exe'
    $registration = Start-Process $Electron -ArgumentList @(('"' + $launcher + '"'), ('"--user-data-dir=' + $Root + '\profile"'), $scheme, ('"' + $exe + '"')) -PassThru -WindowStyle Hidden
    try {
        if (-not $registration.WaitForExit(20000)) { $registration.Kill(); $registration.WaitForExit(); throw 'Electron protocol registration timed out' }
        Require ($registration.ExitCode -eq 0) 'Electron could not register the test protocol'
    } finally { $registration.Dispose() }
    Require (Test-Path -LiteralPath ('HKCU:\' + $protocolKey + '\shell\open\command')) 'Electron did not write the protocol command'
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper -Directory $app -EnvironmentKey $environmentKey -OwnerKey $ownerKey -ProtocolKey $protocolKey -ReportPath (Join-Path $Root 'uninstall-report.txt') -MutexName $options.MutexName
    Require ($LASTEXITCODE -eq 0) 'owned integration cleanup failed'
    Require (-not (State $bin).managed) 'uninstall retained command ownership'
    Require (-not (Test-Path -LiteralPath ('HKCU:\' + $protocolKey))) 'uninstall retained protocol'
    # Missing ownership does not authorize removal while any of the installation remains.
    $orphanPath = $bin + ';"' + $bin.ToUpperInvariant() + '\";C:\Windows;' + $other
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($environmentKey, $true)
    try { $key.SetValue('Path', $orphanPath, [Microsoft.Win32.RegistryValueKind]::ExpandString) } finally { $key.Dispose() }
    $report = Join-Path $Root 'unowned-report.txt'
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper -Directory $app -EnvironmentKey $environmentKey -OwnerKey $ownerKey -ProtocolKey $protocolKey -ReportPath $report -MutexName $options.MutexName -UnownedOnly
    Require ($LASTEXITCODE -eq 1) 'unowned cleanup accepted an existing installation'
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($environmentKey)
    try { Require ($key.GetValue('Path') -eq $orphanPath) 'unowned cleanup changed PATH before directory removal' } finally { $key.Dispose() }
    Require ([IO.File]::ReadAllText($report).Contains('installation directory remains')) 'unowned refusal lacks a report'
    [IO.Directory]::Delete($app, $true)
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper -Directory $app -EnvironmentKey $environmentKey -OwnerKey $ownerKey -ProtocolKey $protocolKey -ReportPath $report -MutexName $options.MutexName -UnownedOnly
    Require ($LASTEXITCODE -eq 0) 'unowned cleanup failed after directory removal'
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($environmentKey)
    try {
        Require ($key.GetValue('Path') -eq ('C:\Windows;' + $other)) 'unowned cleanup failed to preserve other PATH entries'
        Require ($key.GetValueKind('Path') -eq [Microsoft.Win32.RegistryValueKind]::ExpandString) 'unowned cleanup changed PATH type'
    } finally { $key.Dispose() }
    [void](Apply 'install' $other)
    $foreignState = State $other
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper -Directory $app -EnvironmentKey $environmentKey -OwnerKey $ownerKey -ProtocolKey $protocolKey -ReportPath $report -MutexName $options.MutexName -UnownedOnly
    Require ($LASTEXITCODE -eq 0 -and (State $other).fingerprint -eq $foreignState.fingerprint) 'unowned cleanup changed a new owner'
    'WINDOWS_COMMAND_PATH_OK'
} finally {
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree(('Software\Classes\dsh-command-test-' + $identity), $false)
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($keyRoot, $false)
}
