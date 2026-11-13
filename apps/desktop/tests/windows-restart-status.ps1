<# The private NSIS owner must finish after its window dies, and reap the window on owner death. #>
param([Parameter(Mandatory)][string]$OwnerExe)
$ErrorActionPreference = 'Stop'
$marker = Join-Path (Split-Path $OwnerExe) 'finish-owner'
$release = Join-Path (Split-Path $OwnerExe) 'release-directory'
$released = Join-Path (Split-Path $OwnerExe) 'directory-released'
$installation = Join-Path (Split-Path $OwnerExe) 'install-root'
$backup = "$installation.old"
foreach ($interrupt in 'window', 'owner') {
    $owner = Start-Process -FilePath $OwnerExe -WindowStyle Hidden -PassThru
    $window = $null
    try {
        $timer = [Diagnostics.Stopwatch]::StartNew()
        do {
            $row = Get-CimInstance Win32_Process -Filter ("ParentProcessId={0} AND Name='rundll32.exe'" -f $owner.Id)
            if ($row) { $window = Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue }
            if ($window -and $window.MainWindowHandle -ne 0) { break }
            if ($owner.HasExited -or $timer.Elapsed.TotalSeconds -gt 12) { throw 'No status window under the private owner' }
            Start-Sleep -Milliseconds 40
        } while ($true)
        New-Item -ItemType File -Path $release | Out-Null
        while (-not (Test-Path -LiteralPath $released)) {
            if ($owner.HasExited -or $timer.Elapsed.TotalSeconds -gt 15) { throw 'Owner did not release its working directory' }
            Start-Sleep -Milliseconds 40
        }
        # The window is alive while the installer promotes the staged application.
        if ($window.HasExited) { throw 'Status process exited before directory replacement' }
        Move-Item -LiteralPath $installation -Destination $backup
        Move-Item -LiteralPath $backup -Destination $installation
        if ($window.HasExited) { throw 'Status process exited during directory replacement' }
        if ($interrupt -eq 'window') {
            $window.Kill()
            New-Item -ItemType File -Path $marker | Out-Null
            if (-not $owner.WaitForExit(5000) -or $owner.ExitCode -ne 0) { throw 'Window failure changed owner completion' }
        } else {
            $owner.Kill()
            if (-not $owner.WaitForExit(5000)) { throw 'Owner did not exit after termination' }
        }
        if (-not $window.WaitForExit(5000)) { throw 'The status window survived its owner' }
    } finally {
        if (-not $owner.HasExited) { $owner.Kill(); $owner.WaitForExit() }
        if ($window -and -not $window.HasExited) { $window.Kill(); $window.WaitForExit() }
        foreach ($file in @($marker, $release, $released)) {
            if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file }
        }
        $owner.Dispose()
        if ($window) { $window.Dispose() }
    }
}
