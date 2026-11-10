// Window state belongs to one exact application identity and revalidates its own process and AUMID.
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

internal sealed class WindowState(nint handle, int processId, long processStarted)
{
    internal nint Id => Handle;
    internal nint Handle { get; } = handle;
    internal int ProcessId { get; } = processId;
    internal long ProcessStarted { get; } = processStarted;
    private WindowGeometry? observation;

    internal void RequireCurrent(AppState app, RequestContext context)
    {
        context.Check();
        if (!Win32.IsWindow(Handle))
            throw Remove(app, "The selected window is no longer available; read fresh application state");
        var current = DesktopWindows.ResolveWindow(Handle, context);
        if (current is null)
            throw Remove(app, "The selected window is no longer available; read fresh application state");
        if (!string.Equals(app.AppId, current.AppId, StringComparison.Ordinal)
            || ProcessId != current.ProcessId || ProcessStarted != current.ProcessStarted)
            throw Remove(app, "The selected window no longer belongs to the authorized application; read fresh application state");
    }

    // A stale window and its snapshots must not remain selectable after a direct operation detects the change.
    private NativeFailure Remove(AppState app, string message)
    {
        if (app.Windows.TryGetValue(Handle, out var current) && ReferenceEquals(current, this))
        {
            app.Windows.Remove(Handle);
            app.Snapshots.Remove(Handle);
        }
        return new NativeFailure("WINDOW_CHANGED", message);
    }

    internal WindowGeometry Geometry(AppState app, RequestContext context)
    {
        context.Check();
        RequireCurrent(app, context);
        return TryGeometry(out var geometry)
            ? geometry
            : throw new NativeFailure("WINDOW_CHANGED", "The selected window geometry is unavailable; read fresh application state");
    }

    private bool TryGeometry(out WindowGeometry geometry)
    {
        geometry = default;
        if (Win32.DwmGetWindowAttribute(Handle, 9, out Win32.Rect rectangle, Marshal.SizeOf<Win32.Rect>()) != 0
            && !Win32.GetWindowRect(Handle, out rectangle)) return false;
        var dpi = Win32.GetDpiForWindow(Handle);
        if (dpi == 0 || rectangle.Width <= 0 || rectangle.Height <= 0) return false;
        geometry = new(rectangle, dpi);
        return true;
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
        RequireCurrent(app, context);
        // A minimized or cloaked window may lack usable capture geometry; keep listing its association.
        var bounds = TryGeometry(out var geometry) ? geometry.Bounds : observation?.Bounds ?? new Bounds(0, 0, 0, 0);
        var length = Win32.GetWindowTextLength(Handle);
        if (length > context.Config.MaxResponseBytes) throw new NativeFailure("NATIVE_RESPONSE_LIMIT", "The window title exceeds the response limit");
        var title = new StringBuilder(length + 1);
        Win32.GetWindowText(Handle, title, title.Capacity);
        return new
        {
            windowId = Id.ToString(CultureInfo.InvariantCulture), pid = 4, appName = app.Name,
            title = title.ToString(), bounds, isOnScreen = IsOnScreen(Handle), onCurrentSpace = (bool?)null,
        };
    }

    internal static bool IsOnScreen(nint handle) => Win32.IsWindowVisible(handle) && !Win32.IsIconic(handle)
        && (Win32.DwmGetWindowAttribute(handle, 14, out int cloaked, sizeof(int)) != 0 || cloaked == 0);
}

internal static class Windows
{
    internal static WindowState[] Refresh(AppState app, RequestContext context)
    {
        var observation = DesktopWindows.Observe(context);
        var current = new Dictionary<nint, WindowState>();
        var added = new List<WindowState>();
        foreach (var window in observation.Windows)
        {
            if (!string.Equals(window.AppId, app.AppId, StringComparison.Ordinal)) continue;
            if (app.Windows.TryGetValue(window.Handle, out var existing)
                && existing.ProcessId == window.ProcessId && existing.ProcessStarted == window.ProcessStarted)
                current[window.Handle] = existing;
            else
            {
                var state = new WindowState(window.Handle, window.ProcessId, window.ProcessStarted);
                current[window.Handle] = state;
                added.Add(state);
            }
        }
        foreach (var pair in app.Windows.ToArray())
        {
            if (current.TryGetValue(pair.Key, out var kept) && ReferenceEquals(kept, pair.Value)) continue;
            app.Windows.Remove(pair.Key);
            app.Snapshots.Remove(pair.Key);
        }
        foreach (var window in added) app.Windows[window.Handle] = window;
        return current.Values.OrderBy(window => (long)window.Handle).ToArray();
    }

    internal static WindowState Resolve(AppState app, nint id, RequestContext context)
    {
        if (app.Windows.TryGetValue(id, out var known))
        {
            // A known target is revalidated in place; a changed or closed one is removed, never switched.
            known.Geometry(app, context);
            return known;
        }
        context.Check();
        if (!DesktopWindows.Eligible(id))
            throw new NativeFailure("WINDOW_CHANGED", "Select a current window from getWindows");
        var observed = DesktopWindows.ResolveWindow(id, context);
        if (observed is null || !string.Equals(observed.AppId, app.AppId, StringComparison.Ordinal))
            throw new NativeFailure("WINDOW_CHANGED", "The window does not belong to the authorized application; read fresh application state");
        // A newly appeared explicit window may join the application; no default target is inferred.
        app.Snapshots.Remove(id);
        var window = new WindowState(observed.Handle, observed.ProcessId, observed.ProcessStarted);
        app.Windows[id] = window;
        return window;
    }

    // A sibling window that disappears during enumeration is omitted with its snapshots; a direct
    // selected target still fails through Resolve with a structured error.
    internal static (object[] Values, WindowState[] Windows) DescribeAll(AppState app, WindowState[] windows,
        RequestContext context)
    {
        var described = new List<object>();
        var surviving = new List<WindowState>();
        foreach (var window in windows)
        {
            context.Check();
            try
            {
                described.Add(window.Describe(app, context));
                surviving.Add(window);
            }
            catch (NativeFailure error) when (error.Code is "WINDOW_CHANGED" or "PERMISSION_DENIED")
            {
                if (app.Windows.TryGetValue(window.Handle, out var current) && ReferenceEquals(current, window))
                {
                    app.Windows.Remove(window.Handle);
                    app.Snapshots.Remove(window.Handle);
                }
            }
        }
        return (described.ToArray(), surviving.ToArray());
    }

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
        var onScreen = windows.Where(window => WindowState.IsOnScreen(window.Handle)).ToArray();
        var focused = Focused(app, onScreen);
        if (focused is not null) return focused;
        if (onScreen.Length == 1) return onScreen[0];
        if (onScreen.Length == 0 && windows.Length <= 1) return windows.SingleOrDefault();
        throw new NativeFailure("AMBIGUOUS_WINDOW", "Select a window explicitly from getWindows");
    }

    internal static object Show(AppState app, nint? id, RequestContext context)
    {
        var target = id is { } selected
            ? Resolve(app, selected, context)
            : (Default(app, Refresh(app, context)) ?? throw new NativeFailure("WINDOW_NOT_FOUND", "The application has no window to show"));
        var before = Win32.GetForegroundWindow();
        target.Geometry(app, context);
        if (!Win32.ShowWindowAsync(target.Handle, 4)) throw new NativeFailure("UNSUPPORTED", "Windows refused background restoration; explicitly activate the application if needed");
        var after = Win32.GetForegroundWindow();
        return new { dispatched = true, windowId = target.Id.ToString(CultureInfo.InvariantCulture),
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

    internal static void RequireForeground(AppState app, WindowState target, RequestContext context)
    {
        context.Check();
        DesktopSession.RequireInteractive();
        target.Geometry(app, context);
        var foreground = Win32.GetForegroundWindow();
        Win32.GetWindowThreadProcessId(foreground, out var pid);
        if (pid != (uint)target.ProcessId || Win32.GetAncestor(foreground, 2) != target.Handle)
            throw new NativeFailure("FOREGROUND_REQUIRED", "This input needs the target in front; explain why, explicitly activate or raise it, then observe again");
    }
}
