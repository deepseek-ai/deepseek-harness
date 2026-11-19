# Repeating Task Scheduler triggers recover an exited launcher without relying on action exit-code retries.
$ErrorActionPreference = 'Stop'
$runnerRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\','/')
$digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($runnerRoot.ToUpperInvariant())))
$taskName = 'DSH-Packaging-' + $digest.Substring(0,16)
$log = Join-Path $PSScriptRoot ('run-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + $PID + '.log')
$attemptReserved = $false
try {
    $config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
    $attemptFile = Join-Path $PSScriptRoot 'attempts.txt'
    $attempts = [int](Get-Content -LiteralPath $attemptFile -Raw)
    if ($attempts -lt 0 -or $config.RestartCount -lt 1 -or $config.RestartCount -gt 999) { throw 'Invalid restart budget; reinstall the task.' }
    if ($attempts -gt $config.RestartCount) {
        throw 'Restart budget exhausted; inspect runner logs, fix the cause and run start.'
    }
    Set-Content -LiteralPath $attemptFile -Value ($attempts + 1)
    $attemptReserved = $true
    $startup = Join-Path $PSScriptRoot 'start.ps1'
    if ($config.NetworkRoot) {
        if (-not (Test-Path -LiteralPath (Join-Path $config.ConfigRoot 'runner-network.json') -PathType Leaf)) { throw 'Owned network supervision requires runner-network.json.' }
        & (Join-Path $PSHOME 'pwsh.exe') -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'run-windows-runner-network-process.ps1') -RunnerRoot $config.RunnerRoot -ConfigRoot $config.ConfigRoot -NetworkRoot $config.NetworkRoot -ReadinessScript $startup -StartScript $startup *> $log
    } else {
        & (Join-Path $PSHOME 'pwsh.exe') -NoProfile -NonInteractive -File $startup -RunnerRoot $config.RunnerRoot -ConfigRoot $config.ConfigRoot *> $log
    }
    $code = $LASTEXITCODE
    Add-Content -LiteralPath $log -Value "Runner launcher exited with code $code."
    # An unexpected exit is a task failure even when run.cmd hides the listener's nonzero status; the log retains its code.
    exit 1
} catch {
    $failure = $_.Exception.Message
    $disposition = 'Scheduled recovery remains bounded by the persisted attempt budget.'
    # Stop triggers when the budget is exhausted or an attempt could not be persisted.
    if (-not $attemptReserved) {
        try {
            $scheduler = New-Object -ComObject 'Schedule.Service'
            $scheduler.Connect()
            $scheduler.GetFolder('\').GetTask($taskName).Enabled = $false
            $disposition = 'Task disabled; inspect configuration and attempt storage before starting.'
        } catch {
            # A limited task account may lack permission to change its scheduler registration.
            $disposition = 'Task disable failed; an administrator must disable its triggers. No runner was launched.'
        }
    }
    $message = 'Runner task failed: ' + $failure + ' ' + $disposition
    [Console]::Error.WriteLine($message)
    try { Add-Content -LiteralPath $log -Value $message } catch {
        # The launcher captures stderr independently when the runner log is unavailable.
        [Console]::Error.WriteLine('Runner log unavailable: ' + $_.Exception.Message)
    }
    exit 1
}
