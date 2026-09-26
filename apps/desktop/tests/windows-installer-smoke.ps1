<# Native installation checks use a unique product identity and a private directory. #>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Installer, [Parameter(Mandatory)][string]$ProductName,
    [Parameter(Mandatory)][string]$RegistryKey,
    [Parameter(Mandatory)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-installer-ui.ps1')
[InstallerCapture]::Initialize()
[InstallerCapture]::ProductName = $ProductName
$installPath = Join-Path $OutputDirectory 'Installed App'
$appPath = Join-Path $installPath ($ProductName + '.exe')
$uninstaller = Join-Path $installPath ('Uninstall ' + $ProductName + '.exe')
$processes = [Collections.Generic.List[Diagnostics.Process]]::new()
$results = [Collections.Generic.List[string]]::new()
$expected = Get-Content (Join-Path $PSScriptRoot 'expected/windows-installer.json') -Raw | ConvertFrom-Json
$localizedCopy = @{ ENGLISH = @{}; SIMPCHINESE = @{} }
Get-Content (Join-Path $PSScriptRoot '../installer/strings.nsh') -Encoding UTF8 | ForEach-Object {
    if ($_ -match '^LangString (INSTALLER_\w+) \$\{LANG_(ENGLISH|SIMPCHINESE)\} "(.*)"$') {
        $localizedCopy[$Matches[2]][$Matches[1]] = $Matches[3]
    }
}
function Wait-Control([Diagnostics.Process]$Process, [string]$Text, [switch]$Dialog) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        if ($Process.HasExited) { throw "Process exited before '$Text': $($Process.ExitCode)" }
        $control = if ($Dialog) { [InstallerCapture]::FindDialogText($Process.Id, $Text) } else { [InstallerCapture]::FindText($Process.Id, $Text) }
        if ($control -ne [IntPtr]::Zero) { return $control }
        Start-Sleep -Milliseconds 25
    } while ($timer.Elapsed.TotalSeconds -lt 30)
    throw "Missing '$Text': $([InstallerCapture]::VisibleText($Process.Id))"
}
function Start-Setup([string]$Theme, [string]$Path = $installPath) {
    $arguments = '/THEME=' + $Theme
    if ($Path) { $arguments += ' /D=' + $Path }
    $process = Start-Process -FilePath $Installer -ArgumentList $arguments -PassThru -WindowStyle Normal
    $processes.Add($process)
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        if ($process.HasExited) { throw "Setup exited: $($process.ExitCode)" }
        if ([InstallerCapture]::HasIncompleteWindow($process.Id)) { throw 'Installer appeared before its page was ready' }
        $window = [InstallerCapture]::Find($process.Id)
        if ($window -ne [IntPtr]::Zero) { break }
        Start-Sleep -Milliseconds 5
    } while ($timer.Elapsed.TotalSeconds -lt 30)
    if ($window -eq [IntPtr]::Zero) { throw 'Installer welcome window did not appear' }
    $timer.Restart()
    while ([InstallerCapture]::GetProp($window, 'HarnessInstaller.Presented') -eq [IntPtr]::Zero) {
        if ($process.HasExited -or $timer.Elapsed.TotalSeconds -gt 10) { throw 'Installer welcome window was not presented' }
        Start-Sleep -Milliseconds 10
    }
    [InstallerCapture]::Reveal($window)
    $languages = @($localizedCopy.Keys | Where-Object {
        [InstallerCapture]::FindButton($process.Id, $localizedCopy[$_].INSTALLER_INSTALL) -ne [IntPtr]::Zero
    })
    if ($languages.Count -ne 1) { throw "Cannot identify installer language: $([InstallerCapture]::VisibleText($process.Id))" }
    $script:copy = $localizedCopy[$languages[0]]
    [void](Wait-Control $process $copy.INSTALLER_INSTALL)
    return $process
}
function Click-Control([Diagnostics.Process]$Process, [string]$Text) {
    [InstallerCapture]::Click((Wait-Control $Process $Text))
}
function Dismiss([Diagnostics.Process]$Process, [string]$Text) {
    $control = Wait-Control $Process $Text -Dialog
    $dialog = [InstallerCapture]::TopLevel($control)
    [InstallerCapture]::Click([InstallerCapture]::GetDlgItem($dialog, 2))
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ([InstallerCapture]::IsWindow($dialog)) {
        if ($timer.Elapsed.TotalSeconds -gt 10) { throw 'Dialog did not close' }
        Start-Sleep -Milliseconds 25
    }
}
function Finish-Setup([Diagnostics.Process]$Process, [bool]$Launch, [string]$Theme, [string]$Bounds) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $previous = 0
    $window = [InstallerCapture]::Find($Process.Id)
    while ([InstallerCapture]::FindButton($Process.Id, $copy.INSTALLER_FINISH) -eq [IntPtr]::Zero) {
        if ($Process.HasExited -or $timer.Elapsed.TotalSeconds -gt 30) { throw 'Installer did not complete' }
        $visible = [InstallerCapture]::VisibleText($Process.Id)
        if ($visible.Contains('msctls_progress32') -ne $expected.nativeProgressVisible) { throw 'Stock green progress bar is visible' }
        if ($visible -match 'HarnessInstallerProgress[^\r\n]*?(\d+)%') {
            $percent = [int]$Matches[1]
            if ($percent -lt $previous) { throw 'Installation progress went backwards' }
            if ($percent -eq 100 -and [InstallerCapture]::GetProp($window, 'HarnessInstaller.Succeeded') -eq [IntPtr]::Zero) { throw 'Installation showed 100% before success' }
            $previous = $percent
        }
        Start-Sleep -Milliseconds 25
    }
    if ([InstallerCapture]::GetProp($window, 'HarnessInstaller.CompletedPercent').ToInt32() -ne 100) { throw 'Finish page replaced an incomplete progress bar' }
    $checkbox = Wait-Control $Process $copy.INSTALLER_LAUNCH
    $state = [InstallerCapture]::SendMessage($checkbox, 0xF0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
    if ($state -ne $expected.launchCheckboxState) { throw 'Unexpected launch checkbox default' }
    if (-not $Launch) {
        [InstallerCapture]::Click($checkbox)
        $timer = [Diagnostics.Stopwatch]::StartNew()
        while ([InstallerCapture]::SendMessage($checkbox, 0xF0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32() -ne 0) {
            if ($timer.Elapsed.TotalSeconds -gt 5) { throw 'Checkbox did not toggle' }
            Start-Sleep -Milliseconds 25
        }
    }
    $window = [InstallerCapture]::Find($Process.Id)
    if ([InstallerCapture]::GetProp($window, 'HarnessInstaller.Stage').ToInt32() -ne 4) { throw 'Installation did not reach cleanup' }
    if ([InstallerCapture]::Bounds($window) -ne $Bounds) { throw 'Completion page moved or resized the installer' }
    [void][InstallerCapture]::Save($window, (Join-Path $OutputDirectory ($Theme + '-finish.png')))
    if ($Launch) {
        $hiddenApp = $appPath + '.hold'
        Move-Item -LiteralPath $appPath -Destination $hiddenApp
        try {
            Click-Control $Process $copy.INSTALLER_FINISH
            Dismiss $Process $copy.INSTALLER_LAUNCH_FAILED
            if (-not [InstallerCapture]::IsWindowVisible($window)) { throw 'Launch failure did not restore the finish page' }
        } finally {
            Move-Item -LiteralPath $hiddenApp -Destination $appPath
        }
        $finish = Wait-Control $Process $copy.INSTALLER_FINISH
        [void][InstallerCapture]::SendMessage($window, 0x28, $finish, [IntPtr]1)
        [void][InstallerCapture]::PostMessage($finish, 0x100, [IntPtr]13, [IntPtr]::Zero)
    } else {
        Click-Control $Process $copy.INSTALLER_FINISH
    }
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ([InstallerCapture]::IsWindowVisible($window)) {
        if ($timer.Elapsed.TotalSeconds -gt 2) { throw 'Finish did not dismiss the installer promptly' }
        Start-Sleep -Milliseconds 25
    }
    if (-not $Process.WaitForExit(10000) -or $Process.ExitCode -ne 0) { throw 'Finish did not exit successfully' }
}
function Run-Silent([string]$Arguments, [int]$Code) {
    $process = Start-Process -FilePath $Installer -ArgumentList $Arguments -PassThru -WindowStyle Hidden
    $processes.Add($process)
    if (-not $process.WaitForExit(60000)) { throw 'Silent setup did not exit' }
    if ($process.ExitCode -ne $Code) { throw "Silent setup returned $($process.ExitCode), expected $Code" }
}
try {
    $process = Start-Setup light
    $results.Add('welcome-presented-on-first-show')
    $window = [InstallerCapture]::Find($process.Id)
    [void][InstallerCapture]::Save($window, (Join-Path $OutputDirectory 'light-welcome.png'))
    Click-Control $process $copy.INSTALLER_CHOOSE_PATH
    $edit = Wait-Control $process $installPath
    [void][InstallerCapture]::Save($window, (Join-Path $OutputDirectory 'light-path.png'))
    Click-Control $process $copy.INSTALLER_BROWSE
    Dismiss $process $copy.INSTALLER_CHOOSE_PATH
    [void][InstallerCapture]::SendMessage($window, 0x28, $edit, [IntPtr]1)
    foreach ($invalidPath in @('C:\Windows\Harness Installer Test', [IO.Path]::GetPathRoot($installPath), ([IO.Path]::GetPathRoot($installPath) + '\'))) {
        [void][InstallerCapture]::SendMessage($edit, 0xC, [IntPtr]::Zero, $invalidPath)
        [void][InstallerCapture]::PostMessage($edit, 0x100, [IntPtr]13, [IntPtr]::Zero)
        Dismiss $process $copy.INSTALLER_PATH_INVALID
    }
    [void][InstallerCapture]::SendMessage($edit, 0xC, [IntPtr]::Zero, $installPath)
    [InstallerCapture]::MoveBy($window, 73, -41)
    $bounds = [InstallerCapture]::Bounds($window)
    Click-Control $process $copy.INSTALLER_INSTALL
    Finish-Setup $process $false light $bounds
    if (-not (Test-Path -LiteralPath $appPath) -or (Test-Path -LiteralPath (Join-Path $installPath 'launched.txt'))) { throw 'Unchecked launch behavior failed' }
    $results.Add('enter-validates-current-path-and-unchecked-launch')
    $results.Add('completion-preserves-window-position')
    $results.Add('welcome-ready-before-first-show')
    $results.Add('successful-install-paints-100-before-finish')

    $process = Start-Setup dark ''
    Click-Control $process $copy.INSTALLER_CHOOSE_PATH
    $edit = Wait-Control $process $installPath
    [void][InstallerCapture]::SendMessage($edit, 0xC, [IntPtr]::Zero, ($installPath + '\\'))
    [void][InstallerCapture]::Save([InstallerCapture]::Find($process.Id), (Join-Path $OutputDirectory 'dark-welcome.png'))
    $bounds = [InstallerCapture]::Bounds([InstallerCapture]::Find($process.Id))
    Click-Control $process $copy.INSTALLER_INSTALL
    Finish-Setup $process $true dark $bounds
    $registration = Get-ItemProperty ('HKCU:\Software\' + $RegistryKey)
    if ($registration.InstallLocation.TrimEnd('\') -ne $installPath -or -not (Test-Path -LiteralPath $appPath)) {
        throw 'Trailing separators changed the registered installation directory'
    }
    $results.Add('registered-directory-with-trailing-separators')
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        $app = Get-Process -Name $ProductName -ErrorAction SilentlyContinue
        if ($app) { break }
        Start-Sleep -Milliseconds 25
    } while ($timer.Elapsed.TotalSeconds -lt 15)
    if (-not $app -or $app.Path -ne $appPath) { throw 'Finish did not launch the installed test application' }
    $processes.Add($app)
    $results.Add('registered-directory-and-checked-launch')
    $results.Add('launch-failure-retry-and-prompt-dismissal')

    function Assert-RunningRejected([Diagnostics.Process]$Setup) {
        [void](Wait-Control $Setup $copy.INSTALLER_RUNNING -Dialog)
        $visible = [InstallerCapture]::VisibleText($Setup.Id)
        if ($visible.Contains('HarnessInstallerProgress')) { throw 'Running-app rejection started progress UI' }
        if (Get-ChildItem -LiteralPath $OutputDirectory -Directory -Filter 'Installed App.new-*') { throw 'Running-app rejection staged payload files' }
        Dismiss $Setup $copy.INSTALLER_RUNNING
        if (-not $Setup.WaitForExit(10000) -or $Setup.ExitCode -ne 2 -or $app.HasExited) { throw 'Running application was not preserved' }
    }
    $process = Start-Process -FilePath $Installer -ArgumentList ('/THEME=dark /D=' + $installPath) -PassThru -WindowStyle Hidden
    $processes.Add($process)
    Assert-RunningRejected $process
    $results.Add('running-app-rejected-before-welcome-and-extraction')
    Run-Silent ('/S /D=' + $installPath) 2
    if ($app.HasExited) { throw 'Silent rejection stopped the running application' }
    if (Get-ChildItem -LiteralPath $OutputDirectory -Directory -Filter 'Installed App.new-*') { throw 'Silent rejection staged payload files' }
    $results.Add('silent-running-app-rejected-before-extraction')
    Dismiss $app 'Installer test application is running.'
    if (-not $app.WaitForExit(10000)) { throw 'Test application did not exit' }

    $process = Start-Setup dark
    $app = Start-Process -FilePath $appPath -PassThru -WindowStyle Hidden
    $processes.Add($app)
    [void](Wait-Control $app 'Installer test application is running.' -Dialog)
    Click-Control $process $copy.INSTALLER_INSTALL
    Assert-RunningRejected $process
    Dismiss $app 'Installer test application is running.'
    if (-not $app.WaitForExit(10000)) { throw 'Test application did not exit' }
    $results.Add('app-started-on-welcome-rejected-before-extraction')

    $otherPath = Join-Path $OutputDirectory 'Other Installation'
    New-Item -ItemType Directory -Path $otherPath | Out-Null
    $otherApp = Join-Path $otherPath ($ProductName + '.exe')
    Copy-Item -LiteralPath $appPath -Destination $otherApp
    $otherProcess = Start-Process -FilePath $otherApp -PassThru -WindowStyle Hidden
    $processes.Add($otherProcess)
    [void](Wait-Control $otherProcess 'Installer test application is running.' -Dialog)
    Run-Silent '/S --updated' 0
    if ($otherProcess.HasExited) { throw 'Unrelated installation was stopped' }
    Dismiss $otherProcess 'Installer test application is running.'
    if (-not $otherProcess.WaitForExit(10000)) { throw 'Unrelated test application did not exit' }
    if (-not (Test-Path -LiteralPath $appPath)) { throw 'Silent update moved the registered installation' }
    $registration = Get-ItemProperty ('HKCU:\Software\' + $RegistryKey)
    if ($registration.InstallLocation.TrimEnd('\') -ne $installPath) { throw 'Silent update changed InstallLocation' }
    $results.Add('silent-update-retains-directory-and-ignores-unrelated-process')
    Run-Silent ('/S /allusers /D=' + $installPath) 2
    $foreign = Join-Path $OutputDirectory 'Foreign App'
    New-Item -ItemType Directory -Path $foreign | Out-Null
    Set-Content -LiteralPath (Join-Path $foreign 'keep.txt') -Value 'preserved'
    Run-Silent ('/S /D=' + $foreign) 2
    if ((Get-Content -LiteralPath (Join-Path $foreign 'keep.txt')) -ne 'preserved') { throw 'Foreign directory changed' }
    $results.Add('invalid-destination-rejection')
} catch {
    Write-Output "Installer check failed: $_"
    throw
} finally {
    foreach ($process in $processes) {
        if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
        $process.Dispose()
    }
    if (Test-Path -LiteralPath $uninstaller) {
        $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru -WindowStyle Hidden
        if (-not $uninstallProcess.WaitForExit(60000)) { $uninstallProcess.Kill(); $uninstallProcess.WaitForExit(); throw 'Test uninstaller timed out' }
        $timer = [Diagnostics.Stopwatch]::StartNew()
        while (Test-Path -LiteralPath $appPath) {
            if ($timer.Elapsed.TotalSeconds -gt 20) { throw 'Test installation was not removed' }
            Start-Sleep -Milliseconds 50
        }
        $uninstallProcess.Dispose()
    }
}
$results.Add('uninstall')
if (Compare-Object @($expected.cases) @($results)) { throw 'Installer results differ from expected behavior' }
$results | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'results.json') -Encoding UTF8
$results | ForEach-Object { Write-Output "PASS: $_" }
