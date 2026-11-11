# Compile and run a private capture experiment using only the installed .NET Framework.
param(
    [long]$WindowHandle = 0,
    [string]$OutputDirectory = (Join-Path $env:TEMP ("dsh-capture-" + [guid]::NewGuid().ToString("N")))
)
$ErrorActionPreference = "Stop"
$framework = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319"
$build = Join-Path $PSScriptRoot ("..\..\.probe-build-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $build | Out-Null
try {
    $executable = Join-Path $build "CaptureProbe.exe"
    $compilerArguments = @("/nologo", "/target:exe", "/platform:x64", "/out:$executable",
        ("/win32manifest:" + (Join-Path $PSScriptRoot "app.manifest")),
        "/r:System.Drawing.dll", "/r:System.Windows.Forms.dll", "/r:System.Web.Extensions.dll",
        "/r:$framework\WPF\UIAutomationClient.dll", "/r:$framework\WPF\UIAutomationTypes.dll",
        "/r:$framework\WPF\WindowsBase.dll", (Join-Path $PSScriptRoot "CaptureProbe.cs"))
    $compiler = Start-Process (Join-Path $framework "csc.exe") -NoNewWindow -Wait -PassThru `
        -ArgumentList ($compilerArguments | ForEach-Object { '"' + $_ + '"' })
    if ($compiler.ExitCode -ne 0) { throw "Capture probe compilation failed: $($compiler.ExitCode)" }
    Copy-Item (Join-Path $PSScriptRoot "CaptureProbe.exe.config") "$executable.config"
    $probeArguments = if ($WindowHandle -eq 0) { @("--demo", $OutputDirectory) }
        else { @("--compare", $WindowHandle, $OutputDirectory) }
    $probe = Start-Process $executable -NoNewWindow -Wait -PassThru `
        -ArgumentList ($probeArguments | ForEach-Object { '"' + $_ + '"' })
    if ($probe.ExitCode -ne 0) { throw "Capture probe failed; inspect $OutputDirectory" }
    Write-Output "Capture evidence: $OutputDirectory"
}
finally { Remove-Item -LiteralPath $build -Recurse -Force }
