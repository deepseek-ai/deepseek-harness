// The shared Host policy authorizes handles before these platform operations execute.
using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal sealed class ClientState
{
    internal Dictionary<string, AppState> Apps { get; } = new(StringComparer.Ordinal);
    internal AppState App(string handle) => Apps.GetValueOrDefault(handle)
        ?? throw new NativeFailure("STALE_APP", "Select the application again on this connection");
    internal void Clear() { foreach (var app in Apps.Values) app.Dispose(); Apps.Clear(); }
}

internal sealed class DesktopExecutor(MtaDispatcher mta, StaDispatcher sta) : IAsyncDisposable
{
    private readonly WindowCapture capture = new();
    private readonly ClipboardPaste clipboard = new();
    private readonly SemaphoreSlim queue = new(1);

    private static object ActionResult(nint before, bool dispatched = true) => new
    {
        dispatched,
        foregroundChanged = before == 0 || Win32.GetForegroundWindow() == 0 ? (bool?)null : before != Win32.GetForegroundWindow(),
    };
    private static string String(JsonElement value, string key) => value.GetProperty(key).GetString()!;
    private static string? OptionalString(JsonElement value, string key) => value.TryGetProperty(key, out var item) ? item.GetString() : null;
    private static bool Flag(JsonElement value, string key) => value.TryGetProperty(key, out var item) && item.GetBoolean();
    private static nint ParseWindowId(JsonElement value) => nint.TryParse(value.GetString(), CultureInfo.InvariantCulture, out var id)
        ? id : throw new NativeFailure("INVALID_ARGUMENT", "windowId is outside the native handle range");
    private static nint? WindowId(JsonElement value) => value.TryGetProperty("windowId", out var id) ? ParseWindowId(id) : null;
    private static string[] Modifiers(JsonElement value) => value.TryGetProperty("modifiers", out var items) ? items.EnumerateArray().Select(item => item.GetString()!).ToArray() : [];

    // Window-scoped operations revalidate the explicit target against the authorized exact AUMID.
    private static WindowState Selected(AppState app, JsonElement parameters, RequestContext context)
    {
        if (!parameters.TryGetProperty("windowId", out var raw))
            throw new NativeFailure("UNSUPPORTED", "This operation requires a window target; select a window with getWindows and pass its windowId");
        return Windows.Resolve(app, ParseWindowId(raw), context);
    }

    private static (WindowState Window, double X, double Y) Coordinate(AppState app, JsonElement parameters, RequestContext context)
    {
        var window = Selected(app, parameters, context);
        if (OptionalString(parameters, "snapshotId") is { } snapshot) Accessibility.RequireSnapshot(app, snapshot, window.Id);
        return (window, parameters.GetProperty("x").GetDouble(), parameters.GetProperty("y").GetDouble());
    }

    internal async Task<object> Execute(NativeRequest request, ClientState state, NativeConfig config, CancellationToken cancellation)
    {
        if (request.Method == "screenshot")
        {
            var context = new RequestContext(config, cancellation, mta, sta);
            AppState app;
            WindowState window;
            await queue.WaitAsync(cancellation);
            try
            {
                DesktopSession.RequireInteractive();
                app = state.App(String(request.Params, "appHandle"));
                window = Selected(app, request.Params, context);
            }
            finally { queue.Release(); }
            return await capture.Capture(app, window, context);
        }
        await queue.WaitAsync(cancellation);
        try
        {
            var context = new RequestContext(config, cancellation, mta, sta);
            context.Check();
            var parameters = request.Params;
            if (request.Method == "permissionStatus") return DesktopSession.Status(WindowCapture.IsSupported);
            if (request.Method == "applicationIcons") return await sta.Invoke(_ => Applications.Icons(parameters, context), cancellation);
            if (request.Method == "getCapabilities")
            {
                var locked = DesktopSession.Locked();
                return new { permissions = new { accessibility = locked == false,
                    screenRecording = locked == false && WindowCapture.IsSupported },
                    sessionLocked = locked };
            }
            if (request.Method is "requestPermission" or "openPermissionSettings")
                throw new NativeFailure("UNSUPPORTED", "Windows desktop access has no macOS permission switches; inspect the Windows session status");
            DesktopSession.RequireInteractive();
            if (request.Method == "listApps") return await DesktopWindows.ListApps(context);
            if (request.Method == "findApps")
                throw new NativeFailure("UNSUPPORTED", "Windows discovers selectable applications with listApps");
            if (request.Method == "getApp")
            {
                var selected = await DesktopWindows.Select(String(parameters, "selector"), context);
                state.Apps[selected.Handle] = selected;
                return new { appHandle = selected.Handle, pid = 4, name = selected.Name,
                    running = selected.IsRunning, authorization = selected.Authorization };
            }
            var app = state.App(String(parameters, "appHandle"));
            var foreground = Win32.GetForegroundWindow();
            switch (request.Method)
            {
                case "launchApp":
                {
                    var before = Windows.Refresh(app, context)
                        .Select(window => (window.Handle, window.ProcessId, window.ProcessStarted)).ToHashSet();
                    await sta.Invoke(() => ShellBroker.Launch(Path.IsPathFullyQualified(app.AppId)
                        ? app.AppId : @"shell:AppsFolder\" + app.AppId), cancellation);
                    var elapsed = Stopwatch.StartNew();
                    WindowState[] windows;
                    while (true)
                    {
                        windows = Windows.Refresh(app, context);
                        if (!before.SetEquals(windows.Select(window => (window.Handle, window.ProcessId, window.ProcessStarted)))) break;
                        var remaining = config.LaunchWaitMs - elapsed.ElapsedMilliseconds;
                        if (remaining <= 0) break;
                        await Task.Delay((int)Math.Min(config.PollIntervalMs, remaining), cancellation);
                    }
                    context.Check();
                    return new { appHandle = app.Handle, pid = 4, name = app.Name, running = windows.Length != 0 };
                }
                case "listWindows":
                    return Windows.DescribeAll(app, Windows.Refresh(app, context), context).Values;
                case "getState":
                {
                    var target = Selected(app, parameters, context);
                    return await mta.Invoke(() => Accessibility.State(app, target.Id, parameters.GetProperty("maxElements").GetInt32(),
                        parameters.GetProperty("maxDepth").GetInt32(), Flag(parameters, "includeMenus"), Flag(parameters, "details"), context), cancellation);
                }
                case "activate": Windows.Activate(app, null, context); return ActionResult(foreground);
                case "show": return Windows.Show(app, WindowId(parameters), context);
                case "typeText":
                {
                    var target = Selected(app, parameters, context);
                    await Input.Type(app, target, String(parameters, "text"), context);
                    return ActionResult(foreground);
                }
                case "pressKey":
                {
                    var target = Selected(app, parameters, context);
                    Input.Press(app, target, String(parameters, "key"), Modifiers(parameters), context);
                    return ActionResult(foreground);
                }
                case "sendKeyEvent":
                {
                    var target = Selected(app, parameters, context);
                    var dispatched = Input.KeyEvent(app, target, String(parameters, "key"), String(parameters, "direction"), context);
                    return ActionResult(foreground, dispatched);
                }
                case "paste":
                {
                    var target = Selected(app, parameters, context);
                    await clipboard.Paste(app, target, String(parameters, "text"), OptionalString(parameters, "format") ?? "text",
                        parameters.GetProperty("maxClipboardBytes").GetInt32(), parameters.GetProperty("pasteReadTimeoutMs").GetInt32(), context);
                    return ActionResult(foreground);
                }
                case "mouseMove":
                {
                    var target = Selected(app, parameters, context);
                    if (parameters.TryGetProperty("elementId", out _))
                    {
                        return await mta.Invoke(() =>
                        {
                            var element = Accessibility.Element(app, target, String(parameters, "snapshotId"), String(parameters, "elementId"), context);
                            var bounds = context.Ax(() => element.Element.Current.BoundingRectangle);
                            if (bounds.IsEmpty) throw new NativeFailure("UNSUPPORTED", "The element has no pointer bounds");
                            var geometry = element.Window.RequireObservation(app, context);
                            return Input.MouseMove(app, element.Window, (bounds.X + bounds.Width / 2 - geometry.Pixels.Left),
                                (bounds.Y + bounds.Height / 2 - geometry.Pixels.Top), context);
                        }, cancellation);
                    }
                    var pointed = Coordinate(app, parameters, context);
                    return Input.MouseMove(app, pointed.Window, pointed.X, pointed.Y, context);
                }
                case "scroll":
                {
                    var target = Coordinate(app, parameters, context);
                    Input.Scroll(app, target.Window, target.X, target.Y, parameters.GetProperty("deltaLinesX").GetInt32(),
                        parameters.GetProperty("deltaLinesY").GetInt32(), context);
                    return ActionResult(foreground);
                }
                case "drag":
                {
                    var target = Selected(app, parameters, context);
                    if (OptionalString(parameters, "snapshotId") is { } snapshot) Accessibility.RequireSnapshot(app, snapshot, target.Id);
                    await Input.Drag(app, target, parameters.GetProperty("fromX").GetDouble(),
                        parameters.GetProperty("fromY").GetDouble(), parameters.GetProperty("toX").GetDouble(), parameters.GetProperty("toY").GetDouble(),
                        OptionalString(parameters, "mouseButton") ?? "left", Modifiers(parameters), parameters.GetProperty("durationMs").GetInt32(),
                        parameters.GetProperty("steps").GetInt32(), context);
                    return ActionResult(foreground);
                }
                case "click":
                {
                    var target = Selected(app, parameters, context);
                    int? hold = null;
                    if (parameters.TryGetProperty("holdMs", out var duration))
                    {
                        if (!duration.TryGetInt32(out var value) || value > config.MaxClickHoldMs)
                            throw new NativeFailure("INVALID_ARGUMENT", "The requested click exceeds maxClickHoldMs");
                        hold = value;
                    }
                    var button = OptionalString(parameters, "mouseButton") ?? "left";
                    var count = parameters.TryGetProperty("clickCount", out var clickCount) ? clickCount.GetInt32() : 1;
                    var modifiers = Modifiers(parameters);
                    (WindowState Window, double X, double Y) pointer;
                    if (parameters.TryGetProperty("elementId", out _))
                    {
                        pointer = await mta.Invoke(() =>
                        {
                            var element = Accessibility.Element(app, target, String(parameters, "snapshotId"), String(parameters, "elementId"), context);
                            var bounds = context.Ax(() => element.Element.Current.BoundingRectangle);
                            if (bounds.IsEmpty) throw new NativeFailure("UNSUPPORTED", "The element has no pointer bounds");
                            var geometry = element.Window.RequireObservation(app, context);
                            return (element.Window, bounds.X + bounds.Width / 2 - geometry.Pixels.Left,
                                bounds.Y + bounds.Height / 2 - geometry.Pixels.Top);
                        }, cancellation);
                    }
                    else pointer = Coordinate(app, parameters, context);
                    if (hold is { } held) await Input.HoldClick(app, pointer.Window, pointer.X, pointer.Y, button, count, modifiers, held, context);
                    else Input.Click(app, pointer.Window, pointer.X, pointer.Y, button, count, modifiers, context);
                    return ActionResult(foreground);
                }
                case "listActions":
                {
                    var target = Selected(app, parameters, context);
                    return await mta.Invoke(() => AccessibilityActions.Actions(
                        Accessibility.Element(app, target, String(parameters, "snapshotId"), String(parameters, "elementId"), context), context), cancellation);
                }
                case "performAction":
                {
                    var target = Selected(app, parameters, context);
                    var argument = parameters.TryGetProperty("argument", out var raw) ? raw : (JsonElement?)null;
                    await mta.Invoke(() =>
                    {
                        var element = Accessibility.Element(app, target, String(parameters, "snapshotId"), String(parameters, "elementId"), context);
                        AccessibilityActions.Perform(element, String(parameters, "action"), argument, context);
                        return true;
                    }, cancellation);
                    return ActionResult(foreground);
                }
                case "invoke":
                {
                    var target = Selected(app, parameters, context);
                    var dispatched = await mta.Invoke(() => AccessibilityActions.Invoke(
                        Accessibility.Element(app, target, String(parameters, "snapshotId"), String(parameters, "elementId"), context), context), cancellation);
                    return new { dispatched };
                }
                case "setValue":
                {
                    var target = Selected(app, parameters, context);
                    await mta.Invoke(() =>
                    {
                        var element = Accessibility.Element(app, target, String(parameters, "snapshotId"), String(parameters, "elementId"), context);
                        AccessibilityActions.SetValue(element, parameters.GetProperty("value"), context);
                        return true;
                    }, cancellation);
                    return ActionResult(foreground);
                }
                case "selectText":
                {
                    var target = Selected(app, parameters, context);
                    await mta.Invoke(() =>
                    {
                        var element = Accessibility.Element(app, target, String(parameters, "snapshotId"), String(parameters, "elementId"), context);
                        AccessibilityActions.SelectText(element, String(parameters, "text"), OptionalString(parameters, "prefix"), OptionalString(parameters, "suffix"),
                            OptionalString(parameters, "selectionType") ?? "text", context);
                        return true;
                    }, cancellation);
                    return ActionResult(foreground);
                }
                default: throw new NativeFailure("UNSUPPORTED", "Unknown native CUA operation");
            }
        }
        finally { queue.Release(); }
    }

    public ValueTask DisposeAsync()
    {
        queue.Dispose();
        return default;
    }
}
