<# Remove only owned registrations; independently failed operations leave a diagnostic report. #>
param([Parameter(Mandatory)][string]$Directory,
    [string]$ExecutableName = 'DeepSeek Harness.exe',
    [Parameter(Mandatory)][string]$EnvironmentKey,
    [Parameter(Mandatory)][string]$OwnerKey,
    [Parameter(Mandatory)][string]$ProtocolKey,
    [Parameter(Mandatory)][string]$ReportPath,
    [string]$MutexName,
    [switch]$UnownedOnly,
    [string]$UnownedMarker,
    [string]$DesktopLink,
    [string]$StartMenuLink,
    [string]$UninstallKey,
    [string]$LegacyUninstallKey,
    [string]$UninstallerName)
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
foreach ($uninstallEntry in @($UninstallKey, $LegacyUninstallKey)) {
    if (-not $uninstallEntry) { continue }
    try {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($uninstallEntry)
        try { $registered = if ($key) { $key.GetValue('UninstallString') } else { $null } }
        finally { if ($key) { $key.Dispose() } }
        if ($null -eq $registered) { continue }
        if ($registered -isnot [string]) { throw 'UninstallString is not a string' }
        # Only the command emitted by the per-user installer is eligible for removal.
        if ($registered -match '^\s*"([^"]+)"\s+/currentuser\s*$') {
            $target = [IO.Path]::GetFullPath($Matches[1])
            $expected = [IO.Path]::GetFullPath((Join-Path $Directory $UninstallerName))
            if ($target -eq $expected) {
                [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($uninstallEntry, $false)
            }
        }
    } catch {
        $failures.Add("[unverified] Inspect or remove uninstall entry`r`nHKCU\$uninstallEntry [UninstallString]`r`nCode: $($_.Exception.HResult)`r`nReason: $($_.Exception.Message)")
    }
}
foreach ($link in @($DesktopLink, $StartMenuLink)) {
    if (-not $link) { continue }
    try {
        if ([IO.Path]::GetExtension($link) -ne '.lnk' -or -not (Test-Path -LiteralPath $link -PathType Leaf)) { continue }
        $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($link)
        if ($shortcut.TargetPath -eq (Join-Path $Directory $ExecutableName)) {
            [IO.File]::Delete($link)
        }
    } catch {
        $failures.Add("[unverified] Remove shortcut: $link`r`nReason: $($_.Exception.Message)")
    }
}
if ($failures.Count) {
    [IO.File]::WriteAllText($ReportPath, ($failures -join "`r`n`r`n"), [Text.UTF8Encoding]::new($true))
    exit 1
}
