# Prepare startup files and manage runner tasks; Boot registration requires an administrator.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('install','register-boot','start','stop','status','uninstall')][string]$Action,
    [Parameter(Mandatory=$true)][string]$RunnerRoot,
    [string]$ConfigRoot,
    [string]$NetworkRoot,
    [ValidateSet('Interactive','Boot')][string]$StartupMode = 'Interactive',
    [string]$RunAs,
    [ValidateRange(1,1440)][int]$RestartMinutes = 1,
    [ValidateRange(1,999)][int]$RestartCount = 10
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This command requires PowerShell 7 on Windows.' }
if ($Action -ne 'install' -and @('ConfigRoot','NetworkRoot','StartupMode','RestartMinutes','RestartCount').Where({ $PSBoundParameters.ContainsKey($_) }).Count) {
    throw 'Configuration and retry options apply only to install; reinstall to change them.'
}
if ($Action -ne 'register-boot' -and $PSBoundParameters.ContainsKey('RunAs')) { throw 'RunAs applies only to register-boot.' }
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
if ($Action -eq 'register-boot') {
    if (-not $RunAs) { throw 'Boot registration requires -RunAs with the prepared runner account.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Boot registration requires an elevated PowerShell; the runner account remains limited.'
    }
    $sid = ([Security.Principal.NTAccount]::new($RunAs)).Translate([Security.Principal.SecurityIdentifier]).Value
    if ($sid -in @('S-1-5-18','S-1-5-19','S-1-5-20') -or $sid.EndsWith('-500')) { throw 'Use a dedicated runner account, not a built-in service or Administrator account.' }
}
. (Join-Path $PSScriptRoot 'windows-runner-scheduler.ps1')
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$task = Get-WindowsRunnerTask $scheduler $taskName
if ($task -and $task.Definition.RegistrationInfo.Description -ne "DSH packaging runner: $RunnerRoot; owner: $sid") { throw 'Task ownership differs; inspect it in Task Scheduler.' }

if ($Action -in @('install','register-boot')) {
    if ($task) { throw 'Task already installed; stop and uninstall before reinstalling.' }
    # Pause dispatch before migration; never overwrite a live startup snapshot.
    foreach ($process in @(Get-Process | Where-Object { $_.ProcessName -in @('Runner.Listener','Runner.Worker') })) {
        $path = Get-WindowsRunnerProcessPath $process
        if (-not $path -or $path.StartsWith($RunnerRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'A runner process is active or its location is unreadable. Pause dispatch and stop its supervisor before installing.'
        }
    }
    if (Test-Path -LiteralPath (Join-Path $RunnerRoot '.service')) { throw 'A native runner service is configured; inspect and remove it before task migration.' }
    if ((Test-Path -LiteralPath $serviceDir) -and ((Get-Item -LiteralPath $serviceDir).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Task directory cannot be a link.' }
}
if ($Action -eq 'register-boot') {
    # This elevated path only registers a limited task; it never executes runner-owned files.
    $configFile = Join-Path $serviceDir 'config.json'
    if ((Get-Item -LiteralPath $configFile).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Task configuration cannot be a link.' }
    $config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
    Assert-WindowsRunnerBootConfiguration $config $sid $RunnerRoot $taskName
    $definition = New-WindowsRunnerTaskDefinition $scheduler $sid $RunnerRoot $config.PowerShell $config.RestartMinutes 'Boot'
    Register-WindowsRunnerBootTask $scheduler $taskName $definition $sid $RunAs
    Write-Output "Registered disabled Boot task $taskName. Run start as the runner account. Logs: $serviceDir"
    exit 0
}

if ($Action -eq 'install') {
    if (-not $ConfigRoot -or $ConfigRoot -notmatch '^[A-Za-z]:[\\/]') { throw 'Install requires an absolute ConfigRoot.' }
    $ConfigRoot = [IO.Path]::GetFullPath($ConfigRoot)
    $pwsh = Join-Path $PSHOME 'pwsh.exe'
    $startup = Join-Path $PSScriptRoot 'start-windows-packaging-runner.ps1'
    if ($PSBoundParameters.ContainsKey('NetworkRoot')) {
        if ($NetworkRoot -notmatch '^[A-Za-z]:[\\/]') { throw 'NetworkRoot must identify an existing absolute local directory.' }
        if (-not (Test-Path -LiteralPath (Join-Path $ConfigRoot 'runner-network.json') -PathType Leaf)) { throw 'Owned network supervision requires runner-network.json.' }
        $NetworkRoot = [IO.Path]::GetFullPath($NetworkRoot)
        & $pwsh -NoProfile -File (Join-Path $PSScriptRoot 'run-windows-runner-network-process.ps1') -RunnerRoot $RunnerRoot -ConfigRoot $ConfigRoot -NetworkRoot $NetworkRoot -ReadinessScript $startup -StartScript $startup -CheckOnly
    } else {
        & $pwsh -NoProfile -File $startup -RunnerRoot $RunnerRoot -ConfigRoot $ConfigRoot -CheckOnly
    }
    if ($LASTEXITCODE -ne 0) { throw 'Runner preflight failed; no task was installed.' }
    if (Test-Path -LiteralPath $serviceDir) {
        if ((Get-Item -LiteralPath $serviceDir).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Task directory cannot be a link.' }
    } else {
        $null = New-Item -ItemType Directory -Path $serviceDir
    }
    $compiler = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    if (-not (Test-Path -LiteralPath $compiler)) { throw 'Install requires the Windows .NET Framework 4.5+ compiler (Framework64/v4.0.30319/csc.exe).' }
    $launcher = Join-Path $serviceDir 'launcher.exe'
    & $compiler /nologo /target:winexe "/out:$launcher" (Join-Path $PSScriptRoot 'windows-runner-launcher.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Runner launcher compilation failed; verify .NET Framework 4.5+ is installed. No task was installed.' }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start-windows-packaging-runner.ps1') -Destination (Join-Path $serviceDir 'start.ps1')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'run-windows-runner-task.ps1') -Destination (Join-Path $serviceDir 'run.ps1')
    foreach ($helper in @('windows-runner-network.ps1','run-windows-runner-network-process.ps1')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $helper) -Destination (Join-Path $serviceDir $helper)
    }
    @{ RunnerRoot = $RunnerRoot; ConfigRoot = $ConfigRoot; NetworkRoot = $NetworkRoot; TaskName = $taskName; RestartCount = $RestartCount; StartupMode = $StartupMode; AccountSid = $sid; PowerShell = $pwsh; RestartMinutes = $RestartMinutes } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $serviceDir 'config.json') -Encoding utf8
    Set-Content -LiteralPath (Join-Path $serviceDir 'attempts.txt') -Value '0'
    if ($StartupMode -eq 'Boot') {
        Write-Output "Prepared Boot startup for account $sid. An administrator must run register-boot with RunnerRoot and RunAs; no task was registered."
        exit 0
    }
    $definition = New-WindowsRunnerTaskDefinition $scheduler $sid $RunnerRoot $pwsh $RestartMinutes 'Interactive'
    $null = $scheduler.GetFolder('\').RegisterTaskDefinition($taskName, $definition, 2, $sid, $null, 3, $null)
    Write-Output "Installed disabled task $taskName. Run start while logged in; reboot requires desktop login. Logs: $serviceDir"
    exit 0
}
if (-not $task) { throw 'Task is not installed for this runner directory.' }
switch ($Action) {
    'status' {
        $bootTrigger = $false
        for ($index = 1; $index -le $task.Definition.Triggers.Count; $index++) {
            if ($task.Definition.Triggers.Item($index).Type -eq 8) { $bootTrigger = $true }
        }
        $launches = [int](Get-Content -LiteralPath (Join-Path $serviceDir 'attempts.txt') -Raw)
        $config = Get-Content -LiteralPath (Join-Path $serviceDir 'config.json') -Raw | ConvertFrom-Json
        [pscustomobject]@{ TaskName = $taskName; State = @('Unknown','Disabled','Queued','Ready','Running')[[int]$task.State]; Account = $task.Definition.Principal.UserId; LogonType = @('None','Password','S4U','Interactive','Group','ServiceAccount','InteractiveOrPassword')[[int]$task.Definition.Principal.LogonType]; BootTrigger = $bootTrigger; LastRunTime = $task.LastRunTime; LastTaskResult = $task.LastTaskResult; Launches = $launches; RemainingLaunches = [Math]::Max(0, 1 + $config.RestartCount - $launches); Logs = $serviceDir }
    }
    'start' {
        if ($task.State -eq 4) { Write-Output "$taskName is already running."; break }
        Set-Content -LiteralPath (Join-Path $serviceDir 'attempts.txt') -Value '0'
        $task.Enabled = $true
        $null = $task.Run($null)
        Write-Output "Start requested for $taskName. Verify Connected to GitHub and Listening for Jobs in $serviceDir."
    }
    'stop' {
        # Operators pause workflow dispatch first; this local check cannot reserve an idle GitHub runner.
        $workers = Get-Process | Where-Object ProcessName -eq 'Runner.Worker'
        foreach ($worker in $workers) {
            $path = Get-WindowsRunnerProcessPath $worker
            if (-not $path -or $path.StartsWith($RunnerRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
                throw 'A runner job is active or its location is unreadable. Wait for completion before stopping.'
            }
        }
        $task.Enabled = $false
        $task = Get-WindowsRunnerTask $scheduler $taskName
        if ($task.State -eq 4) {
            $recordFile = Join-Path $serviceDir 'process.json'
            if (-not (Test-Path -LiteralPath $recordFile)) { throw 'Running task process identity is unavailable. Automatic starts are disabled; inspect the task before stopping it.' }
            $record = Get-Content -LiteralPath $recordFile -Raw | ConvertFrom-Json
            $owner = Get-Process -Id $record.Pid -ErrorAction SilentlyContinue
            if (-not $owner -or $owner.StartTime.ToUniversalTime().Ticks -ne $record.Started) {
                throw 'Running task process identity is unavailable. Automatic starts are disabled; inspect the task before stopping it.'
            }
            # Parent IDs can be reused; this snapshot supplies wait handles, not termination authority.
            if (-not ('DshRunnerProcesses' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'windows-runner-processes.cs') }
            $processes = [DshRunnerProcesses]::ReadParents()
            $ownedIds = [Collections.Generic.HashSet[int]]::new()
            $null = $ownedIds.Add($owner.Id)
            do {
                $added = $false
                foreach ($process in $processes.GetEnumerator()) {
                    if ($ownedIds.Contains([int]$process.Value) -and $ownedIds.Add([int]$process.Key)) { $added = $true }
                }
            } while ($added)
            $owned = @(foreach ($ownedId in $ownedIds) { Get-Process -Id $ownedId -ErrorAction SilentlyContinue })
            & "$env:SystemRoot/System32/taskkill.exe" /PID $owner.Id /T /F
            if ($LASTEXITCODE -ne 0 -and -not $owner.HasExited) { throw 'Runner task process tree could not be stopped; inspect it before restarting.' }
            foreach ($process in $owned) {
                if (-not $process.WaitForExit(30000)) { throw 'Runner task child remains alive; inspect it before restarting.' }
            }
        }
        $task.Stop(0)
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        do {
            $state = (Get-WindowsRunnerTask $scheduler $taskName).State
            if ($state -ne 4) { break }
            Start-Sleep -Milliseconds 200
        } while ([DateTime]::UtcNow -lt $deadline)
        if ($state -eq 4) { throw 'Task remains running; inspect its processes before further maintenance.' }
        Write-Output "Stopped and disabled $taskName. Run start to enable automatic starts again."
    }
    'uninstall' {
        if ($task.State -ne 1) { throw 'Stop the task before uninstalling.' }
        $scheduler.GetFolder('\').DeleteTask($taskName, 0)
        Write-Output "Uninstalled $taskName. Registration, configuration and logs remain in $RunnerRoot."
    }
}
