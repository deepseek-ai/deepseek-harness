# Repeating Task Scheduler triggers recover an exited launcher without relying on action exit-code retries.
$ErrorActionPreference = 'Stop'
$runnerRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\','/')
$digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($runnerRoot.ToUpperInvariant())))
$taskName = 'DSH-Packaging-' + $digest.Substring(0,16)
$log = Join-Path $PSScriptRoot ('run-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + $PID + '.log')
try {
    @{ Pid = $PID; Started = (Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'process.json')
    $config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
    $attemptFile = Join-Path $PSScriptRoot 'attempts.txt'
    $attempts = [int](Get-Content -LiteralPath $attemptFile -Raw)
    if ($attempts -lt 0 -or $config.RestartCount -lt 1 -or $config.RestartCount -gt 999) { throw 'Invalid restart budget; reinstall the task.' }
    if ($attempts -gt $config.RestartCount) {
        $null = Disable-ScheduledTask -TaskName $config.TaskName -TaskPath '\'
        Set-Content -LiteralPath $log -Value 'Restart budget exhausted. Task disabled; inspect runner logs, fix the cause and run start.'
        exit 1
    }
    Set-Content -LiteralPath $attemptFile -Value ($attempts + 1)
    & (Join-Path $PSHOME 'pwsh.exe') -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'start.ps1') -RunnerRoot $config.RunnerRoot -ConfigRoot $config.ConfigRoot *> $log
    $code = $LASTEXITCODE
    Add-Content -LiteralPath $log -Value "Runner launcher exited with code $code."
    # An unexpected exit is a task failure even when run.cmd hides the listener's nonzero status; the log retains its code.
    exit 1
} catch {
    # A missing or unwritable counter cannot bound retries; the task name must not depend on readable configuration.
    $null = Disable-ScheduledTask -TaskName $taskName -TaskPath '\'
    $message = 'Runner task failed: ' + $_.Exception.Message
    [Console]::Error.WriteLine($message)
    Add-Content -LiteralPath $log -Value $message
    exit 1
}
