# Prepare or inspect machine-owned Windows packaging directories without reading secret values.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Root,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
if ($Root -notmatch '^[A-Za-z]:[\\/]') { throw 'Root must be an absolute local drive directory' }
$rootPath = [IO.Path]::GetFullPath($Root)
$drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($rootPath))
if ($drive.DriveType -ne [IO.DriveType]::Fixed) { throw 'Packaging root requires a fixed local drive' }
for ($ancestor = [IO.DirectoryInfo]::new($rootPath); $null -ne $ancestor; $ancestor = $ancestor.Parent) {
    if ($ancestor.Exists -and ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Packaging root cannot contain linked directories' }
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed = @($identity.Value, 'S-1-5-18', 'S-1-5-32-544')
foreach ($relative in @('packaging', 'packaging/presets', 'packaging/secrets', 'packaging/certificates', 'cache', 'cache/windows-signatures')) {
    $path = Join-Path $rootPath $relative
    if (-not (Test-Path -LiteralPath $path)) {
        if ($CheckOnly) { throw "Missing directory: $path" }
        $null = New-Item -ItemType Directory -Path $path
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $acl.SetOwner($identity)
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($sid in $allowed) {
            $rule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
            $null = $acl.AddAccessRule($rule)
        }
        Set-Acl -LiteralPath $path -AclObject $acl
    }
    $item = Get-Item -LiteralPath $path
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Not a real directory: $path" }
    $acl = Get-Acl -LiteralPath $path
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $identity.Value) { throw "Directory must belong to current account: $path" }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed) { throw "Directory permits another account: $path" }
    }
}
if (-not $CheckOnly) {
    $templates = Join-Path $PSScriptRoot '../config/windows-packaging'
    foreach ($name in @('test', 'production')) {
        $destination = Join-Path $rootPath "packaging/presets/$name.env.example"
        if (-not (Test-Path -LiteralPath $destination)) { Copy-Item -LiteralPath (Join-Path $templates "$name.env.example") -Destination $destination }
    }
    $destination = Join-Path $rootPath 'packaging/secrets/windows-signing.env.example'
    if (-not (Test-Path -LiteralPath $destination)) { Copy-Item -LiteralPath (Join-Path $templates 'windows-signing.env.example') -Destination $destination }
}
Write-Output "Packaging directories verified. Configuration root: $(Join-Path $rootPath 'packaging')"
Write-Output 'Existing configuration, caches, runner registration and signing failure records were not overwritten.'
