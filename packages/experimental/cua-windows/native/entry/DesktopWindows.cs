// Desktop discovery selects windows by their invariant decimal HWND strings.
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal sealed record DiscoveredWindow(WindowState Window, RunningApplication Process)
{
    internal string Selector => Window.Id.ToString(CultureInfo.InvariantCulture);
}

internal static class DesktopWindows
{
    internal static object[] ListApps(RequestContext context)
    {
        var result = new List<object>();
        foreach (var entry in Discover(context))
        {
            context.Check();
            try
            {
                using var owner = Owner(entry, false, context);
                entry.Window.Geometry(owner, context);
                result.Add(new { pid = 4, name = owner.Authorization.Name, id = entry.Selector });
            }
            catch (NativeFailure error) when (error.Code is "STALE_APP" or "PERMISSION_DENIED" or "APP_IDENTITY_UNAVAILABLE" or "UNSUPPORTED_SESSION" or "WINDOW_CHANGED")
            {
                // A disappearing or inaccessible window is omitted from discovery.
            }
        }
        return result.ToArray();
    }

    internal static AppState Select(string selector, RequestContext context)
    {
        if (string.IsNullOrEmpty(selector)) throw new NativeFailure("INVALID_ARGUMENT", "A window selector from listApps is required");
        var entry = Discover(context).SingleOrDefault(value => string.Equals(value.Selector, selector, StringComparison.Ordinal))
            ?? throw new NativeFailure("WINDOW_CHANGED", "Discover applications again; this window is no longer available");
        var app = Owner(entry, true, context);
        try { entry.Window.Geometry(app, context); return app; }
        catch { app.Dispose(); throw; }
    }

    private static List<DiscoveredWindow> Discover(RequestContext context)
    {
        var current = new List<nint>();
        Win32.EnumWindows((handle, _) =>
        {
            var extended = Win32.GetWindowLongPtr(handle, -20).ToInt64();
            if (Win32.IsWindowVisible(handle) && (extended & 0x80) == 0
                && Win32.GetWindowRect(handle, out var bounds) && bounds.Width > 0 && bounds.Height > 0)
                current.Add(handle);
            return true;
        }, 0);
        var result = new List<DiscoveredWindow>();
        foreach (var handle in current)
        {
            context.Check();
            try
            {
                Win32.GetWindowThreadProcessId(handle, out var pid);
                var process = Applications.Running(checked((int)pid));
                var entry = new DiscoveredWindow(new(handle), process);
                using var owner = Owner(entry, false, context);
                entry.Window.Geometry(owner, context);
                result.Add(entry);
            }
            catch (NativeFailure error) when (error.Code is "STALE_APP" or "PERMISSION_DENIED" or "APP_IDENTITY_UNAVAILABLE" or "UNSUPPORTED_SESSION" or "WINDOW_CHANGED")
            {
                // A disappearing or inaccessible window is omitted from discovery.
            }
        }
        return result;
    }

    private static AppState Owner(DiscoveredWindow entry, bool authorize, RequestContext context)
    {
        var window = entry.Window;
        var process = entry.Process;
        var length = Win32.GetWindowTextLength(window.Handle);
        if (length > context.Config.MaxResponseBytes) throw new NativeFailure("NATIVE_RESPONSE_LIMIT", "Window title exceeds the response limit");
        var title = new StringBuilder(length + 1);
        Win32.GetWindowText(window.Handle, title, title.Capacity);
        var name = $"Window: {title} ({process.Name})";
        // Shared consent IDs require a SHA-256 string, including non-persistable window grants.
        var id = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes($"window\0{entry.Selector}")));
        var identity = new ApplicationIdentity(id, name, process.Path, false);
        var app = new AppState(Guid.NewGuid().ToString("N"), identity, "", process);
        if (authorize)
        {
            app.SelectedWindow = window;
            app.Windows.Add(window.Handle, window);
        }
        return app;
    }
}
