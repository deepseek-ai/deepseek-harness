# Own one operator-configured network process until the registered runner exits.
param([Parameter(Mandatory=$true)][string]$RunnerRoot, [Parameter(Mandatory=$true)][string]$ConfigRoot, [Parameter(Mandatory=$true)][string]$NetworkRoot, [Parameter(Mandatory=$true)][string]$ReadinessScript, [Parameter(Mandatory=$true)][string]$StartScript, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$network = $NetworkRoot
$lock = $null
$process = $null
$started = $false
$runner = $null
$runnerStarted = $false
$restarts = 0
$recordPath = Join-Path $network 'process.json'
$code = 1
try {
    foreach ($directory in @($RunnerRoot,$ConfigRoot,$NetworkRoot)) {
        if ($directory -notmatch '^[A-Za-z]:[\\/]' -or -not (Test-Path -LiteralPath $directory -PathType Container)) { throw 'An existing absolute local directory is required.' }
    }
    foreach ($script in @($ReadinessScript,$StartScript)) {
        if ($script -notmatch '^[A-Za-z]:[\\/]' -or -not (Test-Path -LiteralPath $script -PathType Leaf)) { throw 'An existing absolute local script is required.' }
    }
    $lock = [IO.File]::Open((Join-Path $network 'supervisor.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    $launch = Get-Content (Join-Path $network 'launch.json') -Raw | ConvertFrom-Json -AsHashtable
    if ($launch -isnot [Collections.IDictionary] -or $launch.Count -ne 3 -or @($launch.Keys | Where-Object { $_ -cnotin @('executable','arguments','restartDelaySeconds') }).Count) { throw 'Invalid network launch configuration.' }
    if (($launch.restartDelaySeconds -isnot [long] -and $launch.restartDelaySeconds -isnot [int]) -or $launch.restartDelaySeconds -lt 1 -or $launch.restartDelaySeconds -gt 3600) { throw 'Invalid network restart interval.' }
    if ($launch.executable -isnot [string] -or $launch.arguments -isnot [array] -or @($launch.arguments | Where-Object { $_ -isnot [string] -or $_.Contains([char]0) }).Count) { throw 'Invalid network executable or arguments.' }
    if (-not [IO.Path]::IsPathFullyQualified($launch.executable) -or -not (Test-Path -LiteralPath $launch.executable -PathType Leaf)) { throw 'Network executable unavailable.' }
    $launch.executable = [IO.Path]::GetFullPath($launch.executable)
    if (Test-Path -LiteralPath $recordPath) {
        $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
        if ($record.pid -isnot [long] -and $record.pid -isnot [int]) { throw 'Invalid network process record.' }
        if ($record.pid -le 0 -or $record.started -isnot [long] -or $record.started -le 0) { throw 'Invalid network process record.' }
        $stale = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
        if ($stale) {
            try {
                if (-not $stale.StartTime) { throw 'Owned network process identity unavailable.' }
                if ($stale.StartTime.ToUniversalTime().Ticks -eq $record.started) {
                    if ($stale.Path -ne $launch.executable) { throw 'Owned network process identity unavailable.' }
                    $stale.Kill($true)
                    if (-not $stale.WaitForExit(10000)) { throw 'Owned network process did not stop.' }
                }
            } finally { $stale.Dispose() }
        }
        Remove-Item -LiteralPath $recordPath
    }
    $info = [Diagnostics.ProcessStartInfo]::new($launch.executable)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WorkingDirectory = $network
    foreach ($name in @('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy')) { $null = $info.Environment.Remove($name) }
    # Provider output can include private routes; it must never enter runner logs.
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($argument in $launch.arguments) { $info.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    if (-not $process.Start()) { throw 'Network process did not start.' }
    $started = $true
    $stdout = $process.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
    $stderr = $process.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
    @{pid=$process.Id;started=$process.StartTime.ToUniversalTime().Ticks} | ConvertTo-Json | Set-Content -LiteralPath $recordPath
    & (Join-Path $PSHOME 'pwsh.exe') -NoProfile -NonInteractive -File $ReadinessScript -RunnerRoot $RunnerRoot -ConfigRoot $ConfigRoot -CheckOnly
    if ($LASTEXITCODE -ne 0 -or $process.HasExited) { throw 'Network readiness failed; listener was not started.' }
    if ($CheckOnly) { $code = 0 } else {
        $runnerInfo = [Diagnostics.ProcessStartInfo]::new((Join-Path $PSHOME 'pwsh.exe'))
        $runnerInfo.UseShellExecute = $false
        $runnerInfo.CreateNoWindow = $true
        $runnerInfo.RedirectStandardOutput = $true
        $runnerInfo.RedirectStandardError = $true
        foreach ($argument in @('-NoProfile','-NonInteractive','-File',$StartScript,'-RunnerRoot',$RunnerRoot,'-ConfigRoot',$ConfigRoot)) { $runnerInfo.ArgumentList.Add($argument) }
        $runner = [Diagnostics.Process]::new()
        $runner.StartInfo = $runnerInfo
        if (-not $runner.Start()) { throw 'Runner process did not start.' }
        $runnerStarted = $true
        $runnerOut = $runner.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
        $runnerErr = $runner.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
        while (-not $runner.WaitForExit(1000)) {
            if ($started -and -not $process.HasExited) { continue }
            if ($started) {
                Write-Output "Network process exited (code $($process.ExitCode)); runner retained. Inspect local network configuration if recovery repeats."
                $started = $false
                Remove-Item -LiteralPath $recordPath
                $process.Dispose()
                $process = $null
            }
            # The runner's lifetime owns recovery; waiting on it also cancels the retry delay.
            if ($runner.WaitForExit($launch.restartDelaySeconds * 1000)) { break }
            $process = [Diagnostics.Process]::new()
            $process.StartInfo = $info
            try { $started = $process.Start() }
            catch {
                # Launch errors can contain private arguments or paths.
                $started = $false
            }
            if (-not $started) {
                $process.Dispose()
                $process = $null
                Write-Output 'Network process restart failed; runner retained. Inspect the local executable and configuration; recovery will retry.'
                continue
            }
            $stdout = $process.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
            $stderr = $process.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
            @{pid=$process.Id;started=$process.StartTime.ToUniversalTime().Ticks} | ConvertTo-Json | Set-Content -LiteralPath $recordPath
            $restarts++
            Write-Output "Network process restarted (attempt $restarts); runner retained. Connectivity recovery is handled by the runner."
        }
        $code = $runner.ExitCode
    }
} catch {
    # Do not expose provider paths, arguments, configuration or raw error messages.
    [Console]::Error.WriteLine('Private network supervision failed; inspect local state. No job was retried.')
    if ($runnerStarted -and -not $runner.HasExited) {
        [Console]::Error.WriteLine('Network recovery stopped; the existing runner remains running until it exits. Inspect local supervision state before maintenance.')
        $runner.WaitForExit()
    }
} finally {
    if ($runnerStarted) {
        try {
            if (-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($runnerOut,$runnerErr), 5000)) { throw 'Output drain timed out.' }
        } catch {
            $code = 1
            [Console]::Error.WriteLine('Runner output drain failed or timed out; output may be incomplete.')
        }
    }
    if ($runner) { $runner.Dispose() }
    try {
        if ($started) {
            if (-not $process.HasExited) { $process.Kill($true) }
            if (-not $process.WaitForExit(10000)) { throw 'Network cleanup did not complete.' }
            if (Test-Path -LiteralPath $recordPath) { Remove-Item -LiteralPath $recordPath }
        }
    } catch {
        $code = 1
        [Console]::Error.WriteLine('Owned network cleanup failed; inspect local process state before restarting.')
    } finally {
        if ($process) { $process.Dispose() }
        if ($lock) { $lock.Dispose() }
    }
}
exit $code
