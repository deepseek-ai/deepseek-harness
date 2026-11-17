# Opt-in Windows Task Scheduler acceptance: isolated fake runner, no GitHub registration or signing access.
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Requires PowerShell 7 on Windows.' }
$root = Join-Path ([IO.Path]::GetTempPath()) ('dsh-runner-task-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $root
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../scripts'))
$runner = Join-Path $root 'runner with spaces'
$null = New-Item -ItemType Directory -Path $runner
Set-Content -LiteralPath (Join-Path $runner '.runner') -Value '{}'
foreach ($file in @('windows-runner-task.ps1','run-windows-runner-task.ps1','windows-runner-launcher.cs','windows-runner-network.ps1','run-windows-runner-network-process.ps1')) { Copy-Item -LiteralPath (Join-Path $source $file) -Destination $root }
$manager = Join-Path $root 'windows-runner-task.ps1'
@'
param([string]$RunnerRoot, [string]$ConfigRoot, [switch]$CheckOnly)
if ($CheckOnly) { exit 0 }
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ConsoleProbe { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }'
Add-Content -LiteralPath (Join-Path $RunnerRoot 'consoles.txt') -Value ([ConsoleProbe]::GetConsoleWindow().ToInt64())
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class SchedulingProbe { [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle, int kind, out int value, int size, out int length); public static int Read(IntPtr handle, int kind) { int value, length; int status = NtQueryInformationProcess(handle, kind, out value, 4, out length); if (status != 0) throw new InvalidOperationException("Priority query failed: " + status); return value; } }'
$process = [Diagnostics.Process]::GetCurrentProcess()
try {
    @{ Cpu = $process.PriorityClass.ToString(); Io = [SchedulingProbe]::Read($process.Handle, 33); Memory = [SchedulingProbe]::Read($process.Handle, 39) } | ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $RunnerRoot 'priorities.jsonl')
} finally { $process.Dispose() }
Add-Content -LiteralPath (Join-Path $RunnerRoot 'starts.txt') -Value $PID
if (-not (Test-Path -LiteralPath (Join-Path $RunnerRoot 'failed-once'))) {
    Set-Content -LiteralPath (Join-Path $RunnerRoot 'failed-once') -Value 'yes'
    exit 0
}
Write-Output 'FAKE RUNNER READY'
while ($true) { Start-Sleep -Seconds 1 }
'@ | Set-Content -LiteralPath (Join-Path $root 'start-windows-packaging-runner.ps1')
function Invoke-Manager([string]$Operation, [switch]$ExpectFailure) {
    $installOptions = if ($Operation -eq 'install') { @('-ConfigRoot', $root, '-RestartCount', '2') } else { @() }
    & (Join-Path $PSHOME 'pwsh.exe') -NoProfile -File $manager -Action $Operation -RunnerRoot $runner @installOptions
    if (($LASTEXITCODE -eq 0) -eq [bool]$ExpectFailure) { throw "Unexpected exit $LASTEXITCODE for $Operation" }
}
function Wait-Condition([scriptblock]$Condition, [string]$Description, [int]$Seconds = 60) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        if (& $Condition) { return }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out: $Description"
}
$installed = $false
$primaryFailure = $null
$digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($runner.ToUpperInvariant())))
$taskName = 'DSH-Packaging-' + $digest.Substring(0,16)
try {
    Invoke-Manager install
    $installed = $true
    $config = Get-Content -LiteralPath (Join-Path $runner 'dsh-task/config.json') -Raw | ConvertFrom-Json
    $task = Get-ScheduledTask -TaskName $config.TaskName -TaskPath '\'
    $launcher = Join-Path $runner 'dsh-task/launcher.exe'
    if ($task.Actions.Execute -ne $launcher) { throw 'Task must start the windowless launcher.' }
    $image = [IO.File]::ReadAllBytes($launcher)
    $peOffset = [BitConverter]::ToInt32($image, 0x3c)
    if ([BitConverter]::ToUInt16($image, $peOffset + 24 + 68) -ne 2) { throw 'Launcher must use the Windows GUI subsystem.' }
    if ($task.State -ne 'Disabled' -or $task.Settings.ExecutionTimeLimit -ne 'PT0S' -or $task.Settings.MultipleInstances -ne 'IgnoreNew') { throw 'Unexpected task scheduling settings.' }
    if ($task.Settings.Priority -ne 4) { throw 'Runner task must use normal CPU, I/O and memory priority.' }
    Invoke-Manager install -ExpectFailure
    $runScript = Join-Path $runner 'dsh-task/run.ps1'
    $originalRun = Get-Content -LiteralPath $runScript -Raw
    Set-Content -LiteralPath (Join-Path $runner 'dsh-task/pipe-writer.ps1') -Value 'Start-Sleep -Seconds 240'
    $inheritedWriter = @'
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'inherited-writer-started'))) {
    $info = [Diagnostics.ProcessStartInfo]::new((Join-Path $PSHOME 'pwsh.exe'))
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    foreach ($arg in @('-NoProfile', '-NonInteractive', '-File', (Join-Path $PSScriptRoot 'pipe-writer.ps1'))) { $info.ArgumentList.Add($arg) }
    $writer = [Diagnostics.Process]::Start($info)
    Set-Content -LiteralPath (Join-Path $PSScriptRoot 'inherited-writer-started') -Value $writer.Id
    $writer.Dispose()
}
'@
    Set-Content -LiteralPath $runScript -Value ($inheritedWriter + "`n" + $originalRun)
    Invoke-Manager start
    $starts = Join-Path $runner 'starts.txt'
    Wait-Condition { (Get-ScheduledTaskInfo -TaskName $taskName -TaskPath '\').LastTaskResult -eq 5 } 'inherited writer returns drain timeout'
    if ((Get-ScheduledTask -TaskName $taskName -TaskPath '\').State -eq 'Disabled') { throw 'Drain timeout disabled automatic recovery.' }
    # The one-minute scheduler trigger and cold PowerShell/CIM startup share the busy Windows host.
    Wait-Condition { (Test-Path -LiteralPath $starts) -and @(Get-Content -LiteralPath $starts).Count -ge 2 } 'automatic retry after unexpected clean exit' 180
    if ([int](Get-Content -LiteralPath (Join-Path $runner 'dsh-task/attempts.txt') -Raw) -ne 2) { throw 'Drain recovery did not consume the normal restart budget.' }
    $consoles = @(Get-Content -LiteralPath (Join-Path $runner 'consoles.txt'))
    if ($consoles.Count -ne 2 -or @($consoles | Where-Object { $_ -ne '0' }).Count) { throw 'Initial or recovered runner allocated a console.' }
    $priorities = @(Get-Content -LiteralPath (Join-Path $runner 'priorities.jsonl') | ForEach-Object { $_ | ConvertFrom-Json })
    if ($priorities.Count -ne 2 -or @($priorities | Where-Object { $_.Cpu -ne 'Normal' -or $_.Io -ne 2 -or $_.Memory -ne 5 }).Count) { throw 'Initial or recovered runner inherited background scheduling priority.' }
    $childId = [int]@(Get-Content -LiteralPath $starts)[-1]
    $child = Get-Process -Id $childId
    Invoke-Manager start
    Invoke-Manager status
    if (@(Get-Content -LiteralPath $starts).Count -ne 2) { throw 'Duplicate runner started.' }
    Invoke-Manager uninstall -ExpectFailure
    $recordFile = Join-Path $runner 'dsh-task/process.json'
    $originalRecord = Get-Content -LiteralPath $recordFile -Raw
    $record = $originalRecord | ConvertFrom-Json
    $record.Started = 0
    try {
        $record | ConvertTo-Json | Set-Content -LiteralPath $recordFile
        Invoke-Manager stop -ExpectFailure
        if ($child.HasExited) { throw 'Stale process record terminated a process.' }
    } finally { Set-Content -LiteralPath $recordFile -Value $originalRecord }
    Invoke-Manager stop
    Wait-Condition { $child.Refresh(); $child.HasExited } 'scheduler child termination'
    Invoke-Manager start
    Wait-Condition { @(Get-Content -LiteralPath $starts).Count -eq 3 } 'explicit restart'
    $child = Get-Process -Id ([int]@(Get-Content -LiteralPath $starts)[-1])
    Invoke-Manager stop
    Wait-Condition { $child.Refresh(); $child.HasExited } 'restarted child termination'
    Set-Content -LiteralPath (Join-Path $runner 'dsh-task/attempts.txt') -Value '3'
    $null = Enable-ScheduledTask -TaskName $config.TaskName -TaskPath '\'
    Start-ScheduledTask -TaskName $config.TaskName -TaskPath '\'
    Wait-Condition { (Get-ScheduledTask -TaskName $config.TaskName -TaskPath '\').State -eq 'Disabled' } 'exhausted restart budget disables task'
    if (@(Get-Content -LiteralPath $starts).Count -ne 3) { throw 'Exhausted budget launched another runner.' }
    Set-Content -LiteralPath (Join-Path $runner 'dsh-task/attempts.txt') -Value 'invalid'
    $null = Enable-ScheduledTask -TaskName $config.TaskName -TaskPath '\'
    Start-ScheduledTask -TaskName $config.TaskName -TaskPath '\'
    Wait-Condition { (Get-ScheduledTask -TaskName $config.TaskName -TaskPath '\').State -eq 'Disabled' } 'invalid restart budget disables task'
    if (@(Get-Content -LiteralPath $starts).Count -ne 3) { throw 'Invalid budget launched another runner.' }
    $savedAction = (Get-ScheduledTask -TaskName $taskName -TaskPath '\').Actions
    $missingAction = New-ScheduledTaskAction -Execute $launcher -Argument ('"' + (Join-Path $root 'missing.exe') + '"') -WorkingDirectory $runner
    $null = Set-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $missingAction
    Set-Content -LiteralPath (Join-Path $runner 'dsh-task/attempts.txt') -Value '0'
    $null = Enable-ScheduledTask -TaskName $taskName -TaskPath '\'
    Start-ScheduledTask -TaskName $taskName -TaskPath '\'
    Wait-Condition { (Get-ScheduledTask -TaskName $taskName -TaskPath '\').State -eq 'Disabled' } 'launcher startup failure disables periodic starts'
    Wait-Condition { (Get-ScheduledTaskInfo -TaskName $taskName -TaskPath '\').LastTaskResult -eq 2 } 'launcher startup failure result'
    $null = Set-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $savedAction
    $taskDirectory = Join-Path $runner 'dsh-task'
    $originalAcl = Get-Acl -LiteralPath $taskDirectory
    try {
        $blockedAcl = Get-Acl -LiteralPath $taskDirectory
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $blockedAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'WriteData, AppendData', 'ContainerInherit, ObjectInherit', 'None', 'Deny'))
        Set-Acl -LiteralPath $taskDirectory -AclObject $blockedAcl
        $null = Enable-ScheduledTask -TaskName $taskName -TaskPath '\'
        Start-ScheduledTask -TaskName $taskName -TaskPath '\'
        Wait-Condition { (Get-ScheduledTask -TaskName $taskName -TaskPath '\').State -eq 'Disabled' } 'unwritable task directory disables periodic starts'
        Wait-Condition { (Get-ScheduledTaskInfo -TaskName $taskName -TaskPath '\').LastTaskResult -eq 3 } 'unwritable diagnostic result'
    } finally { Set-Acl -LiteralPath $taskDirectory -AclObject $originalAcl }
    if (@(Get-Content -LiteralPath $starts).Count -ne 3) { throw 'Launcher failure started another runner.' }
    if ([int](Get-Content -LiteralPath (Join-Path $taskDirectory 'attempts.txt') -Raw) -ne 0) { throw 'Startup failure unexpectedly entered run.ps1.' }
    Invoke-Manager uninstall
    $installed = $false
    Invoke-Manager status -ExpectFailure
    if (-not (Test-Path -LiteralPath (Join-Path $runner '.runner'))) { throw 'Registration removed.' }
    Write-Output "PASS: windowless initial launch and recovery, install, duplicate refusal, automatic retry, start, status, stop, child teardown, retry exhaustion, startup failure containment, unwritable diagnostics, uninstall. Evidence: $root"
} catch { $primaryFailure = $_; throw } finally {
    $cleanupErrors = @()
    if ($installed) {
        try { $null = Disable-ScheduledTask -TaskName $taskName -TaskPath '\' } catch { $cleanupErrors += $_ }
        try { Stop-ScheduledTask -TaskName $taskName -TaskPath '\' } catch { $cleanupErrors += $_ }
        try { Unregister-ScheduledTask -TaskName $taskName -TaskPath '\' -Confirm:$false } catch { $cleanupErrors += $_ }
    }
    foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name = 'pwsh.exe' OR Name = 'launcher.exe'")) {
        if (($process.Name -eq 'pwsh.exe' -and $process.CommandLine -and $process.CommandLine.Contains($root)) -or ($process.Name -eq 'launcher.exe' -and $process.ExecutablePath -and $process.ExecutablePath.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase))) {
            $owned = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
            if ($owned) {
                try {
                    Stop-Process -InputObject $owned
                    if (-not $owned.WaitForExit(30000)) { throw 'Fixture process did not exit.' }
                } catch { $cleanupErrors += $_ }
            }
        }
    }
    # Logs stay available for diagnosing scheduler failures; the fixture owns no registered runner credentials.
    Write-Output "Fixture retained: $root"
    if ($cleanupErrors.Count) { Write-Warning ($cleanupErrors -join "`n"); if (-not $primaryFailure) { throw 'Fixture cleanup failed.' } }
}
