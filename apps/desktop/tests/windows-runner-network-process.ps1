# Fake local processes only; no network or signing hardware.
$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ('demo-network-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory $root
try {
    foreach ($case in @('ready','not-ready','locked','missing-executable','stale','reused','invalid-config','invalid-delay','bad-record','provider-exit','runner-failure','check-only','recovery','task-route')) {
        $base = Join-Path $root $case
        $runner = Join-Path $base 'runner'
        $network = Join-Path $base 'network'
        $null = New-Item -ItemType Directory -Path $network,(Join-Path $runner 'dsh-task') -Force
        @'
Set-Content (Join-Path $PSScriptRoot 'child-pid') $PID
Write-Output 'PRIVATE-OUTPUT-MUST-NOT-LEAK'
Start-Sleep -Seconds 60
'@ | Set-Content (Join-Path $network 'fake.ps1')
        @'
param([string]$RunnerRoot,[string]$ConfigRoot)
$network = Join-Path (Split-Path $PSScriptRoot) 'network'
$deadline = [datetime]::UtcNow.AddSeconds(10)
while (-not (Test-Path (Join-Path $network 'child-pid'))) {
    if ([datetime]::UtcNow -ge $deadline) { exit 9 }
    Start-Sleep -Milliseconds 20
}
if (Test-Path (Join-Path $network 'fail')) { exit 1 }
exit 0
'@ | Set-Content (Join-Path $runner 'cold-boot-smoke.ps1')
        "Set-Content (Join-Path `$PSScriptRoot 'listened') yes; exit 0" | Set-Content (Join-Path $runner 'dsh-task/start-runner.ps1')
        if ($case -eq 'runner-failure') { Set-Content (Join-Path $runner 'dsh-task/start-runner.ps1') "Set-Content (Join-Path `$PSScriptRoot 'listened') yes; exit 7" }
        if ($case -in @('recovery','task-route')) {
            @'
param([string]$RunnerRoot,[string]$ConfigRoot,[switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$network = Join-Path $ConfigRoot 'network'
if ($CheckOnly) {
    $deadline = [datetime]::UtcNow.AddSeconds(30)
    while (-not (Test-Path (Join-Path $network 'child-pid'))) {
        if ([datetime]::UtcNow -ge $deadline) { exit 9 }
        Start-Sleep -Milliseconds 20
    }
    exit 0
}
Set-Content (Join-Path $PSScriptRoot 'listened') $PID
Write-Output 'RUNNER-STDOUT'
[Console]::Error.WriteLine('RUNNER-STDERR')
for ($iteration = 0; $iteration -lt 2; $iteration++) {
    $previous = [int](Get-Content (Join-Path $network 'child-pid'))
    $child = Get-Process -Id $previous
    try { $child.Kill(); $child.WaitForExit() } finally { $child.Dispose() }
    $deadline = [datetime]::UtcNow.AddSeconds(30)
    do {
        if ([datetime]::UtcNow -ge $deadline) { throw 'Network process was not recovered.' }
        Start-Sleep -Milliseconds 50
        $next = Get-Content (Join-Path $network 'child-pid') -Raw
    } while (-not $next -or [int]$next -eq $previous)
    if ([int](Get-Content (Join-Path $PSScriptRoot 'listened')) -ne $PID) { throw 'Runner was replaced during recovery.' }
}
Write-Output 'RUNNER-SURVIVED-RECOVERY'
exit 0
'@ | Set-Content (Join-Path $runner 'dsh-task/start-runner.ps1')
        }
        if ($case -eq 'provider-exit') {
            Set-Content (Join-Path $network 'fake.ps1') 'Set-Content (Join-Path $PSScriptRoot "child-pid") $PID; exit 0'
            @'
$network = Join-Path (Split-Path $PSScriptRoot) 'network'
$deadline = [datetime]::UtcNow.AddSeconds(10)
do {
    if ([datetime]::UtcNow -ge $deadline) { throw 'Provider exit barrier timed out.' }
    Start-Sleep -Milliseconds 20
    $record = Join-Path $network 'child-pid'
} while (-not (Test-Path $record) -or (Get-Process -Id ([int](Get-Content $record)) -ErrorAction SilentlyContinue))
exit 0
'@ | Set-Content (Join-Path $runner 'cold-boot-smoke.ps1')
        }
        $exe = if ($case -eq 'missing-executable') { Join-Path $network 'missing.exe' } else { Join-Path $PSHOME 'pwsh.exe' }
        @{executable=$exe;arguments=@('-NoProfile','-File',(Join-Path $network 'fake.ps1'));restartDelaySeconds=1} | ConvertTo-Json | Set-Content (Join-Path $network 'launch.json')
        if ($case -eq 'invalid-config') { Set-Content (Join-Path $network 'launch.json') '{"executable":"PRIVATE-OUTPUT","arguments":[],"unknown":true}' }
        if ($case -eq 'invalid-delay') { @{executable=$exe;arguments=@();restartDelaySeconds=0} | ConvertTo-Json | Set-Content (Join-Path $network 'launch.json') }
        if ($case -eq 'bad-record') { Set-Content (Join-Path $network 'process.json') '{"pid":0,"started":1}' }
        if ($case -eq 'not-ready') { Set-Content (Join-Path $network 'fail') yes }
        $held = if ($case -eq 'locked') { [IO.File]::Open((Join-Path $network 'supervisor.lock'),'OpenOrCreate','ReadWrite','None') } else { $null }
        $stale = $null
        try {
            if ($case -in @('stale','reused')) {
                $info = [Diagnostics.ProcessStartInfo]::new($exe)
                $info.UseShellExecute = $false
                $info.CreateNoWindow = $true
                foreach ($argument in @('-NoProfile','-Command','Start-Sleep -Seconds 60')) { $info.ArgumentList.Add($argument) }
                $stale = [Diagnostics.Process]::Start($info)
                @{pid=$stale.Id;started=($stale.StartTime.ToUniversalTime().Ticks + $(if($case -eq 'reused'){1}else{0}))} | ConvertTo-Json | Set-Content (Join-Path $network 'process.json')
            }
            [string[]]$options = @(if ($case -eq 'check-only') { '-CheckOnly' })
            if ($case -eq 'task-route') {
                $taskRoot = Join-Path $runner 'dsh-task'
                Copy-Item (Join-Path $PSScriptRoot '../scripts/run-windows-runner-task.ps1') (Join-Path $taskRoot 'run.ps1')
                Copy-Item (Join-Path $PSScriptRoot '../scripts/run-windows-runner-network-process.ps1') $taskRoot
                Copy-Item (Join-Path $taskRoot 'start-runner.ps1') (Join-Path $taskRoot 'start.ps1')
                @{RunnerRoot=$runner;ConfigRoot=$base;NetworkRoot=$network;RestartCount=1} | ConvertTo-Json | Set-Content (Join-Path $taskRoot 'config.json')
                Set-Content (Join-Path $taskRoot 'attempts.txt') 0
                Set-Content (Join-Path $base 'runner-network.json') '{}'
                & (Join-Path $PSHOME 'pwsh.exe') -NoProfile -File (Join-Path $taskRoot 'run.ps1')
                if ($LASTEXITCODE -ne 1) { throw 'Task wrapper must retain its unexpected-exit result.' }
                $output = Get-Content (Get-ChildItem $taskRoot -Filter 'run-*.log').FullName -Raw
                if ([int](Get-Content (Join-Path $taskRoot 'attempts.txt')) -ne 1) { throw 'Network recovery consumed task launch budget.' }
            } else {
                $output = & (Join-Path $PSHOME 'pwsh.exe') -NoProfile -File (Join-Path $PSScriptRoot '../scripts/run-windows-runner-network-process.ps1') -RunnerRoot $runner -ConfigRoot $base -NetworkRoot $network -ReadinessScript (Join-Path $runner 'cold-boot-smoke.ps1') -StartScript (Join-Path $runner 'dsh-task/start-runner.ps1') @options 2>&1 | Out-String
            }
            if (($LASTEXITCODE -eq 0) -ne ($case -in @('ready','stale','reused','check-only','recovery'))) { throw "Unexpected exit: ${case}: $output" }
            if ((Test-Path (Join-Path $runner 'dsh-task/listened')) -ne ($case -in @('ready','stale','reused','runner-failure','recovery','task-route'))) { throw "Listener admission failed: $case" }
            if ($case -in @('recovery','task-route')) {
                foreach ($expected in @('RUNNER-STDOUT','RUNNER-STDERR','RUNNER-SURVIVED-RECOVERY','Network process exited','Network process restarted (attempt 2)')) {
                    if (-not $output.Contains($expected)) { throw "Missing recovery evidence: $expected" }
                }
            }
            if ($case -eq 'stale' -and -not $stale.HasExited) { throw 'Owned stale provider was not reaped' }
            if ($case -eq 'reused' -and $stale.HasExited) { throw 'A reused PID was killed' }
            if ($output.Contains('PRIVATE-OUTPUT')) { throw 'Provider output leaked' }
            if (Test-Path (Join-Path $network 'child-pid')) {
                $childId = [int](Get-Content (Join-Path $network 'child-pid'))
                if (Get-Process -Id $childId -ErrorAction SilentlyContinue) { throw 'Child leaked' }
            }
            if ($case -ne 'bad-record' -and (Test-Path (Join-Path $network 'process.json'))) { throw 'Ownership record leaked' }
            if ($case -eq 'bad-record' -and -not (Test-Path (Join-Path $network 'process.json'))) { throw 'Invalid identity evidence was removed' }
            if (-not $held) {
                $released = [IO.File]::Open((Join-Path $network 'supervisor.lock'),'OpenOrCreate','ReadWrite','None')
                $released.Dispose()
            }
            Write-Output "PASS: $case"
        } finally {
            if ($stale) {
                if (-not $stale.HasExited) { $stale.Kill(); $stale.WaitForExit() }
                $stale.Dispose()
            }
            if ($held) { $held.Dispose() }
        }
    }
} finally {
    if ([IO.Path]::GetDirectoryName($root).TrimEnd('\') -ne [IO.Path]::GetTempPath().TrimEnd('\')) { throw 'Unsafe cleanup path' }
    Remove-Item -LiteralPath $root -Recurse -Force
}
exit 0
