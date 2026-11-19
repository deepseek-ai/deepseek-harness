<# Production uninstaller checks with isolated application identity and seeded data. #>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Installer, [Parameter(Mandatory)][string]$ProductName,
    [Parameter(Mandatory)][string]$RegistryKey, [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$Language, [Parameter(Mandatory)][string]$PackageName)
$ErrorActionPreference = 'Stop'
$copy = (Get-Content (Join-Path $PSScriptRoot "../installer/locales/$Language.json") -Encoding UTF8 -Raw | ConvertFrom-Json).uninstaller
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
. (Join-Path $PSScriptRoot 'windows-installer-ui.ps1')
. (Join-Path $PSScriptRoot 'windows-installer-process.ps1')
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
$setup = $null
$held = $null
$originalHome = [Environment]::GetEnvironmentVariable('DSH_HOME', 'Process')
$strings = (Get-Content (Join-Path $PSScriptRoot "../installer/locales/$Language.json") -Encoding UTF8 -Raw | ConvertFrom-Json).strings
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
        Wait-InstallerProcess $setup
        $setup.Dispose(); $setup = $null
        $entry = Get-ItemProperty ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $RegistryKey)
        if ($entry.InstallLocation.TrimEnd('\') -ne $installPath) { throw 'Uninstall entry lacks InstallLocation' }
        $deepAsset = Join-Path $installPath (('nested-' * 20) + '\' + ('asset-' * 15) + '.txt')
        if ($deepAsset.Length -le 260) { throw 'Uninstall fixture must exceed MAX_PATH' }
        [IO.Directory]::CreateDirectory('\\?\' + [IO.Path]::GetDirectoryName($deepAsset)) | Out-Null
        [IO.File]::WriteAllText(('\\?\' + $deepAsset), 'long path payload')
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
        $missingLocation = $mode -in @('missing-location', 'missing-location-short', 'missing-location-foreign')
        $foreign = $mode -eq 'missing-location-foreign'
        if ($missingLocation) { Remove-ItemProperty -LiteralPath ('HKCU:\Software\' + $RegistryKey) -Name InstallLocation }
        $arpKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $RegistryKey
        if ($mode -eq 'missing-location') {
            $originalCommand = (Get-ItemProperty $arpKey).UninstallString
            $alternateCommand = $originalCommand.Replace($installPath + '\', $installPath + '\.\')
            if ($alternateCommand -ceq $originalCommand -or -not $alternateCommand.Contains($installPath + '\.\')) { throw 'Equivalent-path fixture did not rewrite the uninstall command' }
            Set-ItemProperty $arpKey UninstallString $alternateCommand
        }
        if ($mode -eq 'missing-location-short') {
            $uninstallFile = Join-Path $installPath ('Uninstall ' + $ProductName + '.exe')
            $shortFile = (New-Object -ComObject Scripting.FileSystemObject).GetFile($uninstallFile).ShortPath
            if ($shortFile -ceq $uninstallFile) { throw 'Short-name fixture has no alternate name' }
            Set-ItemProperty $arpKey UninstallString ('"' + $shortFile + '" /currentuser')
        }
        $desktopLink = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) ($ProductName + '.lnk')
        $startLink = Join-Path ([Environment]::GetFolderPath('Programs')) ($ProductName + '.lnk')
        if ($missingLocation) {
            if (-not (Test-Path -LiteralPath $startLink) -or (New-Object -ComObject WScript.Shell).CreateShortcut($startLink).TargetPath -ne (Join-Path $installPath ($ProductName + '.exe'))) { throw 'Missing A Start menu fixture' }
            $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($desktopLink)
            $shortcut.TargetPath = Join-Path $installPath ($ProductName + '.exe')
            $shortcut.Save()
            if (-not (Test-Path -LiteralPath $desktopLink) -or -not (Test-Path -LiteralPath $arpKey)) { throw 'Missing A uninstall fixtures' }
        }
        $integrationRoot = if ($foreign) { $externalPath } else { $installPath }
        $commandDirectory = Join-Path $integrationRoot 'resources\runtime\cli\bin'
        $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($environmentKey)
        try { $key.SetValue('Path', $commandDirectory + ';C:\Windows', [Microsoft.Win32.RegistryValueKind]::ExpandString) } finally { $key.Dispose() }
        $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($ownerKey)
        try { $key.SetValue('Directory', $commandDirectory); $key.SetValue('RetainedEntries', 0) } finally { $key.Dispose() }
        if ($mode -eq 'unowned') {
            $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($ownerKey, $true)
            try { $key.DeleteValue('Directory'); $key.DeleteValue('RetainedEntries') } finally { $key.Dispose() }
        }
        if ($mode -eq 'owned-retained') {
            Set-ItemProperty -LiteralPath ('HKCU:\' + $ownerKey) -Name RetainedEntries -Value 1
            Set-ItemProperty -LiteralPath ('HKCU:\' + $environmentKey) -Name Path -Value ($commandDirectory + ';' + $commandDirectory + ';C:\Windows')
        }
        $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($protocolKey + '\shell\open\command')
        try { $key.SetValue('', '"' + (Join-Path $integrationRoot ($ProductName + '.exe')) + '" "%1"') } finally { $key.Dispose() }
        $launchUninstaller = $uninstaller
        $arguments = '_?=' + $installPath
        if ($mode -in @('silent', 'missing-location', 'missing-location-short', 'missing-location-foreign', 'unowned', 'owned-retained', 'home-inside', 'home-slash', 'home-tilde', 'home-slash-inside', 'registration-error', 'main-locked', 'auxiliary-locked', 'unsafe-root')) { $arguments = '/S ' + $arguments }
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
        if ($mode -eq 'home-slash') { $env:DSH_HOME = $homePath.Replace('\', '/') }
        if ($mode -eq 'home-tilde') {
            if (-not $homePath.StartsWith($env:USERPROFILE + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Tilde fixture must be inside USERPROFILE' }
            $env:DSH_HOME = '~/' + $homePath.Substring($env:USERPROFILE.Length + 1).Replace('\', '/')
        }
        if ($mode -eq 'home-slash-inside') { $env:DSH_HOME = (Join-Path $userDataPath 'home').Replace('\', '/') }
        if ($mode -in @('registration-error', 'save-report')) {
            $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($environmentKey, $true)
            try { $key.SetValue('Path', 42, [Microsoft.Win32.RegistryValueKind]::DWord) } finally { $key.Dispose() }
        }
        if ($mode -eq 'auxiliary-locked') {
            $residual = Join-Path $installPath 'held-log.txt'
            [IO.File]::WriteAllText($residual, 'held auxiliary data')
            $held = [IO.File]::Open($residual, 'Open', 'Read', 'Read')
        }
        if ($mode -eq 'unsafe-root') {
            $linked = Join-Path $OutputDirectory 'Linked Install'
            New-Item -ItemType Junction -Path $linked -Target $externalPath | Out-Null
            $process = Start-Process -FilePath $launchUninstaller -ArgumentList ('/S _?=' + $linked) -PassThru -WindowStyle Hidden
            if (-not $process.WaitForExit(30000) -or $process.ExitCode -ne 2) { throw 'Linked root was not rejected' }
            if (-not (Test-Path -LiteralPath (Join-Path $externalPath 'keep.txt'))) { throw 'Unsafe root deleted external files' }
            $report = Get-Content (Join-Path $env:TEMP ('DeepSeek-Harness-uninstall-' + $process.Id + '.txt')) -Raw
            if (-not $report.Contains('no deletion started')) { throw 'Unsafe scope missing from report' }
            $process.Dispose(); $process = $null
            [IO.Directory]::Delete($linked)
        }
        if ($mode -eq 'main-locked') {
            $held = [IO.File]::Open((Join-Path $installPath ($ProductName + '.exe')), 'Open', 'Read', 'Read')
        }
        $process = Start-Process -FilePath $launchUninstaller -ArgumentList $arguments -PassThru -WindowStyle ($(if ($mode -in @('interactive','save-report')) { 'Normal' } else { 'Hidden' }))
        if ($mode -in @('interactive','save-report')) {
            $welcomeText = $copy.welcome
            $welcome = Wait-Text $welcomeText
            $window = [InstallerCapture]::TopLevel($welcome)
            [void][InstallerCapture]::SaveNative($window, (Join-Path $OutputDirectory 'uninstall-welcome.png'), $false)
            [InstallerCapture]::Click([InstallerCapture]::GetDlgItem($window, 1))
            if ($mode -eq 'save-report') {
                $save = Wait-Text $strings.INSTALLER_UNINSTALL_SAVE
                $dialog = [InstallerCapture]::TopLevel($save)
                [void][InstallerCapture]::SaveNative($dialog, (Join-Path $OutputDirectory 'uninstall-residual.png'), $false)
                [InstallerCapture]::Click($save)
                $timer = [Diagnostics.Stopwatch]::StartNew()
                do {
                    $picker = [InstallerCapture]::FindWindowTitle($process.Id, $strings.INSTALLER_UNINSTALL_SAVE)
                    if ($timer.Elapsed.TotalSeconds -gt 20) { throw 'Save file picker did not appear' }
                    Start-Sleep -Milliseconds 25
                } while ($picker -eq [IntPtr]::Zero)
                $filename = [InstallerCapture]::FindClass($picker, 'Edit')
                if ($filename -eq [IntPtr]::Zero) { throw 'Save filename control missing' }
                $savedReport = Join-Path $OutputDirectory ('saved-report-' + [Guid]::NewGuid().ToString('N') + '.txt')
                while ([InstallerCapture]::ControlText($filename) -ne 'DeepSeek-Harness-uninstall-report.txt') {
                    if ($timer.Elapsed.TotalSeconds -gt 20) { throw 'Save filename initialization did not finish' }
                    Start-Sleep -Milliseconds 25
                }
                [void][InstallerCapture]::SendMessage($filename, 0xC, [IntPtr]::Zero, $savedReport)
                if ([InstallerCapture]::ControlText($filename) -ne $savedReport) { throw 'Save filename was not set' }
                [InstallerCapture]::Click([InstallerCapture]::GetDlgItem($picker, 1))
                # The native picker briefly creates a probe file; the returning report dialog signals the real write is finished.
                $save = Wait-Text $strings.INSTALLER_UNINSTALL_SAVE
                $timer = [Diagnostics.Stopwatch]::StartNew()
                while (-not (Test-Path -LiteralPath $savedReport)) {
                    if ($timer.Elapsed.TotalSeconds -gt 20) { throw "Save report did not create file: $([InstallerCapture]::VisibleText($process.Id))" }
                    Start-Sleep -Milliseconds 50
                }
                if (-not ([IO.File]::ReadAllText($savedReport).Contains($environmentKey))) { throw 'Saved report omitted registry key' }
                [void][InstallerCapture]::PostMessage([InstallerCapture]::TopLevel($save), 0x10, [IntPtr]::Zero, [IntPtr]::Zero)
            }
            $finishedText = $copy.finished
            [void](Wait-Text $finishedText)
            [InstallerCapture]::Click([InstallerCapture]::GetDlgItem($window, 1))
        }
        if ($mode -eq 'main-locked') {
            if (-not $process.WaitForExit(30000) -or $process.ExitCode -ne 2) { throw 'Locked main executable did not stop uninstall' }
            $report = Get-Content (Join-Path $env:TEMP ("DeepSeek-Harness-uninstall-" + $process.Id + '.txt')) -Raw
            if (-not $report.Contains($ProductName + '.exe') -or -not $report.Contains('32')) { throw 'Locked executable missing from report' }
            if (-not (Test-Path -LiteralPath (Join-Path $installPath ('Uninstall ' + $ProductName + '.exe')))) { throw 'Retry uninstaller was removed' }
            if (-not (Test-Path -LiteralPath ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $RegistryKey))) { throw 'Retry uninstall entry was removed' }
            $held.Dispose(); $held = $null
            $process.Dispose(); $process = $null
            $process = Start-Process -FilePath $launchUninstaller -ArgumentList $arguments -PassThru -WindowStyle Hidden
        }
        if ($mode -eq 'registration-error') {
            if (-not $process.WaitForExit(30000) -or $process.ExitCode -ne 0) { throw 'Registration failure blocked uninstall' }
            $report = Get-Content (Join-Path $env:TEMP ("DeepSeek-Harness-uninstall-" + $process.Id + '.txt')) -Raw
            if (-not $report.Contains($environmentKey) -or -not $report.Contains('[Path]')) { throw 'Registry residual missing from report' }
        }
        if ($mode -eq 'auxiliary-locked') {
            if (-not $process.WaitForExit(30000) -or $process.ExitCode -ne 0) { throw 'Auxiliary failure blocked uninstall' }
            if (Test-Path -LiteralPath (Join-Path $installPath ($ProductName + '.exe'))) { throw 'Auxiliary failure retained main executable' }
            $report = Get-Content (Join-Path $env:TEMP ('DeepSeek-Harness-uninstall-' + $process.Id + '.txt')) -Raw
            if (-not $report.Contains('held-log.txt')) { throw 'Auxiliary file missing from report' }
            $held.Dispose(); $held = $null
            Remove-Item -LiteralPath $residual
            [IO.Directory]::Delete($installPath)
        }
        Wait-Exit
        $retained = $missingLocation -or $mode -in @('upgrade', 'replaced', 'self-copy')
        # A DSH_HOME inside the Electron directory protects that directory (and its scope) but not the other roots.
        $userDataRetained = $retained -or $mode -in @('home-inside', 'home-slash-inside')
        if ([IO.File]::ReadAllText((Join-Path $externalPath 'keep.txt')) -ne 'outside data root') { throw 'Cleanup followed a junction into a project' }
        if (-not (Test-Path (Join-Path $homePath 'session.txt'))) { throw "Harness home retention failed: $mode" }
        if ((Test-Path (Join-Path $productDataPath 'state.txt')) -ne $retained) { throw "Product data retention failed: $mode" }
        if ((Test-Path (Join-Path $userDataPath 'Local State')) -ne $userDataRetained) { throw "Electron user data retention failed: $mode" }
        if ((Test-Path -LiteralPath $scopePath) -ne $userDataRetained) { throw "Package scope directory retention failed: $mode" }
        if ((Test-Path (Join-Path $cachePath 'download.txt')) -ne $retained) { throw "Update cache retention failed: $mode" }
        $integrationsRetained = $foreign -or $mode -in @('upgrade', 'registration-error', 'save-report')
        $owner = Get-ItemProperty -LiteralPath ('HKCU:\' + $ownerKey)
        if ([bool]$owner.Directory -ne $integrationsRetained) { throw "Command ownership cleanup failed: $mode" }
        $path = (Get-ItemProperty -LiteralPath ('HKCU:\' + $environmentKey)).Path
        $pathRetained = $integrationsRetained -or $mode -eq 'owned-retained'
        if ($mode -notin @('registration-error', 'save-report') -and ($path.Contains($commandDirectory) -ne $pathRetained -or -not $path.Contains('C:\Windows'))) { throw "PATH cleanup failed: $mode" }
        if ($mode -eq 'owned-retained' -and $path -ne ($commandDirectory + ';C:\Windows')) { throw 'Owned cleanup removed a pre-existing manual PATH entry' }
        if ((Test-Path -LiteralPath ('HKCU:\' + $protocolKey)) -ne ($foreign -or $mode -eq 'upgrade')) { throw "Protocol cleanup failed: $mode" }
        if ($missingLocation -and ((Test-Path -LiteralPath $desktopLink) -or (Test-Path -LiteralPath $startLink) -or (Test-Path -LiteralPath $arpKey))) { throw 'Missing location left an A shortcut or uninstall entry' }
        Write-Output "passed: $mode"
    }
    # Real replacement publishes B after the old A uninstaller has been retained.
    $setup = Start-Process $Installer -ArgumentList ('/S /D=' + $installPath) -PassThru -WindowStyle Hidden
    Wait-InstallerProcess $setup
    $setup.Dispose(); $setup = $null
    Copy-Item -LiteralPath (Join-Path $installPath ('Uninstall ' + $ProductName + '.exe')) -Destination $uninstaller -Force
    $oldCommand = Join-Path $installPath 'resources\runtime\cli\bin'
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($ownerKey)
    try { $key.SetValue('Directory', $oldCommand); $key.SetValue('RetainedEntries', 0) } finally { $key.Dispose() }
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($environmentKey)
    try { $key.SetValue('Path', $oldCommand + ';C:\Windows') } finally { $key.Dispose() }
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($protocolKey + '\shell\open\command')
    try { $key.SetValue('', '"' + (Join-Path $installPath ($ProductName + '.exe')) + '" "%1"') } finally { $key.Dispose() }
    New-Item -ItemType Directory -Force -Path $userDataPath | Out-Null
    $relocationData = Join-Path $userDataPath 'relocation-state.txt'
    [IO.File]::WriteAllText($relocationData, 'retained during relocation')
    $newPath = Join-Path $OutputDirectory 'Replacement App'
    $env:DSH_HOME = $homePath.Replace('\', '/')
    $setup = Start-Process $Installer -ArgumentList ('/S /D=' + $newPath) -PassThru -WindowStyle Hidden
    Wait-InstallerProcess $setup
    $setup.Dispose(); $setup = $null
    if ((Get-ItemProperty ('HKCU:\' + $ownerKey)).Directory) { throw 'Relocation retained old command owner' }
    if ((Get-ItemProperty ('HKCU:\' + $environmentKey)).Path -ne 'C:\Windows') { throw 'Relocation retained old command PATH' }
    if (Test-Path -LiteralPath ('HKCU:\' + $protocolKey)) { throw 'Relocation retained old protocol' }
    if ([IO.File]::ReadAllText($relocationData) -ne 'retained during relocation') { throw 'Relocation removed user data' }
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
    New-Item -ItemType Directory -Force -Path $userDataPath | Out-Null
    $replacementData = Join-Path $userDataPath 'replacement-state.txt'
    [IO.File]::WriteAllText($replacementData, 'replacement installation data')
    $replacementLinks = @{}
    foreach ($folder in @([Environment]::GetFolderPath('DesktopDirectory'), [Environment]::GetFolderPath('Programs'))) {
        $link = Join-Path $folder ($ProductName + '.lnk')
        if (Test-Path -LiteralPath $link) { $replacementLinks[$link] = [Convert]::ToBase64String([IO.File]::ReadAllBytes($link)) }
    }
    # Keep B's uninstall entry and protocol while the desktop shortcut and CLI still belong to A.
    $replacementLinks.Remove($desktopLink)
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($desktopLink)
    $shortcut.TargetPath = Join-Path $installPath ($ProductName + '.exe')
    $shortcut.Save()
    Set-ItemProperty ('HKCU:\' + $ownerKey) Directory $oldCommand
    Set-ItemProperty ('HKCU:\' + $environmentKey) Path ($oldCommand + ';C:\Windows')
    $bUninstall = $entry.UninstallString
    New-Item -ItemType Directory -Force -Path $installPath | Out-Null
    Get-ChildItem -LiteralPath $newPath | Copy-Item -Destination $installPath -Recurse
    if (-not (Test-Path -LiteralPath (Join-Path $installPath ($ProductName + '.exe')))) { throw 'Partial takeover fixture lacks the A executable' }
    $process = Start-Process $uninstaller -ArgumentList ('/S /currentuser _?=' + $installPath) -PassThru -WindowStyle Hidden
    if (-not $process.WaitForExit(30000) -or $process.ExitCode -ne 2) { throw 'Existing stale directory was not rejected' }
    $report = Get-Content (Join-Path $env:TEMP ('DeepSeek-Harness-uninstall-' + $process.Id + '.txt')) -Raw
    if (-not $report.Contains('Removal not confirmed') -or -not $report.Contains($newPath) -or -not $report.Contains($installPath)) { throw 'Silent rejection report lacks reason and both paths' }
    $process.Dispose(); $process = $null
    $process = Start-Process $uninstaller -ArgumentList ('/currentuser _?=' + $installPath) -PassThru
    $welcome = Wait-Text $copy.welcome
    $window = [InstallerCapture]::TopLevel($welcome)
    [InstallerCapture]::Click([InstallerCapture]::GetDlgItem($window, 1))
    $continue = Wait-Text $strings.INSTALLER_UNINSTALL_CONTINUE
    # TaskDialog common buttons are nested DirectUI controls; use TDM_CLICK_BUTTON with IDCANCEL.
    if (-not [InstallerCapture]::PostMessage([InstallerCapture]::TopLevel($continue), 0x466, [IntPtr]2, [IntPtr]::Zero)) { throw 'Could not cancel owner dialog' }
    if (-not $process.WaitForExit(30000) -or $process.ExitCode -ne 2) { throw 'Owner dialog cancellation did not stop uninstall' }
    $report = Get-Content (Join-Path $env:TEMP ('DeepSeek-Harness-uninstall-' + $process.Id + '.txt')) -Raw
    if (-not $report.Contains('Removal not confirmed') -or -not $report.Contains($newPath) -or -not $report.Contains($installPath)) { throw 'Cancellation report lacks reason and both paths' }
    if (-not (Test-Path -LiteralPath (Join-Path $installPath ($ProductName + '.exe')))) { throw 'Cancellation deleted A' }
    $process.Dispose(); $process = $null
    $process = Start-Process $uninstaller -ArgumentList ('/currentuser _?=' + $installPath) -PassThru
    $welcome = Wait-Text $copy.welcome
    $window = [InstallerCapture]::TopLevel($welcome)
    [InstallerCapture]::Click([InstallerCapture]::GetDlgItem($window, 1))
    $continue = Wait-Text $strings.INSTALLER_UNINSTALL_CONTINUE
    [void][InstallerCapture]::SaveNative([InstallerCapture]::TopLevel($continue), (Join-Path $OutputDirectory 'uninstall-directory-only.png'), $false)
    [InstallerCapture]::Click($continue)
    [void](Wait-Text $copy.finished)
    [InstallerCapture]::Click([InstallerCapture]::GetDlgItem($window, 1))
    Wait-Exit
    if (-not (Test-Path -LiteralPath (Join-Path $newPath ($ProductName + '.exe')))) { throw 'Directory-only removal deleted B' }
    $entry = Get-ItemProperty ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $RegistryKey)
    if ($entry.InstallLocation.TrimEnd('\') -ne $newPath) { throw 'Directory-only removal deleted B registration' }
    if ((Get-ItemProperty ('HKCU:\' + $environmentKey)).Path -ne 'C:\Windows') { throw 'A PATH entry survived partial takeover' }
    if ((Get-Item ('HKCU:\' + $protocolKey + '\shell\open\command')).GetValue('') -ne $newProtocol) { throw 'Directory-only removal changed B protocol' }
    if ([IO.File]::ReadAllText($replacementData) -ne 'replacement installation data') { throw 'Directory-only removal changed shared user data' }
    foreach ($link in $replacementLinks.Keys) {
        if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($link)) -ne $replacementLinks[$link]) { throw 'Directory-only removal changed replacement shortcut' }
    }
    if ((Get-ItemProperty ('HKCU:\' + $ownerKey)).Directory -or (Test-Path -LiteralPath $desktopLink)) { throw 'A owner or shortcut survived partial takeover' }
    if ($entry.UninstallString -ne $bUninstall -or $bUninstall -notmatch '^"([^"]+)" (/currentuser)$') { throw 'B uninstall command changed' }
    $registeredExe = $Matches[1]
    $registeredArgs = $Matches[2]
    $installPath = $newPath
    if ($registeredExe -ne (Join-Path $newPath ('Uninstall ' + $ProductName + '.exe'))) { throw 'B uninstall entry targets another installation' }
    $process = Start-Process $registeredExe -ArgumentList ($registeredArgs + ' /S') -PassThru -WindowStyle Hidden
    Wait-Exit
    foreach ($key in @($arpKey, ('HKCU:\Software\' + $RegistryKey), ('HKCU:\' + $protocolKey))) {
        if (Test-Path -LiteralPath $key) { throw "B uninstall retained registration: $key" }
    }
    foreach ($link in $replacementLinks.Keys) {
        if (Test-Path -LiteralPath $link) { throw "B uninstall retained shortcut: $link" }
    }
    Write-Output 'passed: installation takeover'
} finally {
    if ($held) { $held.Dispose() }
    if ($setup) { Stop-InstallerProcess $setup; $setup.Dispose() }
    if ($process) { Stop-InstallerProcess $process; $process.Dispose() }
    if ($ProductName -ne ('Harness Installer Test ' + ([Guid]$RegistryKey).ToString('N').Substring(0, 8))) { throw 'Unexpected fixture identity' }
    foreach ($key in @("Software\DSHUninstallTests\$RegistryKey", $protocolKey, "Software\$RegistryKey", "Software\Microsoft\Windows\CurrentVersion\Uninstall\$RegistryKey")) {
        [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($key, $false)
    }
    foreach ($folder in @('DesktopDirectory', 'Programs')) {
        $link = Join-Path ([Environment]::GetFolderPath($folder)) ($ProductName + '.lnk')
        if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link -Force }
    }
    [Environment]::SetEnvironmentVariable('DSH_HOME', $originalHome, 'Process')
    # Only unique test identities below known application-data parents are removed.
    foreach ($pair in @(@($productDataPath, $roaming), @($scopePath, $roaming), @($cachePath, $local))) {
        $target = [IO.Path]::GetFullPath($pair[0])
        if ([IO.Path]::GetDirectoryName($target) -ne $pair[1] -or -not ([IO.Path]::GetFileName($target).StartsWith('Harness Installer Test ') -or [IO.Path]::GetFileName($target).StartsWith('@harness-installer-test'))) { throw 'Unexpected fixture cleanup path' }
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    }
}
