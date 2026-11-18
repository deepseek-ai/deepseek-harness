# Normalize only this workflow shell and the children it subsequently launches.
[CmdletBinding()]
param([switch]$InspectOnly, [switch]$BestEffort)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Packaging process priority requires Windows.' }

if (-not ('DshPackagingPriority' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshPackagingPriority {
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("ntdll.dll")] static extern int NtSetInformationProcess(IntPtr process, int kind, ref int value, int size);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int kind, out int value, int size, out int length);
  public static int Read(int kind) {
    int value, length;
    int status = NtQueryInformationProcess(GetCurrentProcess(), kind, out value, 4, out length);
    if (status != 0 || length != 4) throw new InvalidOperationException("Cannot read packaging priority: " + status);
    return value;
  }
  public static void Set(int kind, int value) {
    int status = NtSetInformationProcess(GetCurrentProcess(), kind, ref value, 4);
    if (status != 0) throw new InvalidOperationException("Cannot set packaging priority: " + status);
  }
}
'@
}

$process = [Diagnostics.Process]::GetCurrentProcess()
try {
  $before = [ordered]@{
    cpu = $process.PriorityClass.ToString()
    io = [DshPackagingPriority]::Read(33)
    memory = [DshPackagingPriority]::Read(39)
  }
  if (-not $InspectOnly) {
    $process.PriorityClass = [Diagnostics.ProcessPriorityClass]::Normal
    # PROCESSINFOCLASS: ProcessIoPriority (33), ProcessPagePriority (39).
    [DshPackagingPriority]::Set(33, 2)
    [DshPackagingPriority]::Set(39, 5)
  }
  $process.Refresh()
  $after = [ordered]@{
    cpu = $process.PriorityClass.ToString()
    io = [DshPackagingPriority]::Read(33)
    memory = [DshPackagingPriority]::Read(39)
  }
  [ordered]@{ event = 'packaging-process-priority'; before = $before; after = $after } | ConvertTo-Json -Compress
  if (-not $InspectOnly -and ($after.cpu -ne 'Normal' -or $after.io -ne 2 -or $after.memory -ne 5)) {
    throw 'Packaging process did not reach normal CPU, I/O and memory priority.'
  }
} catch {
  if (-not $BestEffort) { throw }
  Write-Warning "Packaging priority adjustment unavailable; performance comparison is invalid: $($_.Exception.Message)"
  [ordered]@{ event = 'packaging-process-priority'; comparable = $false } | ConvertTo-Json -Compress
} finally {
  $process.Dispose()
}
