// Window state retains HWND values; JSON exposes them as invariant decimal strings.
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal readonly record struct Bounds(double X, double Y, double Width, double Height);
internal readonly record struct WindowGeometry(Win32.Rect Pixels, uint Dpi)
{
    internal Bounds Bounds => new(Pixels.Left, Pixels.Top, Pixels.Width, Pixels.Height);
}

internal sealed class WindowState(nint handle)
{
    internal nint Id => Handle;
    internal nint Handle { get; } = handle;
    private WindowGeometry? observation;

    internal WindowGeometry Geometry(AppState app, RequestContext context)
    {
        context.Check();
        app.RequireProcess();
        if (!Win32.IsWindow(Handle))
            throw new NativeFailure("WINDOW_CHANGED", "The selected window is no longer available; read fresh application state");
        if (Win32.DwmGetWindowAttribute(Handle, 9, out Win32.Rect rectangle, Marshal.SizeOf<Win32.Rect>()) != 0
            && !Win32.GetWindowRect(Handle, out rectangle)) throw new NativeFailure("WINDOW_CHANGED", "The selected window geometry is unavailable");
        var dpi = Win32.GetDpiForWindow(Handle);
        if (dpi == 0 || rectangle.Width <= 0 || rectangle.Height <= 0)
            throw new NativeFailure("WINDOW_CHANGED", "The selected window has no usable bounds");
        return new(rectangle, dpi);
    }

    internal void Observe(WindowGeometry value) => observation = value;

    internal WindowGeometry RequireObservation(AppState app, RequestContext context)
    {
        var current = Geometry(app, context);
        if (observation is not { } previous) throw new NativeFailure("OBSERVATION_REQUIRED", "Read AX state or capture this window before using coordinates");
        if (current.Pixels.Width != previous.Pixels.Width || current.Pixels.Height != previous.Pixels.Height || current.Dpi != previous.Dpi)
            throw new NativeFailure("WINDOW_CHANGED", "The window size or display scale changed; read fresh state before input");
        return current;
    }

    internal static Win32.Point Point(WindowGeometry geometry, double x, double y)
    {
        if (!double.IsFinite(x) || !double.IsFinite(y) || x < 0 || y < 0 || x >= geometry.Bounds.Width || y >= geometry.Bounds.Height)
            throw new NativeFailure("INVALID_ARGUMENT", "Coordinates must be inside the observed window");
        return new()
        {
            X = geometry.Pixels.Left + Math.Min(geometry.Pixels.Width - 1, (int)Math.Round(x)),
            Y = geometry.Pixels.Top + Math.Min(geometry.Pixels.Height - 1, (int)Math.Round(y)),
        };
    }

    internal object Describe(AppState app, RequestContext context)
    {
        var geometry = Geometry(app, context);
        var length = Win32.GetWindowTextLength(Handle);
        if (length > context.Config.MaxResponseBytes) throw new NativeFailure("NATIVE_RESPONSE_LIMIT", "The window title exceeds the response limit");
        var title = new StringBuilder(length + 1);
        Win32.GetWindowText(Handle, title, title.Capacity);
        return new
        {
            windowId = Id.ToString(CultureInfo.InvariantCulture), pid = 4, appName = app.RequireProcess().Name,
            title = title.ToString(), bounds = geometry.Bounds, isOnScreen = IsOnScreen(), onCurrentSpace = (bool?)null,
        };
    }

    internal bool IsOnScreen() => Win32.IsWindowVisible(Handle) && !Win32.IsIconic(Handle)
        && (Win32.DwmGetWindowAttribute(Handle, 14, out int cloaked, sizeof(int)) != 0 || cloaked == 0);
}

internal static class Windows
{
    internal static WindowState[] Refresh(AppState app, RequestContext context)
    {
        var process = app.RequireProcess();
        if (app.SelectedWindow is { } selected) { selected.Geometry(app, context); return [selected]; }
        var handles = new List<nint>();
        Win32.EnumWindows((window, _) =>
        {
            Win32.GetWindowThreadProcessId(window, out var pid);
            var style = Win32.GetWindowLongPtr(window, -16).ToInt64();
            var extended = Win32.GetWindowLongPtr(window, -20).ToInt64();
            if (pid == process.Pid && (extended & 0x80) == 0
                && (Win32.IsWindowVisible(window) || (style & 0x00C00000) == 0x00C00000)
                && Win32.GetWindowRect(window, out var bounds) && bounds.Width > 0 && bounds.Height > 0) handles.Add(window);
            return true;
        }, 0);
        foreach (var pair in app.Windows.ToArray())
        {
            if (handles.Contains(pair.Key)) continue;
            app.Windows.Remove(pair.Key);
            foreach (var scope in app.Snapshots.Where(item => item.Value.Windows.Any(window => window.Id == pair.Value.Id)).Select(item => item.Key).ToArray())
                app.Snapshots.Remove(scope);
        }
        foreach (var handle in handles)
        {
            if (!app.Windows.ContainsKey(handle))
            {
                app.Windows.Add(handle, new(handle));
            }
        }
        return handles.Select(handle => app.Windows[handle]).ToArray();
    }

    internal static WindowState Resolve(AppState app, nint id, RequestContext context) => Refresh(app, context)
        .SingleOrDefault(window => window.Id == id) ?? throw new NativeFailure("WINDOW_CHANGED", "Select a current window from getWindows");

    internal static WindowState? Focused(AppState app, WindowState[] windows)
    {
        var foreground = Win32.GetAncestor(Win32.GetForegroundWindow(), 2);
        var front = windows.FirstOrDefault(window => window.Handle == foreground);
        if (front is not null) return front;
        var roots = new HashSet<nint>();
        foreach (var thread in windows.Select(window => Win32.GetWindowThreadProcessId(window.Handle, out _)).Distinct())
        {
            var info = new Win32.GuiThreadInfo { Size = (uint)Marshal.SizeOf<Win32.GuiThreadInfo>() };
            if (Win32.GetGUIThreadInfo(thread, ref info))
            {
                var focused = Win32.GetAncestor(info.Focus != 0 ? info.Focus : info.Active, 2);
                if (focused != 0) roots.Add(focused);
            }
        }
        var matches = windows.Where(window => roots.Contains(window.Handle)).ToArray();
        return matches.Length == 1 ? matches[0] : null;
    }

    internal static WindowState? Default(AppState app, WindowState[] windows)
    {
        var visible = windows.Where(window => window.IsOnScreen()).ToArray();
        var focused = Focused(app, visible);
        if (focused is not null) return focused;
        if (visible.Length == 1) return visible[0];
        if (visible.Length == 0 && windows.Length <= 1) return windows.SingleOrDefault();
        throw new NativeFailure("AMBIGUOUS_WINDOW", "Select a window explicitly from getWindows");
    }

    internal static object Show(AppState app, nint? id, RequestContext context)
    {
        var target = id is { } selected ? Resolve(app, selected, context) : Default(app, Refresh(app, context));
        var before = Win32.GetForegroundWindow();
        if (target is not null)
        {
            target.Geometry(app, context);
            if (!Win32.ShowWindowAsync(target.Handle, 4)) throw new NativeFailure("UNSUPPORTED", "Windows refused background restoration; explicitly activate the application if needed");
        }
        var after = Win32.GetForegroundWindow();
        return new { dispatched = true, windowId = target?.Id.ToString(CultureInfo.InvariantCulture),
            foregroundChanged = before == 0 || after == 0 ? (bool?)null : before != after };
    }

    internal static void Activate(AppState app, WindowState? target, RequestContext context)
    {
        target ??= Default(app, Refresh(app, context)) ?? throw new NativeFailure("WINDOW_NOT_FOUND", "The application has no window to activate");
        target.Geometry(app, context);
        if (Win32.IsIconic(target.Handle)) Win32.ShowWindowAsync(target.Handle, 9);
        if (Win32.GetForegroundWindow() != target.Handle && !Win32.SetForegroundWindow(target.Handle))
            throw new NativeFailure("FOREGROUND_DENIED", "Windows refused foreground access; ask the user to focus the target window");
    }

    internal static void RequireForeground(AppState app, WindowState? target, RequestContext context)
    {
        context.Check();
        DesktopSession.RequireInteractive();
        target ??= app.SelectedWindow;
        target?.Geometry(app, context);
        var foreground = Win32.GetForegroundWindow();
        Win32.GetWindowThreadProcessId(foreground, out var pid);
        if (pid != app.RequireProcess().Pid || target is not null && Win32.GetAncestor(foreground, 2) != target.Handle)
            throw new NativeFailure("FOREGROUND_REQUIRED", "This input needs the target in front; explain why, explicitly activate or raise it, then observe again");
    }
}
