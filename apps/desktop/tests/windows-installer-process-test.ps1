<# Exercise timeout cleanup with a real child that would otherwise outlive setup. #>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-installer-process.ps1')
$fixtureBase = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
$root = Join-Path $fixtureBase ('process-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$ready = Join-Path $root 'child.pid'
$marker = Join-Path $root 'late-write.txt'
$parent = $null
$child = $null
try {
    foreach ($exitCode in @(0, 7)) {
        $fixture = Start-Process powershell.exe -ArgumentList "-NoProfile -Command exit $exitCode" -WindowStyle Hidden -PassThru
        $failure = $null
        try { Wait-InstallerProcess $fixture } catch { $failure = $_.Exception.Message } finally { $fixture.Dispose() }
        if ($exitCode -eq 0 -and $failure) { throw $failure }
        if ($exitCode -eq 7 -and $failure -ne 'Setup failed: 7') { throw "Lost setup exit status: $failure" }
    }
    $childCode = "Start-Sleep -Seconds 60; [IO.File]::WriteAllText('$($marker.Replace("'", "''"))', 'unexpected')"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childCode))
    $readyLiteral = $ready.Replace("'", "''")
    $parentCode = "`$child = Start-Process powershell.exe -ArgumentList '-NoProfile -EncodedCommand $encoded' -WindowStyle Hidden -PassThru; [IO.File]::WriteAllText('$readyLiteral.tmp', [string]`$child.Id); [IO.File]::Move('$readyLiteral.tmp', '$readyLiteral'); `$child.WaitForExit()"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($parentCode))
    $parent = Start-Process powershell.exe -ArgumentList "-NoProfile -EncodedCommand $encoded" -WindowStyle Hidden -PassThru
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Path -LiteralPath $ready)) {
        if ($parent.HasExited -or $timer.Elapsed.TotalSeconds -gt 30) { throw 'Process fixture did not become ready' }
        Start-Sleep -Milliseconds 25
    }
    $child = [Diagnostics.Process]::GetProcessById([int][IO.File]::ReadAllText($ready))
    # Observe termination through an independently opened process handle.
    $observedParent = [Diagnostics.Process]::GetProcessById($parent.Id)
    try {
        $failure = $null
        try { Wait-InstallerProcess $parent -TimeoutMilliseconds 100 } catch { $failure = $_.Exception.Message }
        if ($failure -ne 'Setup timed out') { throw "Unexpected timeout result: $failure" }
        if (-not $observedParent.WaitForExit(10000) -or -not $child.WaitForExit(10000)) { throw 'Timed-out setup left a live process' }
        if (Test-Path -LiteralPath $marker) { throw 'Timed-out setup continued writing' }
    } finally { $observedParent.Dispose() }
    Write-Output 'passed: setup success, failure, timeout and child termination'
} finally {
    foreach ($fixture in @($parent, $child)) {
        if ($fixture) { Stop-InstallerProcess $fixture; $fixture.Dispose() }
    }
    if ([IO.Path]::GetDirectoryName($root) -ne $fixtureBase) { throw 'Unexpected process fixture cleanup path' }
    Remove-Item -LiteralPath $root -Recurse -Force
}
