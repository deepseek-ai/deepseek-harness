// Discovery IDs are connection-owned and never reused for another HWND lifetime.
using System.Security.Cryptography;
using System.Text;
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal sealed record DiscoveredWindow(WindowState Window, RunningApplication Process, string Selector);

internal sealed class DesktopWindows
{
    private readonly Dictionary<nint, DiscoveredWindow> windows = [];
    private uint nextId;

    internal object[] ListApps(RequestContext context)
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
                // A disappearing window cannot remain selectable from this connection.
                windows.Remove(entry.Window.Handle);
            }
        }
        return result.ToArray();
    }

    internal AppState Select(string selector, RequestContext context)
    {
        if (string.IsNullOrEmpty(selector)) throw new NativeFailure("INVALID_ARGUMENT", "A window selector from listApps is required");
        Discover(context);
        var entry = windows.Values.SingleOrDefault(value => string.Equals(value.Selector, selector, StringComparison.Ordinal))
            ?? throw new NativeFailure("WINDOW_CHANGED", "Discover applications again; this window selector belongs to another connection or an expired window");
        var app = Owner(entry, true, context);
        try { entry.Window.Geometry(app, context); return app; }
        catch { app.Dispose(); throw; }
    }

    private List<DiscoveredWindow> Discover(RequestContext context)
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
                var epoch = context.Sta.WindowEpoch(handle);
                if (!windows.TryGetValue(handle, out var entry) || entry.Process.Pid != process.Pid
                    || entry.Process.Started != process.Started || entry.Window.Epoch != epoch)
                {
                    if (nextId == uint.MaxValue) throw new NativeFailure("NATIVE_LIMIT", "Reconnect before discovering more windows");
                    entry = new(new(++nextId, handle, epoch), process, Guid.NewGuid().ToString("N"));
                    windows[handle] = entry;
                }
                using var owner = Owner(entry, false, context);
                entry.Window.Geometry(owner, context);
                result.Add(entry);
            }
            catch (NativeFailure error) when (error.Code is "STALE_APP" or "PERMISSION_DENIED" or "APP_IDENTITY_UNAVAILABLE" or "UNSUPPORTED_SESSION" or "WINDOW_CHANGED")
            {
                // A disappearing or inaccessible window cannot be selected from this discovery.
                windows.Remove(handle);
            }
        }
        foreach (var handle in windows.Keys.Where(handle => !current.Contains(handle)).ToArray()) windows.Remove(handle);
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
        var id = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(
            $"window\0{process.Pid}\0{process.Started}\0{window.Handle}\0{window.Epoch}")));
        var identity = new ApplicationIdentity(id, name, process.Path, false);
        var app = new AppState(Guid.NewGuid().ToString("N"), identity, "", process);
        if (authorize)
        {
            var selected = new WindowState(window.Id, window.Handle, window.Epoch);
            app.SelectedWindow = selected;
            app.Windows.Add(window.Handle, selected);
        }
        return app;
    }
}
