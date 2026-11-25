// Windows Shell resolves desktop process AUMIDs that are not exposed as window properties.
using System.Runtime.InteropServices;
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal static class ApplicationResolver
{
    // Windows 8+ Shell interface, also used by System Informer's phlib/appresolver.c.
    [ComImport, Guid("DE25675A-72DE-44B4-9373-05170450C140"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IApplicationResolver
    {
        [PreserveSig] int GetAppIDForShortcut(nint item, out nint appId);
        [PreserveSig] int GetAppIDForShortcutObject(nint link, nint item, out nint appId);
        [PreserveSig] int GetAppIDForWindow(nint window, out nint appId, nint preventPinning, nint explicitId, nint shortcutValid);
    }

    // Call on the helper's STA; the returned string is copied before releasing Shell resources.
    internal static string? ForWindow(nint window)
    {
        object instance;
        try { instance = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("660B90C8-73A9-4B58-8CAE-355B7F55341B"), true)!)!; }
        catch (COMException error)
        {
            throw new NativeFailure("APP_IDENTITY_UNAVAILABLE", $"Windows Shell application resolution is unavailable (0x{error.HResult:X8})");
        }
        try
        {
            var result = ((IApplicationResolver)instance).GetAppIDForWindow(window, out var text, 0, 0, 0);
            try
            {
                if (result < 0)
                    throw new NativeFailure("APP_IDENTITY_UNAVAILABLE", $"Windows Shell could not resolve the window application (0x{result:X8})");
                return text == 0 ? null : Marshal.PtrToStringUni(text);
            }
            finally { Marshal.FreeCoTaskMem(text); }
        }
        finally { Marshal.FinalReleaseComObject(instance); }
    }
}
