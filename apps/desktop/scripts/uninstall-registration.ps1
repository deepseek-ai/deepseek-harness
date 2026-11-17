<# Remove only owned registrations; independently failed operations leave a diagnostic report. #>
param([Parameter(Mandatory)][string]$Directory,
    [string]$ExecutableName = 'DeepSeek Harness.exe',
    [string]$EnvironmentKey = 'Environment',
    [string]$OwnerKey = 'Software\DeepSeekHarness\Command',
    [string]$ProtocolKey = 'Software\Classes\dsh',
    [Parameter(Mandatory)][string]$ReportPath,
    [string]$MutexName,
    [switch]$UnownedOnly,
    [string]$UnownedMarker)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'command-path.ps1')
$failures = [Collections.Generic.List[string]]::new()
try {
    if (-not $MutexName -or $MutexName -eq 'default') {
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $MutexName = 'Global\DeepSeekHarness.Command.' + $sid
    }
    $options = @{ EnvironmentKey=$EnvironmentKey; OwnerKey=$OwnerKey; MachinePath=''; MutexName=$MutexName }
    $command = Join-Path $Directory 'resources\runtime\cli\bin'
    $state = Invoke-DshCommandPath -Request @{operation='inspect'; directory=$command} @options
    if ($UnownedOnly) {
        if (-not $state.ownedDirectory) {
            [void](Invoke-DshCommandPath -Request @{operation='remove'; directory=$command; expected=$state.fingerprint} @options -RemovedInstallation $Directory)
            Send-DshCommandEnvironmentChange
        }
    } elseif ($state.managed) {
        [void](Invoke-DshCommandPath -Request @{operation='remove'; directory=$command; expected=$state.fingerprint} @options)
        Send-DshCommandEnvironmentChange
    } elseif (-not $state.ownedDirectory -and $UnownedMarker) {
        [IO.File]::WriteAllText($UnownedMarker, '')
    }
} catch {
    $failures.Add("[unverified] Remove owned command registration`r`nHKCU\$EnvironmentKey [Path]`r`nHKCU\$OwnerKey`r`nCode: $($_.Exception.HResult)`r`nReason: $($_.Exception.Message)")
}
if (-not $UnownedOnly) { try {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($ProtocolKey + '\shell\open\command')
    try { $registered = if ($key) { $key.GetValue('') } else { $null } }
    finally { if ($key) { $key.Dispose() } }
    $expected = '"' + (Join-Path $Directory $ExecutableName) + '" "%1"'
    if ($registered -eq $expected) {
        [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($ProtocolKey, $false)
    }
} catch {
    $failures.Add("[unverified] Remove protocol registration`r`nHKCU\$ProtocolKey`r`nCode: $($_.Exception.HResult)`r`nReason: $($_.Exception.Message)")
} }
if ($failures.Count) {
    [IO.File]::WriteAllText($ReportPath, ($failures -join "`r`n`r`n"), [Text.UTF8Encoding]::new($true))
    exit 1
}
