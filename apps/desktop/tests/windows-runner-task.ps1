# Opt-in Windows Task Scheduler acceptance: isolated fake runner, no GitHub registration or signing access.
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Requires PowerShell 7 on Windows.' }
$root = Join-Path ([IO.Path]::GetTempPath()) ('dsh-runner-task-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $root
$source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../scripts'))
$runner = Join-Path $root 'runner with spaces'
$null = New-Item -ItemType Directory -Path $runner
Set-Content -LiteralPath (Join-Path $runner '.runner') -Value '{}'
foreach ($file in @('windows-runner-task.ps1','run-windows-runner-task.ps1')) { Copy-Item -LiteralPath (Join-Path $source $file) -Destination $root }
$manager = Join-Path $root 'windows-runner-task.ps1'
@'
param([string]$RunnerRoot, [string]$ConfigRoot, [switch]$CheckOnly)
if ($CheckOnly) { exit 0 }
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
function Wait-Condition([scriptblock]$Condition, [string]$Description, [int]$Seconds = 30) {
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
    if ($task.State -ne 'Disabled' -or $task.Settings.ExecutionTimeLimit -ne 'PT0S' -or $task.Settings.MultipleInstances -ne 'IgnoreNew') { throw 'Unexpected task scheduling settings.' }
    Invoke-Manager install -ExpectFailure
    Invoke-Manager start
    $starts = Join-Path $runner 'starts.txt'
    Wait-Condition { (Test-Path -LiteralPath $starts) -and @(Get-Content -LiteralPath $starts).Count -ge 2 } 'automatic retry after unexpected clean exit' 110
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
    Invoke-Manager uninstall
    $installed = $false
    Invoke-Manager status -ExpectFailure
    if (-not (Test-Path -LiteralPath (Join-Path $runner '.runner'))) { throw 'Registration removed.' }
    Write-Output "PASS: install, duplicate refusal, automatic retry, start, status, stop, child teardown, retry exhaustion, uninstall. Evidence: $root"
} catch { $primaryFailure = $_; throw } finally {
    $cleanupErrors = @()
    if ($installed) {
        try { $null = Disable-ScheduledTask -TaskName $taskName -TaskPath '\' } catch { $cleanupErrors += $_ }
        try { Stop-ScheduledTask -TaskName $taskName -TaskPath '\' } catch { $cleanupErrors += $_ }
        try { Unregister-ScheduledTask -TaskName $taskName -TaskPath '\' -Confirm:$false } catch { $cleanupErrors += $_ }
    }
    foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name = 'pwsh.exe'")) {
        if ($process.CommandLine -and $process.CommandLine.Contains($root)) {
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
