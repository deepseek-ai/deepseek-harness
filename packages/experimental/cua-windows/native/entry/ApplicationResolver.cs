// Optional Shell identity observations for consent. The private Windows 8+ interface may be unavailable.
using System.Runtime.InteropServices;

namespace DeepSeek.Cua.Windows;

internal static class ApplicationResolver
{
    [ComImport, Guid("DE25675A-72DE-44B4-9373-05170450C140"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IApplicationResolver
    {
        [PreserveSig] int GetAppIDForShortcut(nint item, out nint appId);
        [PreserveSig] int GetAppIDForShortcutObject(nint link, nint item, out nint appId);
        [PreserveSig] int GetAppIDForWindow(nint window, out nint appId, nint prevent, nint explicitId, nint shortcutValid);
        [PreserveSig] int GetAppIDForProcess(uint process, out nint appId, nint prevent, nint explicitId, nint shortcutValid);
        [PreserveSig] int GetShortcutForProcess(uint process, out nint item);
        [PreserveSig] int GetBestShortcutForAppID([MarshalAs(UnmanagedType.LPWStr)] string appId, out nint item);
        [PreserveSig] int GetBestShortcutAndAppIDForAppPath([MarshalAs(UnmanagedType.LPWStr)] string path, out nint item, out nint appId);
    }

    // Callers own the STA invocation; no COM object or process ID survives this observation.
    internal static string? ForWindow(nint window) => Query(resolver =>
    {
        nint value = 0;
        try { return resolver.GetAppIDForWindow(window, out value, 0, 0, 0) >= 0 ? Read(value) : null; }
        finally { Marshal.FreeCoTaskMem(value); }
    });

    internal static string? ForPath(string path) => Query(resolver =>
    {
        nint item = 0, value = 0;
        try { return resolver.GetBestShortcutAndAppIDForAppPath(path, out item, out value) >= 0 ? Read(value) : null; }
        finally
        {
            Marshal.FreeCoTaskMem(value);
            if (item != 0) Marshal.Release(item);
        }
    });

    private static string? Read(nint value) => value == 0 ? null : Marshal.PtrToStringUni(value);

    private static string? Query(Func<IApplicationResolver, string?> query)
    {
        object? instance = null;
        try
        {
            instance = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("660B90C8-73A9-4B58-8CAE-355B7F55341B"), true)!);
            return instance is IApplicationResolver resolver ? query(resolver) : null;
        }
        catch (Exception error) when (error is COMException or InvalidCastException or TypeLoadException or NotSupportedException)
        {
            // Missing Shell metadata leaves the native ID and other permission attributes usable.
            return null;
        }
        finally { if (instance is not null && Marshal.IsComObject(instance)) Marshal.FinalReleaseComObject(instance); }
    }
}
