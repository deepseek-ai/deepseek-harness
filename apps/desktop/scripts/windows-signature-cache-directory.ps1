# Validate account ownership before accessing cache contents; new caches receive a private DACL.
param([Parameter(Mandatory=$true)][string]$CachePath, [switch]$ExistingSource)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Import-Module "$PSHOME/Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$fullPath = [System.IO.Path]::GetFullPath($CachePath)
if ($fullPath -notmatch '^[A-Za-z]:\\' -or $CachePath -notmatch '^[A-Za-z]:[\\/]') { throw 'Signature cache requires an absolute local drive path' }
$drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($fullPath))
if ($drive.DriveType -ne [System.IO.DriveType]::Fixed) { throw 'Signature cache requires a fixed local drive' }
for ($ancestor = [System.IO.DirectoryInfo]::new($fullPath); $null -ne $ancestor; $ancestor = $ancestor.Parent) {
    if ($ancestor.Exists -and ($ancestor.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'Signature cache cannot use reparse points in its path'
    }
}
if ([System.IO.File]::Exists($fullPath)) { throw 'Signature cache path must be a directory' }
if (-not [System.IO.Directory]::Exists($fullPath)) {
    if ($ExistingSource) { throw 'Signature cache migration source does not exist' }
    $null = [System.IO.Directory]::CreateDirectory($fullPath)
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($currentSid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($currentSid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
        $identity = [System.Security.Principal.SecurityIdentifier]::new($sid)
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $fullPath -AclObject $acl
}
$acl = Get-Acl -LiteralPath $fullPath
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $currentSid.Value) {
    throw 'Signature cache directory must belong to the current Windows account'
}
if (-not $ExistingSource) {
    foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($currentSid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
            throw 'Signature cache permissions must exclude other ordinary Windows accounts'
        }
    }
}
