// Toolhelp snapshots expose parent IDs without the WMI namespace permissions required by CIM.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class DshRunnerProcesses
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Entry
    {
        public uint Size, Usage, ProcessId;
        public UIntPtr DefaultHeapId;
        public uint ModuleId, Threads, ParentProcessId;
        public int Priority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", EntryPoint = "Process32FirstW", SetLastError = true)]
    private static extern bool First(IntPtr snapshot, ref Entry entry);
    [DllImport("kernel32.dll", EntryPoint = "Process32NextW", SetLastError = true)]
    private static extern bool Next(IntPtr snapshot, ref Entry entry);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    // These parent IDs select handles to await; taskkill retains termination authority over the live tree.
    public static Dictionary<int, int> ReadParents()
    {
        IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var result = new Dictionary<int, int>();
            var entry = new Entry { Size = (uint)Marshal.SizeOf(typeof(Entry)) };
            bool found = First(snapshot, ref entry);
            while (found)
            {
                result.Add((int)entry.ProcessId, (int)entry.ParentProcessId);
                found = Next(snapshot, ref entry);
            }
            int error = Marshal.GetLastWin32Error();
            if (error != 18) throw new Win32Exception(error);
            return result;
        }
        finally { CloseHandle(snapshot); }
    }
}
