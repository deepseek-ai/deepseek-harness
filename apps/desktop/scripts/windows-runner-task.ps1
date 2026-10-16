# Manage a registered packaging runner in the current user's interactive Windows session.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('install','start','stop','status','uninstall')][string]$Action,
    [Parameter(Mandatory=$true)][string]$RunnerRoot,
    [string]$ConfigRoot,
    [ValidateRange(1,1440)][int]$RestartMinutes = 1,
    [ValidateRange(1,999)][int]$RestartCount = 10
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This command requires PowerShell 7 on Windows.' }
if ($Action -ne 'install' -and @('ConfigRoot','RestartMinutes','RestartCount').Where({ $PSBoundParameters.ContainsKey($_) }).Count) {
    throw 'ConfigRoot, RestartMinutes and RestartCount apply only to install; reinstall to change them.'
}
if ($RunnerRoot -notmatch '^[A-Za-z]:[\\/]') { throw 'RunnerRoot must be an absolute local directory.' }
$RunnerRoot = [IO.Path]::GetFullPath($RunnerRoot).TrimEnd('\','/')
if (-not (Test-Path -LiteralPath (Join-Path $RunnerRoot '.runner') -PathType Leaf)) { throw 'Register the runner before managing its task.' }
for ($ancestor = [IO.DirectoryInfo]::new($RunnerRoot); $null -ne $ancestor; $ancestor = $ancestor.Parent) {
    if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'RunnerRoot cannot contain linked directories.' }
}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($RunnerRoot.ToUpperInvariant())))
$taskName = 'DSH-Packaging-' + $digest.Substring(0,16)
$serviceDir = Join-Path $RunnerRoot 'dsh-task'
$task = Get-ScheduledTask -TaskPath '\' | Where-Object TaskName -eq $taskName
if ($task -and $task.Description -ne "DSH packaging runner: $RunnerRoot; owner: $sid") { throw 'Task ownership differs; inspect it in Task Scheduler.' }

if ($Action -eq 'install') {
    if ($task) { throw 'Task already installed; stop and uninstall before reinstalling.' }
    if (-not $ConfigRoot -or $ConfigRoot -notmatch '^[A-Za-z]:[\\/]') { throw 'Install requires an absolute ConfigRoot.' }
    $ConfigRoot = [IO.Path]::GetFullPath($ConfigRoot)
    $pwsh = Join-Path $PSHOME 'pwsh.exe'
    & $pwsh -NoProfile -File (Join-Path $PSScriptRoot 'start-windows-packaging-runner.ps1') -RunnerRoot $RunnerRoot -ConfigRoot $ConfigRoot -CheckOnly
    if ($LASTEXITCODE -ne 0) { throw 'Runner preflight failed; no task was installed.' }
    if (Test-Path -LiteralPath $serviceDir) {
        if ((Get-Item -LiteralPath $serviceDir).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Task directory cannot be a link.' }
    } else {
        $null = New-Item -ItemType Directory -Path $serviceDir
    }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start-windows-packaging-runner.ps1') -Destination (Join-Path $serviceDir 'start.ps1')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'run-windows-runner-task.ps1') -Destination (Join-Path $serviceDir 'run.ps1')
    @{ RunnerRoot = $RunnerRoot; ConfigRoot = $ConfigRoot; TaskName = $taskName; RestartCount = $RestartCount } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $serviceDir 'config.json') -Encoding utf8
    Set-Content -LiteralPath (Join-Path $serviceDir 'attempts.txt') -Value '0'
    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + (Join-Path $serviceDir 'run.ps1') + '"'
    $execution = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments -WorkingDirectory $RunnerRoot
    $principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
    $trigger = @(
        (New-ScheduledTaskTrigger -AtLogOn -User $sid),
        (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes($RestartMinutes) -RepetitionInterval (New-TimeSpan -Minutes $RestartMinutes))
    )
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $settings.Enabled = $false
    $null = Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $execution -Principal $principal -Trigger $trigger -Settings $settings -Description "DSH packaging runner: $RunnerRoot; owner: $sid"
    Write-Output "Installed disabled task $taskName. Run start while logged in; reboot requires desktop login. Logs: $serviceDir"
    exit 0
}
if (-not $task) { throw 'Task is not installed for this runner directory.' }
switch ($Action) {
    'status' {
        $info = Get-ScheduledTaskInfo -InputObject $task
        $launches = [int](Get-Content -LiteralPath (Join-Path $serviceDir 'attempts.txt') -Raw)
        $config = Get-Content -LiteralPath (Join-Path $serviceDir 'config.json') -Raw | ConvertFrom-Json
        [pscustomobject]@{ TaskName = $taskName; State = $task.State; LastRunTime = $info.LastRunTime; LastTaskResult = $info.LastTaskResult; Launches = $launches; RemainingLaunches = [Math]::Max(0, 1 + $config.RestartCount - $launches); Logs = $serviceDir }
    }
    'start' {
        if ($task.State -eq 'Running') { Write-Output "$taskName is already running."; break }
        Set-Content -LiteralPath (Join-Path $serviceDir 'attempts.txt') -Value '0'
        $null = Enable-ScheduledTask -InputObject $task
        Start-ScheduledTask -InputObject $task
        Write-Output "Start requested for $taskName. Verify Connected to GitHub and Listening for Jobs in $serviceDir."
    }
    'stop' {
        # Operators pause workflow dispatch first; this local check cannot reserve an idle GitHub runner.
        $workers = Get-CimInstance Win32_Process -Filter "Name = 'Runner.Worker.exe'"
        foreach ($worker in $workers) {
            if (-not $worker.ExecutablePath -or $worker.ExecutablePath.StartsWith($RunnerRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
                throw 'A runner job is active or its location is unreadable. Wait for completion before stopping.'
            }
        }
        $null = Disable-ScheduledTask -InputObject $task
        $task = Get-ScheduledTask -TaskName $taskName -TaskPath '\'
        if ($task.State -eq 'Running') {
            $recordFile = Join-Path $serviceDir 'process.json'
            if (-not (Test-Path -LiteralPath $recordFile)) { throw 'Running task process identity is unavailable. Automatic starts are disabled; inspect the task before stopping it.' }
            $record = Get-Content -LiteralPath $recordFile -Raw | ConvertFrom-Json
            $owner = Get-Process -Id $record.Pid -ErrorAction SilentlyContinue
            if (-not $owner -or $owner.StartTime.ToUniversalTime().Ticks -ne $record.Started) {
                throw 'Running task process identity is unavailable. Automatic starts are disabled; inspect the task before stopping it.'
            }
            # Parent IDs can be reused; this snapshot supplies wait handles, not termination authority.
            $processes = @(Get-CimInstance Win32_Process)
            $ownedIds = [Collections.Generic.HashSet[int]]::new()
            $null = $ownedIds.Add($owner.Id)
            do {
                $added = $false
                foreach ($process in $processes) {
                    if ($ownedIds.Contains([int]$process.ParentProcessId) -and $ownedIds.Add([int]$process.ProcessId)) { $added = $true }
                }
            } while ($added)
            $owned = @(foreach ($ownedId in $ownedIds) { Get-Process -Id $ownedId -ErrorAction SilentlyContinue })
            & "$env:SystemRoot/System32/taskkill.exe" /PID $owner.Id /T /F
            if ($LASTEXITCODE -ne 0 -and -not $owner.HasExited) { throw 'Runner task process tree could not be stopped; inspect it before restarting.' }
            foreach ($process in $owned) {
                if (-not $process.WaitForExit(30000)) { throw 'Runner task child remains alive; inspect it before restarting.' }
            }
        }
        Stop-ScheduledTask -InputObject $task
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        do {
            $state = (Get-ScheduledTask -TaskName $taskName -TaskPath '\').State
            if ($state -ne 'Running') { break }
            Start-Sleep -Milliseconds 200
        } while ([DateTime]::UtcNow -lt $deadline)
        if ($state -eq 'Running') { throw 'Task remains running; inspect its processes before further maintenance.' }
        Write-Output "Stopped and disabled $taskName. Run start to enable automatic starts again."
    }
    'uninstall' {
        if ($task.State -ne 'Disabled') { throw 'Stop the task before uninstalling.' }
        Unregister-ScheduledTask -InputObject $task -Confirm:$false
        Write-Output "Uninstalled $taskName. Registration, configuration and logs remain in $RunnerRoot."
    }
}
