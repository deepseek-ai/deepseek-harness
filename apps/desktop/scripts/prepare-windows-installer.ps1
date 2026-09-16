<# Compile the x86 DWM helper and raster assets embedded in the NSIS installer. #>
[CmdletBinding()]
param([string]$OutputDirectory, [switch]$TestProgress, [switch]$CompileProgressOnly)
$ErrorActionPreference = 'Stop'
$installerRoot = Join-Path $PSScriptRoot '../installer'
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $PSScriptRoot '../.desktop-build/targets/win-x64/installer-ui' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force $output | Out-Null
$source = Join-Path $installerRoot 'window-frame.cpp'
$library = Join-Path $output 'window-frame.dll'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Windows installer preparation requires Visual Studio C++ Build Tools and a Windows SDK.' }
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $visualStudio) { throw 'Visual Studio C++ Build Tools are missing.' }
$vcvars = Join-Path $visualStudio 'VC/Auxiliary/Build/vcvars32.bat'
$compileScript = Join-Path $output 'compile-frame.cmd'
$compileLines = @('@echo off', ('call "{0}" >nul' -f $vcvars), 'if errorlevel 1 exit /b %errorlevel%', ('cl /nologo /LD /MT /O1 /W4 /WX /EHsc "{0}" /Fo"{1}" /link /OUT:"{2}" /IMPLIB:"{3}" user32.lib comctl32.lib dwmapi.lib gdiplus.lib ole32.lib shell32.lib uuid.lib' -f $source, (Join-Path $output 'window-frame.obj'), $library, (Join-Path $output 'window-frame.lib')))
[IO.File]::WriteAllLines($compileScript, $compileLines, [Text.Encoding]::Default)
& $env:ComSpec /d /c $compileScript
if ($LASTEXITCODE -ne 0) { throw 'Native installer helper compilation failed.' }
if ($TestProgress -or $CompileProgressOnly) {
    $testSource = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../tests/windows-installer-progress.cpp'))
    $testExecutable = Join-Path $output 'progress-test.exe'
    $testScript = Join-Path $output 'compile-progress-test.cmd'
    [IO.File]::WriteAllLines($testScript, @('@echo off', ('call "{0}" >nul' -f $vcvars), 'if errorlevel 1 exit /b %errorlevel%', ('cl /nologo /MT /W4 /WX /EHsc "{0}" /Fo"{1}" /Fe"{2}"' -f $testSource, (Join-Path $output 'progress-test.obj'), $testExecutable)), [Text.Encoding]::Default)
    & $env:ComSpec /d /c $testScript
    if ($LASTEXITCODE -ne 0) { throw 'Progress test compilation failed.' }
    if ($TestProgress) {
        & $testExecutable
        if ($LASTEXITCODE -ne 0) { throw 'Progress timeline regression failed.' }
    }
}
Add-Type -AssemblyName System.Drawing
foreach ($asset in @('brand', 'brand-2x', 'brand-dark', 'brand-dark-2x', 'uninstaller-sidebar')) {
    $image = [Drawing.Image]::FromFile((Join-Path $installerRoot "assets/$asset.png"))
    try {
        $bitmap = [Drawing.Bitmap]::new($image.Width, $image.Height, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
        try {
            $graphics = [Drawing.Graphics]::FromImage($bitmap)
            try {
                $background = if ($asset -like '*dark*') { [Drawing.Color]::FromArgb(21, 21, 23) } else { [Drawing.Color]::White }
                $graphics.Clear($background)
                $graphics.DrawImage($image, 0, 0, $image.Width, $image.Height)
            } finally { $graphics.Dispose() }
            $bitmap.Save((Join-Path $output "$asset.bmp"), [Drawing.Imaging.ImageFormat]::Bmp)
        } finally { $bitmap.Dispose() }
    } finally { $image.Dispose() }
}
Write-Output "Prepared native installer resources: $output"
