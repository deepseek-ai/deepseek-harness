<# Production uninstaller checks with isolated application identity and seeded data. #>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Installer, [Parameter(Mandatory)][string]$ProductName,
    [Parameter(Mandatory)][string]$RegistryKey, [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$Language, [Parameter(Mandatory)][string]$PackageName)
$ErrorActionPreference = 'Stop'
$copy = (Get-Content (Join-Path $PSScriptRoot "../installer/locales/$Language.json") -Encoding UTF8 -Raw | ConvertFrom-Json).uninstaller
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
$environmentKey = "Software\DSHUninstallTests\$RegistryKey\CommandEnvironment"
$ownerKey = "Software\DSHUninstallTests\$RegistryKey\CommandOwner"
$protocolKey = "Software\Classes\dsh-test-$RegistryKey"
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
        $commandDirectory = Join-Path $installPath 'resources\runtime\cli\bin'
        $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($environmentKey)
        try { $key.SetValue('Path', $commandDirectory + ';C:\Windows', [Microsoft.Win32.RegistryValueKind]::ExpandString) } finally { $key.Dispose() }
        $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($ownerKey)
        try { $key.SetValue('Directory', $commandDirectory); $key.SetValue('RetainedEntries', 0) } finally { $key.Dispose() }
        $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($protocolKey + '\shell\open\command')
        try { $key.SetValue('', '"' + (Join-Path $installPath ($ProductName + '.exe')) + '" "%1"') } finally { $key.Dispose() }
        $launchUninstaller = $uninstaller
        $arguments = '_?=' + $installPath
        if ($mode -in @('silent', 'home-inside', 'registration-error')) { $arguments = '/S ' + $arguments }
        # electron-builder's installUtil.nsh runs an older uninstaller with exactly these flags when replacing it.
        if ($mode -eq 'upgrade') {
            Set-ItemProperty -LiteralPath ('HKCU:\Software\' + $RegistryKey) -Name InstallLocation -Value ($installPath + '\')
            $arguments = '/S /KEEP_APP_DATA --updated /currentuser ' + $arguments }
        if ($mode -eq 'replaced') { $arguments = '/S /KEEP_APP_DATA /currentuser ' + $arguments }
        if ($mode -eq 'self-copy') {
            $launchUninstaller = Join-Path $installPath ('Uninstall ' + $ProductName + '.exe')
            $arguments = '/S /KEEP_APP_DATA'
        }
        if ($mode -eq 'home-inside') { $env:DSH_HOME = Join-Path $userDataPath 'home' } else { Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue }
        if ($mode -eq 'registration-error') {
            $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($environmentKey, $true)
            try { $key.SetValue('Path', 42, [Microsoft.Win32.RegistryValueKind]::DWord) } finally { $key.Dispose() }
        }
        $process = Start-Process -FilePath $launchUninstaller -ArgumentList $arguments -PassThru -WindowStyle ($(if ($mode -eq 'interactive') { 'Normal' } else { 'Hidden' }))
        if ($mode -eq 'interactive') {
            $welcomeText = $copy.welcome
            $welcome = Wait-Text $welcomeText
            $window = [InstallerCapture]::TopLevel($welcome)
            [void][InstallerCapture]::SaveNative($window, (Join-Path $OutputDirectory 'uninstall-welcome.png'), $false)
            [InstallerCapture]::Click([InstallerCapture]::GetDlgItem($window, 1))
            $finishedText = $copy.finished
            [void](Wait-Text $finishedText)
            [InstallerCapture]::Click([InstallerCapture]::GetDlgItem($window, 1))
        }
        if ($mode -eq 'registration-error') {
            if (-not $process.WaitForExit(30000) -or $process.ExitCode -ne 2) { throw 'Registration failure did not stop uninstall' }
            $process.Dispose(); $process = $null
            if (-not (Test-Path -LiteralPath (Join-Path $installPath ($ProductName + '.exe')))) { throw 'Failed registration cleanup deleted application' }
            $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($environmentKey, $true)
            try { $key.SetValue('Path', $commandDirectory + ';C:\Windows', [Microsoft.Win32.RegistryValueKind]::ExpandString) } finally { $key.Dispose() }
            $process = Start-Process -FilePath $launchUninstaller -ArgumentList $arguments -PassThru -WindowStyle Hidden
        }
        Wait-Exit
        $retained = $mode -in @('upgrade', 'replaced', 'self-copy')
        # A DSH_HOME inside the Electron directory protects that directory (and its scope) but not the other roots.
        $userDataRetained = $retained -or $mode -eq 'home-inside'
        if ([IO.File]::ReadAllText((Join-Path $externalPath 'keep.txt')) -ne 'outside data root') { throw 'Cleanup followed a junction into a project' }
        if (-not (Test-Path (Join-Path $homePath 'session.txt'))) { throw "Harness home retention failed: $mode" }
        if ((Test-Path (Join-Path $productDataPath 'state.txt')) -ne $retained) { throw "Product data retention failed: $mode" }
        if ((Test-Path (Join-Path $userDataPath 'Local State')) -ne $userDataRetained) { throw "Electron user data retention failed: $mode" }
        if ((Test-Path -LiteralPath $scopePath) -ne $userDataRetained) { throw "Package scope directory retention failed: $mode" }
        if ((Test-Path (Join-Path $cachePath 'download.txt')) -ne $retained) { throw "Update cache retention failed: $mode" }
        $integrationsRetained = $mode -eq 'upgrade'
        $owner = Get-ItemProperty -LiteralPath ('HKCU:\' + $ownerKey)
        if ([bool]$owner.Directory -ne $integrationsRetained) { throw "Command ownership cleanup failed: $mode" }
        $path = (Get-ItemProperty -LiteralPath ('HKCU:\' + $environmentKey)).Path
        if ($path.Contains($commandDirectory) -ne $integrationsRetained -or -not $path.Contains('C:\Windows')) { throw "PATH cleanup failed: $mode" }
        if ((Test-Path -LiteralPath ('HKCU:\' + $protocolKey)) -ne $integrationsRetained) { throw "Protocol cleanup failed: $mode" }
        Write-Output "passed: $mode"
    }
    # Real replacement publishes B after the old A uninstaller has been retained.
    $setup = Start-Process $Installer -ArgumentList ('/S /D=' + $installPath) -PassThru -WindowStyle Hidden
    try { if (-not $setup.WaitForExit(30000) -or $setup.ExitCode -ne 0) { throw 'Takeover A setup failed' } } finally { $setup.Dispose() }
    Copy-Item -LiteralPath (Join-Path $installPath ('Uninstall ' + $ProductName + '.exe')) -Destination $uninstaller -Force
    $newPath = Join-Path $OutputDirectory 'Replacement App'
    $setup = Start-Process $Installer -ArgumentList ('/S /D=' + $newPath) -PassThru -WindowStyle Hidden
    try { if (-not $setup.WaitForExit(30000) -or $setup.ExitCode -ne 0) { throw 'Takeover B setup failed' } } finally { $setup.Dispose() }
    $newCommand = Join-Path $newPath 'resources\runtime\cli\bin'
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($ownerKey)
    try { $key.SetValue('Directory', $newCommand) } finally { $key.Dispose() }
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($environmentKey)
    try { $key.SetValue('Path', $newCommand + ';C:\Windows') } finally { $key.Dispose() }
    $newProtocol = '"' + (Join-Path $newPath ($ProductName + '.exe')) + '" "%1"'
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($protocolKey + '\shell\open\command')
    try { $key.SetValue('', $newProtocol) } finally { $key.Dispose() }
    $process = Start-Process $uninstaller -ArgumentList ('/S /currentuser _?=' + $installPath) -PassThru -WindowStyle Hidden
    if (-not $process.WaitForExit(30000) -or $process.ExitCode -ne 2) { throw 'Stale uninstaller was not rejected' }
    $process.Dispose(); $process = $null
    if (-not (Test-Path -LiteralPath (Join-Path $newPath ($ProductName + '.exe')))) { throw 'Stale uninstaller deleted B' }
    $entry = Get-ItemProperty ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $RegistryKey)
    if ($entry.InstallLocation.TrimEnd('\') -ne $newPath) { throw 'Stale uninstaller removed B registration' }
    if ((Get-ItemProperty ('HKCU:\' + $ownerKey)).Directory -ne $newCommand) { throw 'Stale uninstaller changed B command owner' }
    if ((Get-ItemProperty ('HKCU:\' + $environmentKey)).Path -ne ($newCommand + ';C:\Windows')) { throw 'Stale uninstaller changed B PATH' }
    if ((Get-Item ('HKCU:\' + $protocolKey + '\shell\open\command')).GetValue('') -ne $newProtocol) { throw 'Stale uninstaller changed B protocol' }
    $installPath = $newPath
    Copy-Item -LiteralPath (Join-Path $installPath ('Uninstall ' + $ProductName + '.exe')) -Destination $uninstaller -Force
    $process = Start-Process $uninstaller -ArgumentList ('/S _?=' + $installPath) -PassThru -WindowStyle Hidden
    Wait-Exit
    Write-Output 'passed: installation takeover'
} finally {
    foreach ($key in @("Software\DSHUninstallTests\$RegistryKey", $protocolKey)) { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($key, $false) }
    Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue
    if ($process) { if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }; $process.Dispose() }
    # Only unique test identities below known application-data parents are removed.
    foreach ($pair in @(@($productDataPath, $roaming), @($scopePath, $roaming), @($cachePath, $local))) {
        $target = [IO.Path]::GetFullPath($pair[0])
        if ([IO.Path]::GetDirectoryName($target) -ne $pair[1] -or -not ([IO.Path]::GetFileName($target).StartsWith('Harness Installer Test ') -or [IO.Path]::GetFileName($target).StartsWith('@harness-installer-test'))) { throw 'Unexpected fixture cleanup path' }
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    }
}
