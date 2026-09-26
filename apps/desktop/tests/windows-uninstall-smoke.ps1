<# Production uninstaller checks with isolated application identity and seeded data. #>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Installer, [Parameter(Mandatory)][string]$ProductName,
    [Parameter(Mandatory)][string]$RegistryKey, [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$Language, [Parameter(Mandatory)][string]$PackageName)
$ErrorActionPreference = 'Stop'
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
. (Join-Path $PSScriptRoot 'windows-installer-ui.ps1')
[InstallerCapture]::Initialize()
$expected = Get-Content (Join-Path $PSScriptRoot 'expected/windows-uninstall.json') -Raw | ConvertFrom-Json
$roaming = [Environment]::GetFolderPath('ApplicationData')
$local = [Environment]::GetFolderPath('LocalApplicationData')
$installPath = Join-Path $OutputDirectory 'Uninstall App'
$homePath = Join-Path $OutputDirectory 'Harness Home'
$externalPath = Join-Path $OutputDirectory 'External Project'
$productDataPath = Join-Path $roaming $ProductName
# Electron nests user data under the package scope; electron-builder strips the separator from the updater cache name.
$scopePath = Join-Path $roaming $PackageName.Split('/')[0]
$userDataPath = Join-Path $roaming ($PackageName -replace '/', '\')
$cachePath = Join-Path $local (($PackageName -replace '[/\\?<>:*|"]', '').ToLowerInvariant() + '-updater')
$uninstaller = Join-Path $OutputDirectory 'uninstall-copy.exe'
$process = $null
function Wait-Text([string]$Text) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        $control = [InstallerCapture]::FindText($process.Id, $Text)
        if ($control -ne [IntPtr]::Zero) { return $control }
        if ($process.HasExited) { throw "Uninstaller exited: $($process.ExitCode)" }
        Start-Sleep -Milliseconds 25
    } while ($timer.Elapsed.TotalSeconds -lt 20)
    throw "Missing '$Text': $([InstallerCapture]::VisibleText($process.Id))"
}
function Wait-Exit {
    if (-not $process.WaitForExit(30000)) { $process.Kill(); $process.WaitForExit(); throw 'Uninstaller timed out' }
    if ($process.ExitCode -ne 0) { throw "Uninstall failed: $($process.ExitCode)" }
    $process.Dispose()
    $script:process = $null
    # The NSIS uninstaller hands its section to a temporary copy; the launched process exits before removal completes.
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while (Test-Path -LiteralPath $installPath) {
        if ($timer.Elapsed.TotalSeconds -gt 20) { throw 'Application directory remained' }
        Start-Sleep -Milliseconds 100
    }
}
try {
    foreach ($mode in $expected.cases) {
        $setup = Start-Process -FilePath $Installer -ArgumentList ('/S /D=' + $installPath) -PassThru -WindowStyle Hidden
        try {
            if (-not $setup.WaitForExit(30000)) { $setup.Kill(); $setup.WaitForExit(); throw 'Setup timed out' }
            if ($setup.ExitCode -ne 0) { throw "Setup failed: $($setup.ExitCode)" }
        } finally { $setup.Dispose() }
        $entry = Get-ItemProperty ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $RegistryKey)
        if ($entry.InstallLocation.TrimEnd('\') -ne $installPath) { throw 'Uninstall entry lacks InstallLocation' }
        foreach ($path in @($homePath, $productDataPath, $userDataPath, $cachePath, $externalPath)) { New-Item -ItemType Directory -Force -Path $path | Out-Null }
        [IO.File]::WriteAllText((Join-Path $externalPath 'keep.txt'), 'outside data root')
        if (-not (Test-Path -LiteralPath (Join-Path $userDataPath 'linked-project'))) {
            New-Item -ItemType Junction -Path (Join-Path $userDataPath 'linked-project') -Target $externalPath | Out-Null
        }
        [IO.File]::WriteAllText((Join-Path $homePath 'session.txt'), 'keep session')
        [IO.File]::WriteAllText((Join-Path $productDataPath 'state.txt'), 'product data')
        [IO.File]::WriteAllText((Join-Path $userDataPath 'Local State'), 'chromium profile')
        [IO.File]::WriteAllText((Join-Path $cachePath 'download.txt'), 'update')
        Copy-Item -LiteralPath (Join-Path $installPath ('Uninstall ' + $ProductName + '.exe')) -Destination $uninstaller -Force
        $arguments = '_?=' + $installPath
        if ($mode -in @('silent', 'home-inside')) { $arguments = '/S ' + $arguments }
        # electron-builder's installUtil.nsh runs an older uninstaller with exactly these flags when replacing it.
        if ($mode -eq 'upgrade') { $arguments = '/S /KEEP_APP_DATA --updated /currentuser ' + $arguments }
        if ($mode -eq 'replaced') { $arguments = '/S /KEEP_APP_DATA /currentuser ' + $arguments }
        if ($mode -eq 'home-inside') { $env:DSH_HOME = Join-Path $userDataPath 'home' } else { Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue }
        $process = Start-Process -FilePath $uninstaller -ArgumentList $arguments -PassThru -WindowStyle ($(if ($mode -eq 'interactive') { 'Normal' } else { 'Hidden' }))
        if ($mode -eq 'interactive') {
            $welcomeText = if ($Language -eq 'ENGLISH') { 'Welcome' } else { -join [char[]]@(0x6B22, 0x8FCE) }
            $welcome = Wait-Text $welcomeText
            $window = [InstallerCapture]::TopLevel($welcome)
            [void][InstallerCapture]::SaveNative($window, (Join-Path $OutputDirectory 'uninstall-welcome.png'), $false)
            [InstallerCapture]::Click([InstallerCapture]::GetDlgItem($window, 1))
            $finishedText = if ($Language -eq 'ENGLISH') { 'has been uninstalled' } else { -join [char[]]@(0x5DF2, 0x4ECE, 0x4F60) }
            [void](Wait-Text $finishedText)
            [InstallerCapture]::Click([InstallerCapture]::GetDlgItem($window, 1))
        }
        Wait-Exit
        $retained = $mode -in @('upgrade', 'replaced')
        # A DSH_HOME inside the Electron directory protects that directory (and its scope) but not the other roots.
        $userDataRetained = $retained -or $mode -eq 'home-inside'
        if ([IO.File]::ReadAllText((Join-Path $externalPath 'keep.txt')) -ne 'outside data root') { throw 'Cleanup followed a junction into a project' }
        if (-not (Test-Path (Join-Path $homePath 'session.txt'))) { throw "Harness home retention failed: $mode" }
        if ((Test-Path (Join-Path $productDataPath 'state.txt')) -ne $retained) { throw "Product data retention failed: $mode" }
        if ((Test-Path (Join-Path $userDataPath 'Local State')) -ne $userDataRetained) { throw "Electron user data retention failed: $mode" }
        if ((Test-Path -LiteralPath $scopePath) -ne $userDataRetained) { throw "Package scope directory retention failed: $mode" }
        if ((Test-Path (Join-Path $cachePath 'download.txt')) -ne $retained) { throw "Update cache retention failed: $mode" }
        Write-Output "passed: $mode"
    }
} finally {
    Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue
    if ($process) { if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }; $process.Dispose() }
    # Only unique test identities below known application-data parents are removed.
    foreach ($pair in @(@($productDataPath, $roaming), @($scopePath, $roaming), @($cachePath, $local))) {
        $target = [IO.Path]::GetFullPath($pair[0])
        if ([IO.Path]::GetDirectoryName($target) -ne $pair[1] -or -not ([IO.Path]::GetFileName($target).StartsWith('Harness Installer Test ') -or [IO.Path]::GetFileName($target).StartsWith('@harness-installer-test'))) { throw 'Unexpected fixture cleanup path' }
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    }
}
