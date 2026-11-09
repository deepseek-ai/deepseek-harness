# Inspect real Task Scheduler definitions without registering tasks, passwords, GitHub or signing hardware.
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Requires PowerShell 7 on Windows.' }
. (Join-Path $PSScriptRoot '../scripts/windows-runner-scheduler.ps1')
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$root = Join-Path ([IO.Path]::GetTempPath()) ('dsh-boot-definition-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $root
try {
$runner = Join-Path $root 'runner with spaces'
$null = New-Item -ItemType Directory -Path $runner
Set-Content -LiteralPath (Join-Path $runner '.runner') -Value '{}'
$pwsh = Join-Path $PSHOME 'pwsh.exe'
foreach ($minutes in @(1, 7, 1440)) {
    $definition = New-WindowsRunnerTaskDefinition $scheduler $sid $runner $pwsh $minutes 'Boot'
    [xml]$xml = $definition.XmlText
    $ns = [Xml.XmlNamespaceManager]::new($xml.NameTable)
    $ns.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    function Read-Value([string]$Path) { return $xml.SelectSingleNode('/t:Task/' + $Path, $ns).InnerText }
    if ((Read-Value 't:Principals/t:Principal/t:UserId') -ne $sid -or
        (Read-Value 't:Principals/t:Principal/t:LogonType') -ne 'Password' -or
        (Read-Value 't:Principals/t:Principal/t:RunLevel') -ne 'LeastPrivilege') { throw 'Boot account or logon configuration differs.' }
    if ($xml.SelectNodes('/t:Task/t:Triggers/t:BootTrigger', $ns).Count -ne 1 -or
        $xml.SelectNodes('/t:Task/t:Triggers/t:LogonTrigger', $ns).Count -ne 0 -or
        (Read-Value 't:Triggers/t:TimeTrigger/t:Repetition/t:Interval') -ne "PT${minutes}M") { throw 'Boot or recovery trigger differs.' }
    if ((Read-Value 't:Settings/t:Priority') -ne '4' -or
        (Read-Value 't:Settings/t:Enabled') -ne 'false' -or
        (Read-Value 't:Settings/t:MultipleInstancesPolicy') -ne 'IgnoreNew' -or
        (Read-Value 't:Settings/t:ExecutionTimeLimit') -ne 'PT0S' -or
        (Read-Value 't:Settings/t:DisallowStartIfOnBatteries') -ne 'false' -or
        (Read-Value 't:Settings/t:StopIfGoingOnBatteries') -ne 'false') { throw 'Boot task lifetime settings differ.' }
    if ((Read-Value 't:Actions/t:Exec/t:Command') -ne (Join-Path $runner 'dsh-task/launcher.exe') -or
        (Read-Value 't:Actions/t:Exec/t:Arguments') -ne ('"' + $pwsh + '"') -or
        (Read-Value 't:Actions/t:Exec/t:WorkingDirectory') -ne $runner) { throw 'Boot task bypasses the existing launcher.' }
    # Round-trip through the scheduler's parser, without storing or enabling a task.
    $parsed = $scheduler.NewTask(0)
    $parsed.XmlText = $definition.XmlText
    $parsedSid = ([Security.Principal.NTAccount]::new($parsed.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value
    if ($parsedSid -ne $sid -or $parsed.Settings.Enabled) { throw 'Definition did not round-trip.' }
}
$interactive = New-WindowsRunnerTaskDefinition $scheduler $sid $runner $pwsh 1
[xml]$interactiveXml = $interactive.XmlText
$interactiveNs = [Xml.XmlNamespaceManager]::new($interactiveXml.NameTable)
$interactiveNs.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
if ($interactive.Principal.LogonType -ne 3 -or $interactive.Principal.RunLevel -ne 0 -or $interactive.Settings.Priority -ne 4 -or $interactive.Settings.Enabled -or $interactiveXml.SelectNodes('/t:Task/t:Triggers/t:LogonTrigger/t:UserId', $interactiveNs).Count -ne 1 -or $interactiveXml.SelectSingleNode('/t:Task/t:Triggers/t:LogonTrigger/t:UserId', $interactiveNs).InnerText -ne $sid -or $interactiveXml.SelectNodes('/t:Task/t:Triggers/t:BootTrigger', $interactiveNs).Count -ne 0) { throw 'Interactive task defaults changed.' }
if (Get-WindowsRunnerTask $scheduler ('DSH-absent-' + [guid]::NewGuid().ToString('N'))) { throw 'Missing task lookup returned a task.' }
$deniedFolder = [pscustomobject]@{}
$deniedFolder | Add-Member ScriptMethod GetTask { param($Name); throw [Runtime.InteropServices.COMException]::new('Injected scheduler access denied', -2147024891) }
$deniedScheduler = [pscustomobject]@{ Folder=$deniedFolder }
$deniedScheduler | Add-Member ScriptMethod GetFolder { param($Path); return $this.Folder }
$denied = $false
try { $null = Get-WindowsRunnerTask $deniedScheduler 'fixture' } catch { $denied = $true }
if (-not $denied) { throw 'Denied task lookup was treated as a missing task.' }
$manager = Join-Path $PSScriptRoot '../scripts/windows-runner-task.ps1'
function Reject-Options([string[]]$Options, [string]$Message) {
    $output = & $pwsh -NoProfile -NonInteractive -File $manager -RunnerRoot $runner @Options 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0 -or -not $output.Contains($Message)) { throw "Expected rejection: $Message`n$output" }
    if (Test-Path -LiteralPath (Join-Path $runner 'dsh-task')) { throw 'Rejected options wrote a startup snapshot.' }
}
Reject-Options @('-Action','register-boot') 'requires -RunAs'
Reject-Options @('-Action','install','-StartupMode','Boot','-RunAs','NT AUTHORITY\SYSTEM') 'RunAs applies only to register-boot'
Reject-Options @('-Action','install','-RunAs','unused') 'RunAs applies only to register-boot'
Reject-Options @('-Action','start','-StartupMode','Boot') 'apply only to install'
$processProbe = Join-Path $root 'process-probe.ps1'
@'
param([string]$Manager, [string]$Runner, [switch]$Unreadable, [switch]$ThrowPath)
$ErrorActionPreference = 'Stop'
function Get-Process {
    param($Name,$ErrorAction)
    if ($ThrowPath) {
        $process = [pscustomobject]@{ ProcessName = 'Runner.Worker' }
        $process | Add-Member ScriptProperty Path { throw [ComponentModel.Win32Exception]::new(5) }
        return $process
    }
    [pscustomobject]@{ ProcessName = 'Runner.Worker'; Path = if ($Unreadable) { $null } else { Join-Path $Runner 'bin/Runner.Worker.exe' } }
}
& $Manager -Action install -RunnerRoot $Runner
'@ | Set-Content -LiteralPath $processProbe
foreach ($mode in @('readable','missing','throwing')) {
    $probeOptions = switch ($mode) { 'missing' { @('-Unreadable') }; 'throwing' { @('-ThrowPath') }; default { @() } }
    $output = & $pwsh -NoProfile -NonInteractive -File $processProbe -Manager $manager -Runner $runner @probeOptions 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0 -or -not $output.Contains('A runner process is active or its location is unreadable')) { throw "Live-process installation guard failed: $output" }
    if (Test-Path -LiteralPath (Join-Path $runner 'dsh-task')) { throw 'Live-process rejection wrote a startup snapshot.' }
}
Set-Content -LiteralPath (Join-Path $runner '.service') -Value 'fixture'
Reject-Options @('-Action','install','-ConfigRoot',$root) 'native runner service is configured'

Remove-Item -LiteralPath (Join-Path $runner '.service')

# Exercise preparation with isolated toolchain/network and process-inventory fixtures.
$fixture = Join-Path $root 'scripts'
$null = New-Item -ItemType Directory -Path $fixture
foreach ($name in @('windows-runner-task.ps1','windows-runner-scheduler.ps1','run-windows-runner-task.ps1','windows-runner-launcher.cs','windows-runner-network.ps1','run-windows-runner-network-process.ps1')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "../scripts/$name") -Destination $fixture
}
Set-Content -LiteralPath (Join-Path $fixture 'start-windows-packaging-runner.ps1') -Value 'param($RunnerRoot,$ConfigRoot,[switch]$CheckOnly); if (-not $CheckOnly) { throw "Unexpected runner launch" }; exit 0'
$prepareProbe = Join-Path $root 'prepare-probe.ps1'
@'
param($Manager,$Runner,$ConfigRoot)
$ErrorActionPreference = 'Stop'
function Get-Process { param($Name,$ErrorAction); return @() }
& $Manager -Action install -StartupMode Boot -RunnerRoot $Runner -ConfigRoot $ConfigRoot -RestartMinutes 7 -RestartCount 3
'@ | Set-Content -LiteralPath $prepareProbe
& $pwsh -NoProfile -NonInteractive -File $prepareProbe -Manager (Join-Path $fixture 'windows-runner-task.ps1') -Runner $runner -ConfigRoot $root
if ($LASTEXITCODE -ne 0) { throw 'Boot preparation failed.' }
$configFile = Join-Path $runner 'dsh-task/config.json'
$config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
if ($config.StartupMode -ne 'Boot' -or $config.AccountSid -ne $sid -or $config.RestartMinutes -ne 7 -or $config.RestartCount -ne 3) { throw 'Preparation lost account or recovery settings.' }
if (Get-WindowsRunnerTask $scheduler $config.TaskName) { throw 'Preparation registered a task.' }
Assert-WindowsRunnerBootConfiguration $config $sid $runner $config.TaskName
$expectedTaskName = $config.TaskName
foreach ($field in @('StartupMode','AccountSid','RunnerRoot','TaskName','PowerShell','RestartMinutes')) {
    $saved = $config.$field
    try {
        foreach ($invalid in @($null, 'invalid')) {
            $config.$field = $invalid
            $failure = $null
            try { Assert-WindowsRunnerBootConfiguration $config $sid $runner $expectedTaskName } catch { $failure = $_ }
            if (-not $failure) { throw "Invalid $field was accepted." }
        }
    } finally { $config.$field = $saved }
}
foreach ($invalid in @(0, 1441, 1.5, '7')) {
    $config.RestartMinutes = $invalid
    $failure = $null
    try { Assert-WindowsRunnerBootConfiguration $config $sid $runner $config.TaskName } catch { $failure = $_ }
    if (-not $failure) { throw 'Invalid restart interval was accepted.' }
}
$config.RestartMinutes = 7
$registrationProbe = Join-Path $root 'register-probe.ps1'
@'
param($Manager,$Runner,$RunAs,$Result)
$ErrorActionPreference = 'Stop'
function Get-Process { param($Name,$ErrorAction); return @() }
$nativeScheduler = New-Object -ComObject 'Schedule.Service'
$nativeScheduler.Connect()
$folder = [pscustomobject]@{}
$folder | Add-Member ScriptMethod GetTask { param($Name); return $null }
$folder | Add-Member ScriptMethod RegisterTaskDefinition {
    param($Name,$Definition,$Flags,$User,$Password,$Logon,$Sddl)
    if ($Password -ne 'fake-only-never-authenticated' -or $Flags -ne 2 -or $Logon -ne 1) { throw 'Invalid registration transport.' }
    @{ Name=$Name; User=$User; Sddl=$Sddl; Xml=$Definition.XmlText } | ConvertTo-Json | Set-Content -LiteralPath $Result
}
$fake = [pscustomobject]@{ Native=$nativeScheduler; Folder=$folder }
$fake | Add-Member ScriptMethod Connect {}
$fake | Add-Member ScriptMethod NewTask { param($Flags); return $this.Native.NewTask($Flags) }
$fake | Add-Member ScriptMethod GetFolder { param($Path); return $this.Folder }
function New-Object { param($ComObject); if ($ComObject -ne 'Schedule.Service') { throw 'Unexpected COM object.' }; return $fake }
function Get-Credential { param($UserName,$Message); return [Management.Automation.PSCredential]::new($UserName,(ConvertTo-SecureString 'fake-only-never-authenticated' -AsPlainText -Force)) }
& $Manager -Action register-boot -RunnerRoot $Runner -RunAs $RunAs
'@ | Set-Content -LiteralPath $registrationProbe
$registrationResult = Join-Path $root 'registration.json'
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$elevated = ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$registrationOutput = & $pwsh -NoProfile -NonInteractive -File $registrationProbe -Manager (Join-Path $fixture 'windows-runner-task.ps1') -Runner $runner -RunAs $account -Result $registrationResult 2>&1 | Out-String
if ($elevated -and -not $sid.EndsWith('-500')) {
    if ($LASTEXITCODE -ne 0) { throw "Boot registration entry failed: $registrationOutput" }
    $submitted = Get-Content -LiteralPath $registrationResult -Raw | ConvertFrom-Json
    if ($submitted.User -ne $account -or $submitted.Name -ne $config.TaskName -or $submitted.Sddl -notlike "*(A;;GA;;;$sid)*") { throw 'Registration lost prepared account or management access.' }
} else {
    Write-Output 'SKIP: elevated registration entry with substitute transport; unsupported installer context. Real cross-account registration is not tested.'
    if ($LASTEXITCODE -eq 0 -or (Test-Path -LiteralPath $registrationResult)) { throw 'Boot registration accepted an unsupported installer context.' }
}
if (Get-WindowsRunnerTask $scheduler $config.TaskName) { throw 'Isolated registration created a real task.' }
# Exercise management against a registered-task substitute, without CIM or real scheduler mutation.
$managementProbe = Join-Path $root 'manage-probe.ps1'
@'
param($Manager,$Runner,$Operation,$Result)
$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path $Manager) 'windows-runner-scheduler.ps1')
$native = New-Object -ComObject 'Schedule.Service'
$native.Connect()
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$definition = New-WindowsRunnerTaskDefinition $native $sid $Runner (Join-Path $PSHOME 'pwsh.exe') 1 'Boot'
$script:enabled = $Operation -ne 'uninstall'
$task = [pscustomobject]@{ Definition=$definition; State=$(if ($script:enabled) { 3 } else { 1 }); LastRunTime=[DateTime]::MinValue; LastTaskResult=0 }
$task | Add-Member ScriptProperty Enabled { return $script:enabled } {
    param($Value)
    $script:enabled = $Value
    Add-Content -LiteralPath $Result -Value "enabled=$Value"
    if (-not $Value -and $this.State -ne 4) { $this.State = 1 }
}
$task | Add-Member ScriptMethod Run { param($Parameters); Add-Content -LiteralPath $Result -Value 'run'; $this.State=4 }
$task | Add-Member ScriptMethod Stop { param($Flags); Add-Content -LiteralPath $Result -Value 'stop'; $this.State=1 }
$folder = [pscustomobject]@{ Task=$task }
$folder | Add-Member ScriptMethod GetTask { param($Name); return $this.Task }
$folder | Add-Member ScriptMethod DeleteTask { param($Name,$Flags); Add-Content -LiteralPath $Result -Value 'delete' }
$fake = [pscustomobject]@{ Folder=$folder }
$fake | Add-Member ScriptMethod Connect {}
$fake | Add-Member ScriptMethod GetFolder { param($Path); return $this.Folder }
function New-Object { param($ComObject); if ($ComObject -ne 'Schedule.Service') { throw 'Unexpected COM object.' }; return $fake }
function Get-Process { param($Name,$ErrorAction); return @() }
$status = & $Manager -Action $Operation -RunnerRoot $Runner
if ($Operation -eq 'status') { $status | ConvertTo-Json | Set-Content -LiteralPath $Result }
'@ | Set-Content -LiteralPath $managementProbe
foreach ($operation in @('status','start','stop','uninstall')) {
    $resultFile = Join-Path $root "manage-$operation.txt"
    & $pwsh -NoProfile -NonInteractive -File $managementProbe -Manager (Join-Path $fixture 'windows-runner-task.ps1') -Runner $runner -Operation $operation -Result $resultFile
    if ($LASTEXITCODE -ne 0) { throw "Management failed: $operation" }
    $result = Get-Content -LiteralPath $resultFile -Raw
    if ($operation -eq 'status') {
        $status = $result | ConvertFrom-Json
        if (-not $status.BootTrigger -or $status.LogonType -ne 'Password' -or $status.State -ne 'Ready' -or $status.RemainingLaunches -ne 4) { throw 'Status lost startup mode or recovery budget.' }
    } else {
        $expected = switch ($operation) { 'start' { "enabled=True`nrun" }; 'stop' { "enabled=False`nstop" }; 'uninstall' { 'delete' } }
        if ($result.Replace("`r`n","`n").Trim() -ne $expected) { throw "Unexpected management effects: $operation" }
    }
}
Remove-Item -LiteralPath (Join-Path $runner 'dsh-task/launcher.exe')
$failure = $null
try { Assert-WindowsRunnerBootConfiguration $config $sid $runner $config.TaskName } catch { $failure = $_ }
if (-not $failure) { throw 'Missing launcher was accepted.' }

# Only the credential dialog and registration transport are replaced; no account authentication occurs.
$script:credentialResult = $null
$script:credentialThrows = $false
$script:registrationCalls = 0
$script:registrationFails = $false
$script:registrationMismatch = $false
function Get-Credential { param($UserName, $Message); if ($script:credentialThrows) { throw 'Prompt unavailable' }; return $script:credentialResult }
$fakeFolder = [pscustomobject]@{}
$fakeFolder | Add-Member ScriptMethod RegisterTaskDefinition {
    param($Name, $Definition, $Flags, $User, $Password, $Logon, $Sddl)
    $script:registrationCalls++
    if ($Name -ne 'fixture' -or $Flags -ne 2 -or $User -ne 'fixture-user' -or $Logon -ne 1 -or $Sddl -ne "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;$sid)" -or $Password -ne 'fake-only-never-authenticated') {
        $script:registrationMismatch = $true; throw 'Unexpected registration request.'
    }
    if ($script:registrationFails) { throw [Runtime.InteropServices.COMException]::new('fake-only-never-authenticated', -2147023570) }
}
$fakeScheduler = [pscustomobject]@{ Folder = $fakeFolder }
$fakeScheduler | Add-Member ScriptMethod GetFolder { param($Path); if ($Path -ne '\') { throw 'Unexpected task folder.' }; return $this.Folder }
function Reject-Registration([string]$Message) {
    $failure = $null
    try { Register-WindowsRunnerBootTask $fakeScheduler 'fixture' $definition $sid 'fixture-user' } catch { $failure = $_ }
    if (-not $failure -or -not $failure.Exception.Message.Contains($Message) -or $failure.ToString().Contains('fake-only-never-authenticated')) {
        throw 'Registration failure was not contained or exposed the fake credential.'
    }
}
try {
    $script:credentialThrows = $true
    Reject-Registration 'Prompt unavailable'
    $script:credentialThrows = $false
    Reject-Registration 'Credential entry cancelled'
    $script:credentialResult = [Management.Automation.PSCredential]::new('other-user', (ConvertTo-SecureString 'fake-only-never-authenticated' -AsPlainText -Force))
    Reject-Registration 'Credential entry cancelled'
    $script:credentialResult = [Management.Automation.PSCredential]::new('fixture-user', [Security.SecureString]::new())
    Reject-Registration 'Credential entry cancelled'
    if ($script:registrationCalls -ne 0) { throw 'Invalid credential input reached registration.' }
    $script:credentialResult = [Management.Automation.PSCredential]::new('fixture-user', (ConvertTo-SecureString 'fake-only-never-authenticated' -AsPlainText -Force))
    Register-WindowsRunnerBootTask $fakeScheduler 'fixture' $definition $sid 'fixture-user'
    if ($script:registrationCalls -ne 1) { throw 'Registration was not submitted once.' }
    $script:registrationFails = $true
    Reject-Registration '0x8007052E'
    if ($script:registrationMismatch) { throw 'Unexpected registration request.' }
    if ($script:registrationCalls -ne 2) { throw 'Failed registration retried authentication.' }
} finally {
    Remove-Item Function:Get-Credential
    $script:credentialResult = $null
}
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force
}
Write-Output "PASS: boot/password/least-privilege definition, recovery settings, duplicate policy, launcher reuse, XML round-trip, invalid options, credential substitutes and single-attempt registration failure containment. No task registered."
exit 0
