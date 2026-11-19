# Verify native parent IDs with an owned process and await its exit; no scheduler or runner is used.
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Requires PowerShell 7 on Windows.' }
Add-Type -Path (Join-Path $PSScriptRoot '../scripts/windows-runner-processes.cs')
$info = [Diagnostics.ProcessStartInfo]::new((Join-Path $PSHOME 'pwsh.exe'))
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
foreach ($argument in @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 120')) { $info.ArgumentList.Add($argument) }
$child = [Diagnostics.Process]::Start($info)
try {
    $parents = [DshRunnerProcesses]::ReadParents()
    if (-not $parents.ContainsKey($PID) -or -not $parents.ContainsKey($child.Id) -or $parents[$child.Id] -ne $PID) {
        throw 'Native process snapshot did not identify the owned child and parent.'
    }
} finally {
    try {
        if (-not $child.HasExited) { $child.Kill($true) }
        if (-not $child.WaitForExit(30000)) { throw 'Owned process did not exit.' }
    } finally { $child.Dispose() }
}
Write-Output 'PASS: native process ancestry and owned child teardown without CIM.'
exit 0
