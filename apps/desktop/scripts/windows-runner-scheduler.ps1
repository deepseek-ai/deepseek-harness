# Build an unregistered runner task. Credentials are supplied only to the scheduler at installation.
function New-WindowsRunnerTaskDefinition($Scheduler, [string]$Sid, [string]$RunnerRoot, [string]$PowerShell, [int]$RestartMinutes, [ValidateSet('Interactive','Boot')][string]$StartupMode = 'Interactive') {
    $definition = $Scheduler.NewTask(0)
    $definition.RegistrationInfo.Description = "DSH packaging runner: $RunnerRoot; owner: $Sid"
    $definition.Principal.UserId = $Sid
    $definition.Principal.LogonType = if ($StartupMode -eq 'Boot') { 1 } else { 3 } # Password or InteractiveToken.
    $definition.Principal.RunLevel = 0 # TASK_RUNLEVEL_LUA: the job does not inherit installer elevation.
    $definition.Settings.Priority = 4
    $definition.Settings.Enabled = $false
    $definition.Settings.MultipleInstances = 2 # TASK_INSTANCES_IGNORE_NEW
    $definition.Settings.ExecutionTimeLimit = 'PT0S'
    $definition.Settings.DisallowStartIfOnBatteries = $false
    $definition.Settings.StopIfGoingOnBatteries = $false
    if ($StartupMode -eq 'Boot') {
        $null = $definition.Triggers.Create(8) # TASK_TRIGGER_BOOT
    } else {
        $logon = $definition.Triggers.Create(9) # TASK_TRIGGER_LOGON
        $logon.UserId = $Sid
    }
    $recovery = $definition.Triggers.Create(1) # TASK_TRIGGER_TIME
    $recovery.StartBoundary = (Get-Date).AddMinutes($RestartMinutes).ToString('yyyy-MM-ddTHH:mm:ss')
    $recovery.Repetition.Interval = "PT${RestartMinutes}M"
    $execution = $definition.Actions.Create(0) # TASK_ACTION_EXEC
    $execution.Path = Join-Path $RunnerRoot 'dsh-task/launcher.exe'
    $execution.Arguments = '"' + $PowerShell + '"'
    $execution.WorkingDirectory = $RunnerRoot
    return $definition
}

# Prompt locally and submit once; credential-bearing COM failures must not reach diagnostics.
function Register-WindowsRunnerBootTask($Scheduler, [string]$TaskName, $Definition, [string]$Sid, [string]$RunAs) {
    $credential = Get-Credential -UserName $RunAs -Message 'Windows account password for unattended runner startup (not the signing Token PIN)'
    if (-not $credential -or $credential.UserName -ne $RunAs -or $credential.Password.Length -eq 0) {
        throw 'Credential entry cancelled or account changed; no task was registered.'
    }
    try {
        # COM avoids putting a plaintext password in command arguments or cmdlet parameter logging.
        $null = $Scheduler.GetFolder('\').RegisterTaskDefinition($TaskName, $Definition, 2, $RunAs, $credential.GetNetworkCredential().Password, 1, "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;$Sid)")
    } catch {
        # Registration may have committed before an error reached this caller.
        $code = '0x{0:X8}' -f $_.Exception.GetBaseException().HResult
        throw "Boot task registration failed ($code); registration outcome is unconfirmed. Inspect Task Scheduler, batch-logon policy and account credentials locally before retrying."
    } finally {
        $credential = $null
    }
}

# Validate machine-owned preparation data before credentials or scheduler registration.
function Assert-WindowsRunnerBootConfiguration($Config, [string]$Sid, [string]$RunnerRoot, [string]$TaskName) {
    if ($Config.StartupMode -ne 'Boot' -or $Config.AccountSid -ne $Sid -or $Config.RunnerRoot -ne $RunnerRoot -or $Config.TaskName -ne $TaskName) {
        throw 'Prepared Boot configuration does not match RunAs and RunnerRoot; prepare again as the runner account.'
    }
    if (($Config.RestartMinutes -isnot [int] -and $Config.RestartMinutes -isnot [long]) -or $Config.RestartMinutes -lt 1 -or $Config.RestartMinutes -gt 1440 -or $Config.PowerShell -isnot [string] -or $Config.PowerShell -notmatch '^[A-Za-z]:[\\/]' -or -not (Test-Path -LiteralPath $Config.PowerShell -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $RunnerRoot 'dsh-task/launcher.exe') -PathType Leaf)) {
        throw 'Prepared Boot startup files or restart interval are invalid; prepare again as the runner account.'
    }
}

# Missing tasks are distinct from denied or unavailable scheduler access.
function Get-WindowsRunnerTask($Scheduler, [string]$TaskName) {
    try { return $Scheduler.GetFolder('\').GetTask($TaskName) } catch {
        if ($_.Exception.GetBaseException().HResult -eq -2147024894) { return $null }
        throw
    }
}

# Unreadable process locations must reject maintenance just like missing locations.
function Get-WindowsRunnerProcessPath($Process) {
    try { return $Process.Path } catch {
        # Access-denied and exited-process errors cannot establish an unrelated location.
        return $null
    }
}
