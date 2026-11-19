# Isolated supervisor failures; no scheduler registration, GitHub or signing hardware.
$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ('runner-recovery-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory $root
$source = Get-Content (Join-Path $PSScriptRoot '../scripts/run-windows-runner-task.ps1') -Raw
try {
    foreach ($case in @('log-failure','counter-failure','exhausted','child-failure','disable-failure')) {
        $dir = Join-Path $root $case
        $null = New-Item -ItemType Directory $dir
        @{RestartCount=1;TaskName='fake';RunnerRoot=$dir;ConfigRoot=$dir} | ConvertTo-Json | Set-Content (Join-Path $dir 'config.json')
        Set-Content (Join-Path $dir 'attempts.txt') $(if($case -in @('exhausted','disable-failure')){'2'}else{'0'})
        Set-Content (Join-Path $dir 'start.ps1') 'Set-Content (Join-Path $PSScriptRoot "launched") yes; exit 7'
        $mocks = @'
function New-Object {
    param($ComObject)
    if ($ComObject -ne 'Schedule.Service') { throw 'Unexpected COM object.' }
    $task = [pscustomobject]@{}
    $task | Add-Member ScriptProperty Enabled { return $true } { param($Value); [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'disabled'),'yes') }
    $folder = [pscustomobject]@{ Task = $task }
    $folder | Add-Member ScriptMethod GetTask { param($Name); return $this.Task }
    $scheduler = [pscustomobject]@{ Folder = $folder }
    $scheduler | Add-Member ScriptMethod Connect {}
    $scheduler | Add-Member ScriptMethod GetFolder { param($Path); return $this.Folder }
    return $scheduler
}
'@
        if ($case -eq 'log-failure') { $mocks += "`nfunction Add-Content { throw 'Injected log storage unavailable' }" }
        if ($case -eq 'counter-failure') { $mocks += "`nfunction Set-Content { throw 'Injected counter storage unavailable' }" }
        if ($case -eq 'disable-failure') { $mocks = "function New-Object { throw 'Injected access denied' }" }
        Set-Content (Join-Path $dir 'run.ps1') ($mocks + "`n" + $source)
        $output = & (Join-Path $PSHOME 'pwsh.exe') -NoProfile -File (Join-Path $dir 'run.ps1') 2>&1 | Out-String
        if ($LASTEXITCODE -ne 1) { throw "$case must fail visibly" }
        $disabled = Test-Path (Join-Path $dir 'disabled')
        if ($disabled -ne ($case -in @('counter-failure','exhausted'))) { throw "$case unexpected task disposition" }
        if ($case -in @('log-failure','child-failure') -and [int](Get-Content (Join-Path $dir 'attempts.txt')) -ne 1) { throw 'Attempt must be persisted before launch' }
        if ($case -in @('log-failure','child-failure') -and -not (Test-Path (Join-Path $dir 'launched'))) { throw 'Allowed attempt did not execute the child.' }
        if ($case -eq 'child-failure' -and -not ((Get-Content (Join-Path $dir 'run-*.log') -Raw) -match 'exited with code 7')) { throw 'Child failure code was not retained.' }
        if ($case -eq 'log-failure' -and $output -notmatch 'Runner log unavailable') { throw 'Missing stderr fallback' }
        if ($case -in @('exhausted','disable-failure','counter-failure') -and (Test-Path (Join-Path $dir 'launched'))) { throw 'A blocked attempt launched a runner' }
        if ($case -eq 'disable-failure') {
            if ($output -notmatch 'Restart budget exhausted' -or $output -notmatch 'Task disable failed') { throw 'Missing original failure or scheduler disposition' }
            if ([int](Get-Content (Join-Path $dir 'attempts.txt')) -ne 2) { throw 'Exhausted budget changed' }
        }
        Write-Output "PASS: $case"
    }
} finally {
    if ([IO.Path]::GetFullPath($root).StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $root -Recurse -Force }
}
exit 0
