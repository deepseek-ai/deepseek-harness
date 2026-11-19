<# Reap timed-out fixture processes before their registry and filesystem cleanup. #>
function Stop-InstallerProcess([Diagnostics.Process]$Process) {
    if ($Process.HasExited) { return }
    $previousPreference = $ErrorActionPreference
    try {
        # A process can exit between HasExited and taskkill; inspect that race after capturing stderr.
        $ErrorActionPreference = 'Continue'
        $termination = & "$env:SystemRoot\System32\taskkill.exe" /PID $Process.Id /T /F 2>&1
        $terminationCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($terminationCode -ne 0 -and -not $Process.HasExited) { throw "Cannot terminate fixture process $($Process.Id): $termination" }
    if (-not $Process.WaitForExit(30000)) { throw "Fixture process $($Process.Id) remained after termination" }
}

function Wait-InstallerProcess([Diagnostics.Process]$Process, [int]$TimeoutMilliseconds = 30000) {
    try {
        if (-not $Process.WaitForExit($TimeoutMilliseconds)) { throw 'Setup timed out' }
        if ($Process.ExitCode -ne 0) { throw "Setup failed: $($Process.ExitCode)" }
    } finally {
        Stop-InstallerProcess $Process
    }
}
