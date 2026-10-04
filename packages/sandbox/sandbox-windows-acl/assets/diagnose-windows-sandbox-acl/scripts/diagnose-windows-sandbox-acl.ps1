<#
.SYNOPSIS
    Diagnose the DSH sandbox ACL failures on Windows and repair them in one run.

.DESCRIPTION
    A denial inside the DSH sandbox is worth diagnosing only when it contradicts
    what the active mode promises: writes inside the workspace, or reads that the
    signed-in user should plainly have. One invocation reads each requested path
    and every ancestor, then repairs what it can in the same run:

      * every directory on that chain inside -AllowRoot that lacks effective
        WRITE_DAC or WRITE_OWNER gets a FullControl allow ACE for the current
        user, so the sandbox can provision the grant it needs; and
      * every explicit AppContainer package allow ACE (S-1-15-2-*, excluding the
        well-known groups ending in 1 or 2) is removed at its source, ancestor
        first, which also removes that package's access to the tree.

    A directory the caller cannot provision is the state the sandbox reports on the
    workspace root, while the conflicting entry often sits deeper; the authorized root
    is examined for the same reason. For either case the same run also collects explicit
    package allow ACEs under the requested directory, so they do not need a second call.
    The walk is bounded, enters no reparse point or managed application tree, and reports
    truncation and unreadable directories instead of claiming a complete walk.

    Every observation, change, verification and recovery command is printed as it
    happens, so one run shows the caller the complete set of actions.

    -AllowRoot bounds every change: an object is modified only when it is that
    directory or strictly inside it, so a caller can repair its own workspace
    root. Reparse paths and managed application trees are refused. Each modified
    object is backed up first, with an independent recovery script, and every DACL
    write is verified by re-reading it. A failed repair restores all attempted
    DACL changes from this invocation in reverse order and stops.

    The script never creates, deletes, or writes the contents of any file. Its
    only writes are the recovery artifacts under -Out and the DACLs it repairs.

.PARAMETER Path
    One or more failing paths. Each is diagnosed and repaired together with its ancestors.

.PARAMETER AllowRoot
    Required. Every modified object must be this directory or strictly inside it.

.PARAMETER Out
    Required for a repair. Receives one recovery record and one recovery script
    per change, so an object repaired twice keeps both recovery points.

.PARAMETER Restore
    Restore the DACL recovery record for exactly one -Path instead of repairing.
    Requires -AllowRoot and WRITE_DAC, preserves owner and SACL.

.EXAMPLE
    pwsh -File diagnose-windows-sandbox-acl.ps1 -Path '<failing path>' -AllowRoot '<authorized directory>' -Out '<recovery directory>'

.EXAMPLE
    pwsh -File diagnose-windows-sandbox-acl.ps1 -Path '<failing path>' -AllowRoot '<authorized directory>' -Restore '<recovery record>'
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string[]]$Path,
  [string]$AllowRoot,
  [string]$Out,
  [string]$Restore
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# These two well-known groups name all packages, not one conflicting package.
$PACKAGE_SID = '^S-1-15-2-(?![12]$)'
$LOW_LABEL_SID = 'S-1-16-4096'
# Upper bound on the directories one subtree scan may visit, so a huge workspace
# cannot turn one approved repair into an unbounded walk. Truncation is reported.
$SCAN_LIMIT = 2000

function Write-Line { param([string]$Text) Write-Output $Text }

# Reports bypass the success pipeline so diagnostics cannot become a function's
# return value. Each JSON record occupies one stdout line, including paths/errors.
function Write-Report {
  param([string]$Kind, [string]$Operation, [string]$Target, [string]$Status, [string]$Reason, $Details = @{})
  $record = [ordered]@{ kind = $Kind; operation = $Operation; path = $Target; status = $Status; reason = $Reason; details = $Details }
  if ($Kind -eq 'observation' -and $Status -in @('unknown', 'unreadable', 'partial')) { $script:observationFailures++ }
  $script:reports.Add($record)
  $json = $record | ConvertTo-Json -Depth 12 -Compress
  # The complete record set also lands in the report file: tool output is truncated to its
  # tail, so a long run's early records survive only there.
  if ($null -ne $script:reportWriter) {
    try { $script:reportWriter.WriteLine($json); $script:reportWriter.Flush() }
    catch [System.IO.IOException] {
      # stdout keeps only its tail, so this file is the complete record: a write failure
      # has to reach the caller, on stderr, instead of leaving a silently incomplete file.
      [Console]::Error.WriteLine('REPORT_IO_FAILED {0}: {1}' -f $script:reportPath, $_.Exception.Message)
      try { $script:reportWriter.Dispose() } catch { }
      $script:reportWriter = $null
    }
  }
  [Console]::Out.WriteLine('REPORT ' + $json)
}
function Invoke-ReportedOperation {
  param([string]$Operation, [string]$Target, [string]$Reason, [string]$Effect, [scriptblock]$Action)
  $entry = [ordered]@{ id = $script:operations.Count + 1; operation = $Operation; path = $Target; effect = $Effect; status = 'started' }
  $script:operations.Add($entry)
  if ($Effect -eq 'acl' -and $Operation -ne 'restore_dacl' -and $script:recoveries.Count -gt 0) {
    $script:recoveries[-1].attempted = $true
  }
  Write-Report action $Operation $Target started $Reason @{ id = $entry.id; effect = $Effect }
  try {
    $result = & $Action
    $entry.status = 'completed'
    Write-Report action $Operation $Target completed $Reason @{ id = $entry.id; effect = $Effect }
    return $result
  } catch {
    $entry.status = 'failed'
    Write-Report action $Operation $Target failed $Reason @{
      id = $entry.id; effect = $Effect; error = (Get-HResultChain $_.Exception)
      state = $(if ($Effect -eq 'none') { 'No mutation requested by this operation.' } else { 'The operation may have partially changed state; completion is unconfirmed.' })
    }
    throw
  }
}

function Write-Decision {
  param([string]$Operation, [string]$Target, [string]$Status, [string]$Reason)
  Write-Report decision $Operation $Target $Status $Reason
}

# Unwrap nested exceptions: PowerShell wraps Win32 failures, and only the inner
# exception carries the real HRESULT the caller needs to classify the failure.
function Get-HResultChain {
  param([System.Exception]$Exception)
  $chain = @()
  $e = $Exception
  while ($null -ne $e) {
    $chain += ('{0}=0x{1:X8}/win32={2}: {3}' -f $e.GetType().Name, $e.HResult, ($e.HResult -band 0xFFFF), $e.Message)
    $e = $e.InnerException
  }
  return ($chain -join ' <- ')
}

function Get-CurrentIdentity {
  return [System.Security.Principal.WindowsIdentity]::GetCurrent()
}

# Integrity level affects the symptom: the same foreign
# ACE fails a grant when the caller is below Medium and merely blocks the child
# when the caller is not.
# The integrity level lives in the token's group list, which .NET filters out of
# WindowsIdentity.Groups, so read it through GetTokenInformation. Add-Type compiles
# in-process on PowerShell 7. Never spawn whoami.exe for this: inside a below-Medium
# token that process fails to initialize (STATUS_DLL_INIT_FAILED, 0xc0000142) and
# raises an application-error dialog on the user's desktop.
function Initialize-NativeApi {
    if (-not ('Dsh.TokenInfo' -as [type])) {
      Add-Type -Namespace Dsh -Name TokenInfo -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
[StructLayout(LayoutKind.Sequential)]
public struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }
[DllImport("advapi32.dll", SetLastError = true)]
public static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, uint length, out uint returned);
[DllImport("advapi32.dll", SetLastError = true)]
public static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
[DllImport("advapi32.dll", SetLastError = true)]
public static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
private static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFileW(
  string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
// OPEN_EXISTING never creates or changes contents. Windows evaluates the caller's
// effective access, including group attributes, denies, ownership and inheritance.
public static bool HasAccess(string path, uint access) {
  using (var handle = CreateFileW(path, access, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
    if (!handle.IsInvalid) { return true; }
    int error = Marshal.GetLastWin32Error();
    if (error == 5) { return false; }
    throw new System.ComponentModel.Win32Exception(error, "CreateFileW access check: " + path);
  }
}
[DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
private static extern uint SetNamedSecurityInfoW(string path, int type, uint information,
  IntPtr owner, IntPtr group, byte[] dacl, IntPtr sacl);
public static void SetDacl(string path, string sddl) {
  var descriptor = new System.Security.AccessControl.RawSecurityDescriptor(sddl);
  byte[] dacl = null;
  if (descriptor.DiscretionaryAcl != null) {
    dacl = new byte[descriptor.DiscretionaryAcl.BinaryLength];
    descriptor.DiscretionaryAcl.GetBinaryForm(dacl, 0);
  }
  bool isProtected = (descriptor.ControlFlags & System.Security.AccessControl.ControlFlags.DiscretionaryAclProtected) != 0;
  // Only the DACL and its inheritance protection are written: never owner, group or SACL.
  uint result = SetNamedSecurityInfoW(path, 1, 4u | (isProtected ? 0x80000000u : 0x20000000u),
    IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
  if (result != 0) { throw new System.ComponentModel.Win32Exception((int)result, "Write DACL: " + path); }
}
public static int Level(IntPtr token) {
  uint length;
  GetTokenInformation(token, 25, IntPtr.Zero, 0, out length);
  if (length == 0) { throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Read integrity information length"); }
  IntPtr buffer = Marshal.AllocHGlobal((int)length);
  try {
    if (!GetTokenInformation(token, 25, buffer, length, out length)) { throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Read integrity information"); }
    IntPtr sid = Marshal.PtrToStructure<TOKEN_MANDATORY_LABEL>(buffer).Label.Sid;
    byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
    return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
  } finally { Marshal.FreeHGlobal(buffer); }
}
'@
    }
}

function Get-IntegritySid {
  try {
    $level = [Dsh.TokenInfo]::Level([System.Security.Principal.WindowsIdentity]::GetCurrent().Token)
    switch ($level) {
      0 { return 'S-1-16-0 (Untrusted)' }
      4096 { return 'S-1-16-4096 (Low)' }
      8192 { return 'S-1-16-8192 (Medium)' }
      12288 { return 'S-1-16-12288 (High)' }
      16384 { return 'S-1-16-16384 (System)' }
      default { return "S-1-16-$level (unrecognized level)" }
    }
  } catch {
    Write-Report observation integrity '' unknown 'The token integrity level could not be read; do not infer that the caller is elevated or confined.' @{ error = (Get-HResultChain $_.Exception) }
    return 'unknown'
  }
}

function Get-NormalizedPath {
  param([string]$Value)
  $full = [System.IO.Path]::GetFullPath($Value)
  $root = [System.IO.Path]::GetPathRoot($full)
  if ($full.Length -le $root.Length) { return $root }
  return $full.TrimEnd('\', '/')
}

function Test-DangerousRoot {
  param([string]$FullPath)
  $trimmed = (Get-NormalizedPath $FullPath).TrimEnd('\')
  if ($trimmed -match '^[A-Za-z]:$') { return 'drive root' }
  if ($trimmed -ieq ([System.IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\'))) { return 'user profile root' }
  if ($trimmed -ieq ([System.IO.Path]::GetFullPath($env:WINDIR).TrimEnd('\'))) { return 'Windows directory' }
  foreach ($entry in @(
    @{ directory = $env:LOCALAPPDATA; child = 'Packages' },
    @{ directory = $env:ProgramFiles; child = 'WindowsApps' },
    @{ directory = $env:ProgramW6432; child = 'WindowsApps' }
  )) {
    if (-not $entry.directory) { continue }
    $protected = Get-NormalizedPath (Join-Path $entry.directory $entry.child)
    if ($trimmed -ieq $protected -or (Test-UnderRoot $trimmed $protected)) { return 'managed application directory' }
  }
  return $null
}

function Test-UnderRoot {
  param([string]$FullPath, [string]$Root, [switch]$AllowEqual)
  $r = Get-NormalizedPath $Root
  $c = Get-NormalizedPath $FullPath
  if ($AllowEqual -and $c -ieq $r) { return $true }
  return $c -ine $r -and $c.StartsWith($r.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-RepairRefusal {
  param([string]$FullPath, [string]$Root, [switch]$AllowEqual)
  if (-not (Test-UnderRoot -FullPath $FullPath -Root $Root -AllowEqual:$AllowEqual)) { return "$FullPath is outside -AllowRoot" }
  $danger = Test-DangerousRoot -FullPath $FullPath
  if ($danger) { return "$FullPath is a $danger" }
  # Checking every component also covers a junction used as AllowRoot itself.
  foreach ($component in (Get-Ancestors -FullPath $FullPath)) {
    $item = Get-Item -LiteralPath $component -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      return "$FullPath traverses a reparse point: $component"
    }
  }
  return $null
}

# A caller that cannot provision a directory also cannot confine a child anywhere
# under it, so one approved run examines that subtree for explicit package allow
# ACEs instead of leaving them for a second call. Directories only: DSH grants and
# traverses directories, and no reparse point or managed application tree is entered.
function Get-SubtreePackageSources {
  param([string]$Root, [int]$Limit)
  $sources = @()
  $visited = 0
  $enqueued = 0
  $failed = 0
  $truncated = $false
  $queue = [System.Collections.Generic.Queue[string]]::new()
  # Unreadable directories are skipped, never guessed at: the caller reports the count.
  try {
    foreach ($child in [System.IO.Directory]::EnumerateDirectories($Root)) {
      if ($enqueued -ge $Limit) { $truncated = $true; break }
      $queue.Enqueue($child); $enqueued++
    }
  } catch [System.UnauthorizedAccessException] { $failed++ }
  catch [System.IO.IOException] { $failed++ }
  while ($queue.Count -gt 0) {
    if ($visited -ge $Limit) { $truncated = $true; break }
    $current = $queue.Dequeue()
    $visited++
    if (Test-DangerousRoot -FullPath $current) { continue }
    $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { $failed++; continue }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
    try {
      $acl = Get-Acl -LiteralPath $current
      foreach ($rule in $acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -match $PACKAGE_SID) { $sources += $current; break }
      }
    } catch [System.UnauthorizedAccessException] { $failed++ }
    catch [System.IO.IOException] { $failed++ }
    try {
      foreach ($child in [System.IO.Directory]::EnumerateDirectories($current)) {
        if ($enqueued -ge $Limit) { $truncated = $true; break }
        $queue.Enqueue($child); $enqueued++
      }
    } catch [System.UnauthorizedAccessException] { $failed++ }
    catch [System.IO.IOException] { $failed++ }
  }
  return [ordered]@{ sources = @($sources); visited = $visited; truncated = $truncated; failed = $failed }
}

function Get-OwnDaclSddl {
  param([string]$Sddl)
  # Inherited ACEs follow their parent: repeating them in a saved DACL forces them
  # back onto the object on restore and stops matching once the parent re-derives
  # them. Keep the observed control flags so the result still carries the
  # object's inheritance protection, and keep every ACE the object owns.
  $flags = [regex]::Match($Sddl, '^D:([A-Z]*)').Groups[1].Value
  $aces = @([regex]::Matches($Sddl, '\([^()]*\)') | ForEach-Object { $_.Value } | Where-Object { ($_ -split ';')[1] -notmatch 'ID' })
  return 'D:{0}{1}' -f $flags, ($aces -join '')
}

function Get-AceSet {
  param([string]$Sddl)
  return @([regex]::Matches($Sddl, '\([^()]*\)') | ForEach-Object { $_.Value } | Sort-Object)
}

function Save-AclBackup {
  param([string]$FullPath, [string]$Directory, [string]$Root)
  $fullDirectory = [System.IO.Path]::GetFullPath($Directory)
  if (-not (Test-Path -LiteralPath $fullDirectory)) {
    Invoke-ReportedOperation create_backup_directory $fullDirectory 'The requested recovery directory does not exist; create it before writing backup files.' files {
      New-Item -ItemType Directory -Path $fullDirectory | Out-Null
    }
  }
  $record = Join-Path $fullDirectory ('acl-backup-{0}.json' -f ([guid]::NewGuid().ToString('N')))
  # The skill's extracted directory expires with its registration. Recovery must
  # remain runnable from the recovery directory after that registration is gone.
  $restoreScript = $record + '.ps1'
  $command = "pwsh -NoProfile -File '{0}' -Path '{1}' -AllowRoot '{2}' -Restore '{3}'" -f
    $restoreScript.Replace("'", "''"), $FullPath.Replace("'", "''"), ([System.IO.Path]::GetFullPath($Root)).Replace("'", "''"), $record.Replace("'", "''")
  Write-Report decision backup $FullPath selected 'The recovery record and an independent recovery script are written before the ACL change.' @{ files = @($record, $restoreScript) }
  Invoke-ReportedOperation backup $FullPath 'Save the original DACL and an independent recovery command before changing permissions.' files {
    $backupAcl = Get-Acl -LiteralPath $FullPath
    $observed = $backupAcl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)
    @{
      Path = $FullPath
      Dacl = Get-OwnDaclSddl -Sddl $observed
      Protected = $backupAcl.AreAccessRulesProtected
      Observed = $observed
    } | ConvertTo-Json | Set-Content -LiteralPath $record -Encoding utf8
    Copy-Item -LiteralPath $PSCommandPath -Destination $restoreScript
  }
  $script:recoveries.Add(@{ path = $FullPath; record = $record; script = $restoreScript; command = $command; attempted = $false; restored = $false })
  Write-Report observation recovery $FullPath available 'These files can restore the saved DACL; no rollback has been executed.' $script:recoveries[-1]
  Write-Line ('BACKUP {0} -> {1}' -f $FullPath, $record)
  Write-Line ('ROLLBACK {0}' -f $command)
}
function Restore-SavedDacl {
  param([string]$FullPath, [string]$Record, [string]$Root)
  $refusal = Get-RepairRefusal -FullPath $FullPath -Root $Root -AllowEqual
  if ($refusal) { throw [System.ArgumentException]::new("RESTORE_REFUSED $refusal") }
  $saved = Invoke-ReportedOperation read_recovery $Record 'Read the recovery record and verify it belongs to the requested path before restoring its DACL.' none {
    Get-Content -LiteralPath $Record -Raw | ConvertFrom-Json
  }
  if ($saved.Path -isnot [string] -or $saved.Path -ine $FullPath -or $saved.Dacl -isnot [string]) {
    throw [System.ArgumentException]::new('RESTORE_REFUSED backup does not describe the requested path')
  }
  if (-not [Dsh.TokenInfo]::HasAccess($FullPath, 0x40000)) { throw 'RESTORE_REFUSED the caller lacks WRITE_DAC' }
  Invoke-ReportedOperation restore_dacl $FullPath 'Restore the requested backup DACL and inheritance protection, preserving owner and SACL.' acl {
    [Dsh.TokenInfo]::SetDacl($FullPath, $saved.Dacl)
  }
  $restoredAcl = Invoke-ReportedOperation read_restored_dacl $FullPath 'Read the restored DACL to compare it with the saved record.' none {
    Get-Acl -LiteralPath $FullPath
  }
  # Inherited entries follow the parent, so the same object can render a different
  # full DACL before and after a correct restore. Compare the own ACEs and the
  # protection state, which the restore owns.
  $restoredProtected = $restoredAcl.AreAccessRulesProtected
  $actual = Get-OwnDaclSddl -Sddl $restoredAcl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)
  $expectedAces = Get-AceSet -Sddl $saved.Dacl
  $actualAces = Get-AceSet -Sddl $actual
  $restored = (@($expectedAces) -join "`n") -eq (@($actualAces) -join "`n") -and $restoredProtected -eq [bool]$saved.Protected
  Write-Report verification restore $FullPath $(if ($restored) { 'verified' } else { 'failed' }) 'Compare the restored own ACEs and protection state with the recovery record.' @{ expectedAces = @($expectedAces); actualAces = @($actualAces); protected = $restoredProtected; expectedProtected = [bool]$saved.Protected }
  if (-not $restored) { throw 'RESTORE_FAILED the restored DACL differs from the backup' }
  $script:restored++
  Write-Line ('RESTORED {0}' -f $FullPath)
}

function Get-ObjectFacts {
  param([string]$FullPath, [string]$MeSid, [switch]$CompactRecord)
  $facts = [ordered]@{
    Object = $FullPath
    Readable = $false
    Error = ''
    PackageAces = @()
    OtherAppContainerSids = @()
    Owner = ''
    OwnerIsMe = $false
    MyRights = ''
    HasWriteDac = $null
    HasWriteOwner = $null
    Aces = @()
    Errors = @()
    LowLabel = $null
    AclLines = @()
  }
  try {
    # Get-Acl reads the security descriptor directly. On .NET Core the
    # FileSystemInfo.GetAccessControl() form is an extension method, which
    # PowerShell cannot invoke with instance syntax.
    $acl = Get-Acl -LiteralPath $FullPath
    $facts.Readable = $true
  } catch {
    $facts.Error = Get-HResultChain -Exception $_.Exception
    Write-Report observation inspect_acl $FullPath unreadable 'The ACL read failed; permissions and the cause of denial remain unknown.' @{ error = $facts.Error }
    return $facts
  }
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    $sid = $rule.IdentityReference.Value
    $facts.Aces += [ordered]@{
      sid = $sid; type = [string]$rule.AccessControlType; rights = [string]$rule.FileSystemRights
      inherited = $rule.IsInherited; inheritance = [string]$rule.InheritanceFlags; propagation = [string]$rule.PropagationFlags
    }
    if ($sid -match $PACKAGE_SID -and $rule.AccessControlType -eq 'Allow') {
      $facts.PackageAces += ('SID={0} INHERITED={1} INHERITABLE={2} RIGHTS={3}' -f $sid, $rule.IsInherited, $rule.InheritanceFlags, $rule.FileSystemRights)
    } elseif ($sid -match '^S-1-15-' -and $sid -notmatch $PACKAGE_SID) {
      $facts.OtherAppContainerSids += $sid
    }
    if ($sid -eq $MeSid -and $rule.AccessControlType -eq 'Allow') {
      $facts.MyRights = ($facts.MyRights + ';' + [string]$rule.FileSystemRights).Trim(';')
    }
  }
  try {
    $facts.Owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    $facts.OwnerIsMe = ($facts.Owner -eq $MeSid)
  } catch {
    $facts.Owner = 'unreadable'
    $facts.Errors += @{ operation = 'read_owner'; error = (Get-HResultChain $_.Exception) }
  }
  foreach ($check in @(@{ field = 'HasWriteDac'; mask = 0x40000 }, @{ field = 'HasWriteOwner'; mask = 0x80000 })) {
    try { $facts[$check.field] = [Dsh.TokenInfo]::HasAccess($FullPath, $check.mask) }
    catch { $facts.Errors += @{ operation = $check.field; error = (Get-HResultChain $_.Exception) } }
  }
  # The mandatory label lives in the SACL. Reading the SACL needs a privilege while
  # icacls prints the label without one, but icacls renders it by name, which is
  # localized: try the integrity SID first and keep the English name as a fallback.
  try {
    $facts.AclLines = @(icacls $FullPath 2>&1 | ForEach-Object { [string]$_ })
    if ($LASTEXITCODE -ne 0) { throw "icacls exit ${LASTEXITCODE}: $($facts.AclLines -join "`n")" }
    $text = $facts.AclLines -join "`n"
    # An unrecognized localized label is unknown, not evidence of a Low label.
    if ($text -match $LOW_LABEL_SID -or $text -match 'Mandatory Label\\Low Mandatory Level') { $facts.LowLabel = $true }
  } catch {
    $facts.Errors += @{ operation = 'icacls'; error = (Get-HResultChain $_.Exception) }
  }
  Write-Report observation inspect_acl $FullPath $(if ($facts.Errors.Count) { 'partial' } else { 'read' }) 'Read the ACL and check effective WRITE_DAC and WRITE_OWNER; observed ACEs alone do not identify which rule caused a denial.' @{
    owner = $facts.Owner; writeDac = $facts.HasWriteDac; writeOwner = $facts.HasWriteOwner
    # A re-read after a change repeats an ACL this run already recorded: keep the
    # full ACE list in memory, but do not print it twice.
    aces = $(if ($CompactRecord) { @() } else { $facts.Aces }); acesOmitted = [bool]$CompactRecord
    lowLabel = $facts.LowLabel; errors = $facts.Errors
  }
  return $facts
}

function Get-Ancestors {
  param([string]$FullPath)
  $list = @()
  $current = Get-NormalizedPath $FullPath
  while ($true) {
    $list += $current
    $parent = [System.IO.Path]::GetDirectoryName($current)
    if ([string]::IsNullOrEmpty($parent) -or $parent -eq $current) { break }
    $current = $parent
  }
  return $list
}

# --- main ---------------------------------------------------------------

$operations = [System.Collections.Generic.List[object]]::new()
$recoveries = [System.Collections.Generic.List[object]]::new()
$reports = [System.Collections.Generic.List[object]]::new()
$reportPath = $null
$reportWriter = $null
$requestedPaths = @()
$rollbackStatus = 'not-needed'
$fixed = 0
$granted = 0
$refused = 0
$restored = 0
$exitCode = 0
$observationFailures = 0
$scanTruncated = $false
$currentPath = ''
$mode = if ($Restore) { 'restore' } else { 'repair' }

try {
  $requestedPaths = @($Path | ForEach-Object { [System.IO.Path]::GetFullPath($_) })
  Write-Report invocation $mode '' started 'Inspect the requested paths, then repair the ACL problems this run can prove, before anything else is attempted.' @{
    paths = $Path; allowRoot = $AllowRoot; outputDirectory = $Out; recoveryRecord = $Restore
  }
  if (-not $AllowRoot) { throw [System.ArgumentException]::new('Every modification requires -AllowRoot') }
  if (-not $Restore -and -not $Out) { throw [System.ArgumentException]::new('A repair requires -Out for its recovery artifacts') }
  if ($Restore -and $Path.Count -ne 1) { throw [System.ArgumentException]::new('-Restore requires exactly one -Path') }
  if ($Out) {
    Invoke-ReportedOperation prepare_report $Out 'Create the recovery directory and a new JSONL report that keeps every record, because tool output is truncated to its tail.' files {
      $directory = [System.IO.Path]::GetFullPath($Out)
      [System.IO.Directory]::CreateDirectory($directory) | Out-Null
      $script:reportPath = Join-Path $directory ('acl-report-{0}.jsonl' -f [guid]::NewGuid().ToString('N'))
      $stream = [System.IO.File]::Open($script:reportPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
      $script:reportWriter = [System.IO.StreamWriter]::new($stream, [System.Text.UTF8Encoding]::new($false))
      foreach ($record in $script:reports) { $script:reportWriter.WriteLine(($record | ConvertTo-Json -Depth 12 -Compress)) }
    }
  }
  $identity = Get-CurrentIdentity
  $meSid = $identity.User.Value
  Invoke-ReportedOperation initialize '' 'Load read-only access checks and DACL-only writes before inspecting permissions.' none { Initialize-NativeApi }
  $integrity = Get-IntegritySid
  Write-Line ('CALLER SID={0} INTEGRITY={1}' -f $meSid, $integrity)
  Write-Report observation caller '' read 'The caller token determines effective access; unconfined execution does not imply elevation.' @{ sid = $meSid; integrity = $integrity }
  :paths foreach ($requested in $Path) {
    $currentPath = $requested
    $full = Get-NormalizedPath $requested
    $currentPath = $full
    Write-Line ('PATH={0}' -f $full)
    if (-not (Test-Path -LiteralPath $full)) {
      Write-Line '  MISSING'
      Write-Line 'VERDICT=NOT_THIS_CLASS'
      Write-Decision $mode $full skipped 'The requested path does not exist; no ACL was read or changed for it.'
      $refused++
      break paths
    }

    $factsByPath = @{}
    $inspectOrder = @()
    $packageTargets = @()
    $targetFacts = $null
    foreach ($ancestor in (Get-Ancestors -FullPath $full)) {
      if (-not (Test-Path -LiteralPath $ancestor)) { continue }
      $facts = Get-ObjectFacts -FullPath $ancestor -MeSid $meSid
      $factsByPath[$facts.Object] = $facts
      $inspectOrder += $facts.Object
      if ($ancestor -eq $full) { $targetFacts = $facts }
      Write-Line ('  OBJECT={0} READABLE={1}{2}' -f $facts.Object, $facts.Readable, $(if ($facts.Readable) { '' } else { ' ERROR=' + $facts.Error }))
      if ($facts.Readable) {
        Write-Line ('    OWNER={0} IS_CURRENT_USER={1} MY_RIGHTS=[{2}] WRITE_DAC={3} WRITE_OWNER={4} LOW_LABEL={5}' -f $facts.Owner, $facts.OwnerIsMe, $facts.MyRights, $facts.HasWriteDac, $facts.HasWriteOwner, $facts.LowLabel)
        foreach ($ace in $facts.PackageAces) { Write-Line ('    PACKAGE_ACE {0}' -f $ace) }
        foreach ($sid in ($facts.OtherAppContainerSids | Sort-Object -Unique)) { Write-Line ('    OTHER_S1_15 SID={0} (reported only)' -f $sid) }
      }
      if ($facts.PackageAces.Count -gt 0) { $packageTargets += $facts.Object }
    }

    # The precondition is judged on the requested path itself. Ancestors above the
    # tree DSH grants are not part of that grant, so their ownership and rights would
    # otherwise mark every healthy path as a precondition failure.
    if ($null -eq $targetFacts) { throw "The requested path disappeared before its ACL could be inspected: $full" }
    $unreadable = -not $targetFacts.Readable
    $needsPrecondition = (-not $unreadable) -and
      ((-not $targetFacts.HasWriteDac) -or (-not $targetFacts.HasWriteOwner))

    # A directory the caller cannot provision is the workspace root half the time: the sandbox
    # reports its own failure there while the conflicting entry sits deeper. Examine that
    # subtree before the verdict so the classification and its packageObjects describe what
    # this run will actually repair.
    $ownsRoot = $full -ieq (Get-NormalizedPath $AllowRoot)
    if (-not $Restore -and $targetFacts.Errors.Count -eq 0 -and [System.IO.Directory]::Exists($full) -and ($needsPrecondition -or $ownsRoot)) {
      $scan = Get-SubtreePackageSources -Root $full -Limit $SCAN_LIMIT
      foreach ($object in $scan.sources) {
        if ($packageTargets -notcontains $object) { $packageTargets += $object }
        if (-not $factsByPath.ContainsKey($object)) {
          $scanned = Get-ObjectFacts -FullPath $object -MeSid $meSid
          $factsByPath[$scanned.Object] = $scanned
        }
      }
      Write-Report observation subtree_scan $full $(if ($scan.failed -gt 0) { 'partial' } else { 'read' }) 'The caller cannot provision this directory, or it is the authorized root, so explicit package allow ACEs under it were collected in the same run; no reparse point or managed application tree is entered.' @{
        visited = $scan.visited; packageSources = @($scan.sources); truncated = [bool]$scan.truncated; unreadable = [int]$scan.failed
      }
      Write-Line ('SCAN {0} VISITED={1} PACKAGE_SOURCES={2}{3}{4}' -f $full, $scan.visited, @($scan.sources).Count, $(if ($scan.truncated) { ' TRUNCATED' } else { '' }), $(if ($scan.failed -gt 0) { " UNREADABLE=$($scan.failed)" } else { '' }))
      if ($scan.truncated) { $script:scanTruncated = $true }
    }

    if ($targetFacts.Errors.Count -gt 0) {
      $verdict = 'INCOMPLETE'
      $reason = 'Some observations failed; missing evidence is not evidence that a right is absent or a repair is safe.'
    } elseif ($packageTargets.Count -gt 0) {
      $blocked = @($packageTargets | Where-Object { -not $factsByPath[$_].HasWriteDac })
      $verdict = if ($needsPrecondition -or $blocked.Count -gt 0) { 'BOTH' } else { 'CULPRIT' }
      $reason = 'Package allow ACEs were observed. Required access checks determine whether the caller can perform the requested repair; other causes remain possible.'
    } elseif ($unreadable) {
      $verdict = 'UNREADABLE'
      $reason = 'The requested ACL could not be read; its entries and the cause of denial are unknown.'
    } elseif ($needsPrecondition) {
      $verdict = 'PRECONDITION'
      $reason = 'The caller cannot open the requested object with both WRITE_DAC and WRITE_OWNER. The reported allow and deny ACEs are evidence, not an attribution to one rule.'
    } else {
      $verdict = 'NOT_THIS_CLASS'
      $reason = 'No package allow ACE was observed and both required rights are available. Other ACL restrictions and causes of the original failure are not ruled out.'
    }
    Write-Line ('VERDICT={0}' -f $verdict)
    Write-Report decision classify $full $verdict $reason @{ writeDac = $targetFacts.HasWriteDac; writeOwner = $targetFacts.HasWriteOwner; packageObjects = @($packageTargets) }

    if ($Restore) {
      Restore-SavedDacl -FullPath $full -Record $Restore -Root $AllowRoot
      continue
    }
    if ($targetFacts.Errors.Count -gt 0) {
      Write-Decision $mode $full refused 'Required observations are incomplete; no repair was attempted for this path.'
      $refused++
      break paths
    }

    # Nothing is changed while a package source or a grant target is out of reach: a
    # repair that cannot finish would leave the tree half repaired before refusing.
    foreach ($packagePath in $packageTargets) {
      $refusal = Get-RepairRefusal -FullPath $packagePath -Root $AllowRoot -AllowEqual
      if ($refusal) { Write-Line ('REPAIR_REFUSED {0}' -f $refusal); Write-Decision $mode $packagePath refused $refusal; $refused++; break paths }
      if ($factsByPath[$packagePath].Errors.Count -gt 0) {
        Write-Decision $mode $packagePath refused 'The ACL observations are incomplete; collateral changes could not be verified.'
        $refused++
        break paths
      }
    }

    # Missing WRITE_DAC or WRITE_OWNER on a directory in the chain is what stops DSH
    # from provisioning the workspace grant. One approved run repairs every such
    # directory, including the authorized root itself.
    $grantTargets = @($inspectOrder | Where-Object {
      [System.IO.Directory]::Exists($_) -and $factsByPath[$_].Readable -and $factsByPath[$_].Errors.Count -eq 0 -and
      ((-not $factsByPath[$_].HasWriteDac) -or (-not $factsByPath[$_].HasWriteOwner)) -and
      -not (Get-RepairRefusal -FullPath $_ -Root $AllowRoot -AllowEqual)
    })
    # Writing a DACL needs WRITE_DAC: refuse a target that lacks it before anything is
    # changed, instead of failing mid-repair and marking a recovery for an object that
    # the rollback then cannot restore either.
    foreach ($object in $grantTargets) {
      if (-not $factsByPath[$object].HasWriteDac) {
        Write-Line ('REPAIR_REFUSED {0} needs WRITE_DAC; stop for permission-policy review' -f $object)
        Write-Decision $mode $object refused 'Effective WRITE_DAC is absent; adding the grant requires that right.'
        $refused++
        break paths
      }
    }
    if ($grantTargets.Count -gt 0) {
      Write-Report decision grant_targets $full selected 'These directories lack effective WRITE_DAC or WRITE_OWNER; each is backed up, then receives a FullControl allow ACE for the current user.' @{ paths = @($grantTargets) }
    }
    foreach ($object in $grantTargets) {
      $grantBefore = $factsByPath[$object]
      Save-AclBackup -FullPath $object -Directory $Out -Root $AllowRoot
      $grantAcl = Get-Acl -LiteralPath $object
      $grantAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
        [System.Security.Principal.SecurityIdentifier]::new($meSid),
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.AccessControlType]::Allow))
      Invoke-ReportedOperation grant_dacl $object "WRITE_DAC or WRITE_OWNER is missing; add a FullControl allow ACE for $meSid while preserving deny ACEs, owner and SACL." acl {
        [Dsh.TokenInfo]::SetDacl($object, $grantAcl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access))
      }
      $grantAfter = Get-ObjectFacts -FullPath $object -MeSid $meSid -CompactRecord
      $factsByPath[$object] = $grantAfter
      $verified = $grantAfter.Readable -and $grantAfter.Errors.Count -eq 0 -and $grantAfter.HasWriteDac -and $grantAfter.HasWriteOwner
      Write-Report verification grant $object $(if ($verified) { 'verified' } else { 'failed' }) 'The DACL write completed; recheck effective access before claiming that provisioning can succeed. On failure, restore this invocation and stop.' @{
        before = @{ writeDac = $grantBefore.HasWriteDac; writeOwner = $grantBefore.HasWriteOwner }
        after = @{ writeDac = $grantAfter.HasWriteDac; writeOwner = $grantAfter.HasWriteOwner }
        recovery = $recoveries[-1].command
      }
      if ($verified) {
        Write-Line ('GRANTED {0} SID={1}' -f $object, $meSid); $granted++
      } else {
        Write-Line ('GRANT_FAILED {0}; effective WRITE_DAC and WRITE_OWNER were not both confirmed; restore this invocation and stop' -f $object)
        $refused++
        break paths
      }
    }

    $sources = @($packageTargets | Where-Object {
      @($factsByPath[$_].Aces | Where-Object { $_.type -eq 'Allow' -and $_.sid -match $PACKAGE_SID -and -not $_.inherited }).Count -gt 0
    })
    # Ancestor first, for chain and scan-discovered sources alike.
    $sources = @($sources | Sort-Object -Property @{ Expression = { $_.Split([char]92).Count } }, @{ Expression = { $_ } })
    foreach ($source in $sources) {
      if (-not $factsByPath[$source].HasWriteDac) {
        Write-Line ('REPAIR_REFUSED {0} needs WRITE_DAC; stop for permission-policy review' -f $source)
        Write-Decision $mode $source refused 'Effective WRITE_DAC is absent; removing a package allow ACE requires that right.'
        $refused++
        break paths
      }
    }
    if ($sources.Count -gt 0) {
      Write-Report decision remove_package_sources $full selected 'Remove explicit package allow ACEs from their sources, ancestor first, leaving inheritance enabled so inherited copies follow their repaired source.' @{
        sources = @($sources); affectedPaths = @($packageTargets)
      }
    }
    foreach ($source in $sources) {
      Save-AclBackup -FullPath $source -Directory $Out -Root $AllowRoot
      $sids = @($factsByPath[$source].Aces | Where-Object { $_.type -eq 'Allow' -and $_.sid -match $PACKAGE_SID -and -not $_.inherited } | ForEach-Object { $_.sid } | Sort-Object -Unique)
      foreach ($sid in $sids) {
        Invoke-ReportedOperation remove_package_allow $source "Remove the observed package allow ACE for $sid; preserve deny ACEs and all other principals." acl {
          $output = @(icacls $source /remove:g "*$sid" 2>&1)
          if ($LASTEXITCODE -ne 0) { throw "icacls removal exit $($LASTEXITCODE): $($output -join [char]10)" }
        }
      }
    }

    # A package deny can share the removed allow's SID; only allow ACEs were removed.
    foreach ($packagePath in $packageTargets) {
      $fixBefore = $factsByPath[$packagePath]
      $fixAfter = Get-ObjectFacts -FullPath $packagePath -MeSid $meSid -CompactRecord
      # Compare the object's own ACEs as sorted sets: listing order and inherited
      # entries follow the parent, so neither proves a collateral change.
      $rowOf = { param($ace) '{0}|{1}|{2}|{3}|{4}' -f $ace.type, $ace.sid, $ace.rights, $ace.inheritance, $ace.propagation }
      $ownAfter = @($fixAfter.Aces | Where-Object { -not $_.inherited } | ForEach-Object { & $rowOf $_ } | Sort-Object)
      $expectedOwn = @($fixBefore.Aces | Where-Object { -not $_.inherited -and -not ($_.type -eq 'Allow' -and $_.sid -match $PACKAGE_SID) } | ForEach-Object { & $rowOf $_ } | Sort-Object)
      $collateral = (@($expectedOwn) -join [char]10) -eq (@($ownAfter) -join [char]10)
      $verified = $fixAfter.Readable -and $fixAfter.Errors.Count -eq 0 -and $fixAfter.PackageAces.Count -eq 0 -and $collateral
      Write-Report verification fix $packagePath $(if ($verified) { 'verified' } else { 'failed' }) 'The removal command completed; verify that package allow ACEs disappeared and other own ACEs remained unchanged. On failure, restore this invocation and stop.' @{
        remainingPackageAces = $fixAfter.PackageAces; otherEntriesUnchanged = $collateral
      }
      if ($verified) {
        $removedSids = @($fixBefore.Aces | Where-Object { $_.type -eq 'Allow' -and $_.sid -match $PACKAGE_SID -and -not $_.inherited } | ForEach-Object { $_.sid } | Sort-Object -Unique)
        foreach ($sid in $removedSids) {
          Write-Line ('FIXED {0} SID={1}' -f $packagePath, $sid); $fixed++
        }
      } else {
        Write-Line ('FIX_FAILED {0} collateral_change={1}' -f $packagePath, (-not $collateral))
        $refused++
        break paths
      }
    }

    if ($packageTargets.Count -eq 0 -and $grantTargets.Count -eq 0) {
      Write-Decision $mode $full skipped 'No package allow ACE and no missing WRITE_DAC or WRITE_OWNER was observed on the inspected objects; no ACL change was needed.'
    }
  }
} catch {
  $exitCode = if ($_.Exception -is [System.ArgumentException]) { 2 } else { 1 }
  Write-Report error $mode $currentPath stopped 'Execution stopped after an exception. An interrupted write may have changed state; attempted repairs will be restored before the final summary.' @{ error = (Get-HResultChain $_.Exception); location = $_.InvocationInfo.PositionMessage }
} finally {
  if ($refused -gt 0 -and $exitCode -eq 0) { $exitCode = 2 }
  if ($exitCode -ne 0 -and -not $Restore) {
    for ($i = $recoveries.Count - 1; $i -ge 0; $i--) {
      $recovery = $recoveries[$i]
      if (-not $recovery.attempted) { continue }
      Write-Decision rollback $recovery.path selected 'The repair failed; restore every attempted DACL change from this invocation in reverse order before stopping.'
      try {
        Restore-SavedDacl -FullPath $recovery.path -Record $recovery.record -Root $AllowRoot
        $recovery.restored = $true
        $rollbackStatus = 'verified'
      } catch {
        $rollbackStatus = 'failed'
        Write-Report error rollback $recovery.path stopped 'Recovery was not verified. Stop repairs and retain the pending recovery commands in reverse order.' @{ error = (Get-HResultChain $_.Exception) }
        break
      }
    }
  }
  $pending = @($recoveries | Where-Object { $_.attempted -and -not $_.restored } | ForEach-Object { $_.command })
  [array]::Reverse($pending)
  $repaired = ($fixed + $granted) -gt 0
  $nextAction = if ($rollbackStatus -eq 'failed') { 'restore_pending_then_stop' } elseif ($exitCode -ne 0 -or $observationFailures -gt 0) { 'stop' } elseif ($repaired) { 'verify_original_confined_operation' } else { 'stop' }
  # The tool keeps only the tail of stdout. Recapitulate the decisions here so the
  # records a reader needs survive truncation; the report file holds every record.
  $recap = [ordered]@{
    verdicts = @($reports | Where-Object { $_.operation -eq 'classify' } | ForEach-Object {
      @{ path = $_.path; verdict = $_.status; writeDac = $_.details['writeDac']; writeOwner = $_.details['writeOwner']; packageObjects = $_.details['packageObjects'] }
    })
    changes = @($reports | Where-Object { $_.kind -eq 'action' -and $_.details['effect'] -eq 'acl' -and $_.status -eq 'completed' } | ForEach-Object { @{ operation = $_.operation; path = $_.path } })
    verifications = @($reports | Where-Object { $_.kind -eq 'verification' } | ForEach-Object { @{ operation = $_.operation; path = $_.path; status = $_.status } })
    refusals = @($reports | Where-Object { $_.kind -eq 'decision' -and $_.status -eq 'refused' } | ForEach-Object { @{ path = $_.path; reason = $_.reason } })
    scans = @($reports | Where-Object { $_.operation -eq 'subtree_scan' } | ForEach-Object {
      @{ path = $_.path; visited = $_.details['visited']; packageSources = @($_.details['packageSources']); truncated = $_.details['truncated']; unreadable = $_.details['unreadable'] }
    })
    report = $reportPath
  }
  $status = if ($exitCode -ne 0) { 'failed' } elseif ($observationFailures -gt 0) { 'partial' } else { 'completed' }
  Write-Report summary $mode $currentPath $status 'Operation completion records API execution; verification records the observed result. Only rerunning the original confined operation can confirm its failure is resolved.' @{
    exitCode = $exitCode; fixed = $fixed; granted = $granted; refused = $refused; restored = $restored
    operations = @($operations.ToArray()); recoveries = @($recoveries.ToArray()); automaticRollback = $true; observationFailures = $observationFailures
    rollback = $rollbackStatus; rollbackCommands = $pending; nextAction = $nextAction; scanTruncated = $scanTruncated; report = $reportPath
  }
  # Last on stdout, after the summary record: whatever the tool truncates, the tail
  # still carries the decisions, the report path and the counts.
  Write-Line ('RECAP ' + ($recap | ConvertTo-Json -Depth 8 -Compress))
  if ($reportPath) { Write-Line ('REPORT_FILE {0}' -f $reportPath) }
  Write-Line ('SUMMARY FIXED={0} GRANTED={1} REFUSED={2} RESTORED={3}' -f $fixed, $granted, $refused, $restored)
  if ($reportWriter) { $reportWriter.Dispose() }
}
exit $exitCode
