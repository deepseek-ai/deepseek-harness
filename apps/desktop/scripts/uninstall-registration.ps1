<# Remove only this installation's user registrations. Fail before payload deletion on an unknown outcome. #>
param([Parameter(Mandatory)][string]$Directory,
    [string]$ExecutableName = 'DeepSeek Harness.exe',
    [string]$EnvironmentKey = 'Environment',
    [string]$OwnerKey = 'Software\DeepSeekHarness\Command',
    [string]$ProtocolKey = 'Software\Classes\dsh')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'command-path.ps1')
try {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $options = @{ EnvironmentKey=$EnvironmentKey; OwnerKey=$OwnerKey; MachinePath=''; MutexName=('Global\DeepSeekHarness.Command.' + $sid) }
    $command = Join-Path $Directory 'resources\runtime\cli\bin'
    $state = Invoke-DshCommandPath -Request @{operation='inspect'; directory=$command} @options
    [void](Invoke-DshCommandPath -Request @{operation='remove'; directory=$command; expected=$state.fingerprint} @options)
    Send-DshCommandEnvironmentChange
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($ProtocolKey + '\shell\open\command')
    try { $registered = if ($key) { $key.GetValue('') } else { $null } }
    finally { if ($key) { $key.Dispose() } }
    $expected = '"' + (Join-Path $Directory $ExecutableName) + '" "%1"'
    if ($registered -eq $expected) {
        [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($ProtocolKey, $false)
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
