// Observations stop when the interactive input desktop is unavailable.
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal static class DesktopSession
{
    internal static bool? Locked()
    {
        using var process = Process.GetCurrentProcess();
        if (!Win32.WTSQuerySessionInformation(0, process.SessionId, 8, out var state, out var bytes)) return null;
        try { if (bytes < sizeof(int) || Marshal.ReadInt32(state) != 0) return true; }
        finally { Win32.WTSFreeMemory(state); }
        var desktop = Win32.OpenInputDesktop(0, false, 1);
        if (desktop == 0) return Marshal.GetLastWin32Error() == 5 ? true : null;
        try
        {
            var name = new StringBuilder(256);
            if (!Win32.GetUserObjectInformation(desktop, 2, name, name.Capacity * sizeof(char), out _)) return null;
            return !string.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
        }
        finally { Win32.CloseDesktop(desktop); }
    }

    internal static void RequireInteractive()
    {
        if (Locked() != false) throw new NativeFailure("SESSION_LOCKED", "Unlock Windows and return to an interactive desktop before observing or sending input");
    }

    internal static object Status(bool captureAvailable)
    {
        using var identity = WindowsIdentity.GetCurrent();
        return new
        {
            platform = "windows", sessionLocked = Locked(),
            captureAvailable,
            elevated = new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator),
            helper = new { pid = 4, path = Environment.ProcessPath, name = "dsh-cua-windows" },
        };
    }
}
