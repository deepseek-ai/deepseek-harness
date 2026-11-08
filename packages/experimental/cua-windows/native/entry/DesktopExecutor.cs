// The shared Host policy authorizes handles before these platform operations execute.
using System.Globalization;
using System.Text.Json;
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal sealed class ClientState
{
    internal Dictionary<string, PreparedLaunch> Launches { get; } = new(StringComparer.Ordinal);
    internal Dictionary<string, AppState> Apps { get; } = new(StringComparer.Ordinal);
    internal AppState App(string handle) => Apps.GetValueOrDefault(handle)
        ?? throw new NativeFailure("STALE_APP", "Select the application again on this connection");
    internal void Clear() { foreach (var app in Apps.Values) app.Dispose(); Apps.Clear(); Launches.Clear(); }
}

internal sealed class DesktopExecutor(MtaDispatcher mta, StaDispatcher sta) : IAsyncDisposable
{
    private readonly WindowCapture capture = new();
    private readonly ClipboardPaste clipboard = new();
    private readonly SemaphoreSlim queue = new(1);

    private static object ActionResult(nint before) => new
    {
        dispatched = true,
        foregroundChanged = before == 0 || Win32.GetForegroundWindow() == 0 ? (bool?)null : before != Win32.GetForegroundWindow(),
    };
    private static string String(JsonElement value, string key) => value.GetProperty(key).GetString()!;
    private static string? OptionalString(JsonElement value, string key) => value.TryGetProperty(key, out var item) ? item.GetString() : null;
    private static bool Flag(JsonElement value, string key) => value.TryGetProperty(key, out var item) && item.GetBoolean();
    private static nint ParseWindowId(JsonElement value) => nint.TryParse(value.GetString(), CultureInfo.InvariantCulture, out var id)
        ? id : throw new NativeFailure("INVALID_ARGUMENT", "windowId is outside the native handle range");
    private static nint? WindowId(JsonElement value) => value.TryGetProperty("windowId", out var id) ? ParseWindowId(id) : null;
    private static string[] Modifiers(JsonElement value) => value.TryGetProperty("modifiers", out var items) ? items.EnumerateArray().Select(item => item.GetString()!).ToArray() : [];

    // Window-scoped operations act only on the window authorized at getApp; the request must name it.
    private static WindowState Selected(AppState app, JsonElement parameters, RequestContext context)
    {
        if (!parameters.TryGetProperty("windowId", out var raw))
            throw new NativeFailure("UNSUPPORTED", "This operation requires a window target; select a window with getApp and pass its windowId");
        var id = ParseWindowId(raw);
        var selected = app.SelectedWindow ?? throw new NativeFailure("APP_ACCESS_REQUIRED", "Select a window with getApp before this operation");
        if (selected.Id != id)
            throw new NativeFailure("WINDOW_CHANGED", "The request targets another window; select that window with getApp");
        selected.Geometry(app, context);
        return selected;
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
            if (request.Method == "permissionStatus") return DesktopSession.Status(false);
            if (request.Method == "applicationIcons") return await sta.Invoke(_ => Applications.Icons(parameters, context), cancellation);
            if (request.Method == "getCapabilities")
            {
                var locked = DesktopSession.Locked();
                return new { permissions = new { accessibility = locked == false,
                    screenRecording = false },
                    sessionLocked = locked };
            }
            if (request.Method is "requestPermission" or "openPermissionSettings")
                throw new NativeFailure("UNSUPPORTED", "Windows desktop access has no macOS permission switches; inspect the Windows session status");
            DesktopSession.RequireInteractive();
            if (request.Method == "listApps") return DesktopWindows.ListApps(context);
            if (request.Method == "findApps")
                throw new NativeFailure("UNSUPPORTED", "Windows discovers selectable windows with listApps; installed launch entries are not part of this selection");
            if (request.Method == "getApp")
            {
                var selected = DesktopWindows.Select(String(parameters, "selector"), context);
                state.Apps[selected.Handle] = selected;
                return new { appHandle = selected.Handle, pid = 4, name = selected.Authorization.Name,
                    running = true, authorization = selected.Authorization };
            }
            if (request.Method == "launchApp")
                throw new NativeFailure("UNSUPPORTED", "A selected Windows window cannot be launched; select an observed window from listApps");
            var app = state.App(String(parameters, "appHandle"));
            app.RequireProcess();
            var foreground = Win32.GetForegroundWindow();
            switch (request.Method)
            {
                case "listWindows": return Windows.Refresh(app, context).Select(window => window.Describe(app, context)).ToArray();
                case "getState":
                {
                    var target = Selected(app, parameters, context);
                    return await mta.Invoke(() => Accessibility.State(app, target.Id, parameters.GetProperty("maxElements").GetInt32(),
                        parameters.GetProperty("maxDepth").GetInt32(), Flag(parameters, "includeMenus"), Flag(parameters, "details"), context), cancellation);
                }
                case "activate": Windows.Activate(app, null, context); return ActionResult(foreground);
                case "show": return Windows.Show(app, WindowId(parameters), context);
                case "typeText":
                    Selected(app, parameters, context);
                    await Input.Type(app, String(parameters, "text"), context);
                    return ActionResult(foreground);
                case "pressKey":
                    Selected(app, parameters, context);
                    Input.Press(app, String(parameters, "key"), Modifiers(parameters), context);
                    return ActionResult(foreground);
                case "sendKeyEvent":
                    throw new NativeFailure("UNSUPPORTED", "Held key events are not supported on current platform.");
                case "paste":
                    Selected(app, parameters, context);
                    await clipboard.Paste(app, String(parameters, "text"), OptionalString(parameters, "format") ?? "text",
                        parameters.GetProperty("maxClipboardBytes").GetInt32(), parameters.GetProperty("pasteReadTimeoutMs").GetInt32(), context);
                    return ActionResult(foreground);
                case "mouseMove":
                {
                    if (parameters.TryGetProperty("elementId", out _))
                    {
                        var target = Selected(app, parameters, context);
                        return await mta.Invoke(() =>
                        {
                            var element = Accessibility.Element(app, String(parameters, "snapshotId"), String(parameters, "elementId"), context);
                            if (element.Window.Id != target.Id) throw new NativeFailure("WINDOW_CHANGED", "The element belongs to another window");
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
                    (WindowState Window, double X, double Y)? pointer = null;
                    if (parameters.TryGetProperty("elementId", out _))
                    {
                        await mta.Invoke(() =>
                        {
                            var element = Accessibility.Element(app, String(parameters, "snapshotId"), String(parameters, "elementId"), context);
                            if (element.Window.Id != target.Id) throw new NativeFailure("WINDOW_CHANGED", "The element belongs to another window");
                            if (!hold.HasValue && button == "left" && count == 1 && modifiers.Length == 0 && AccessibilityActions.Click(element, context)) return true;
                            var bounds = context.Ax(() => element.Element.Current.BoundingRectangle);
                            if (bounds.IsEmpty) throw new NativeFailure("UNSUPPORTED", "The element has no pointer bounds");
                            var geometry = element.Window.RequireObservation(app, context);
                            pointer = (element.Window, bounds.X + bounds.Width / 2 - geometry.Pixels.Left,
                                bounds.Y + bounds.Height / 2 - geometry.Pixels.Top);
                            return true;
                        }, cancellation);
                    }
                    else pointer = Coordinate(app, parameters, context);
                    if (pointer is { } targetPoint)
                    {
                        if (hold is { } held) await Input.HoldClick(app, targetPoint.Window, targetPoint.X, targetPoint.Y, button, count, modifiers, held, context);
                        else Input.Click(app, targetPoint.Window, targetPoint.X, targetPoint.Y, button, count, modifiers, context);
                    }
                    return ActionResult(foreground);
                }
                case "listActions":
                {
                    Selected(app, parameters, context);
                    return await mta.Invoke(() => AccessibilityActions.Actions(
                        Accessibility.Element(app, String(parameters, "snapshotId"), String(parameters, "elementId"), context), context), cancellation);
                }
                case "performAction":
                {
                    Selected(app, parameters, context);
                    var argument = parameters.TryGetProperty("argument", out var raw) ? raw : (JsonElement?)null;
                    await mta.Invoke(() =>
                    {
                        var element = Accessibility.Element(app, String(parameters, "snapshotId"), String(parameters, "elementId"), context);
                        AccessibilityActions.Perform(app, element, String(parameters, "action"), argument, context);
                        return true;
                    }, cancellation);
                    return ActionResult(foreground);
                }
                case "invoke":
                {
                    Selected(app, parameters, context);
                    var dispatched = await mta.Invoke(() => AccessibilityActions.Invoke(
                        Accessibility.Element(app, String(parameters, "snapshotId"), String(parameters, "elementId"), context), context), cancellation);
                    return new { dispatched };
                }
                case "setValue":
                {
                    Selected(app, parameters, context);
                    await mta.Invoke(() =>
                    {
                        var element = Accessibility.Element(app, String(parameters, "snapshotId"), String(parameters, "elementId"), context);
                        AccessibilityActions.SetValue(element, parameters.GetProperty("value"), context);
                        return true;
                    }, cancellation);
                    return ActionResult(foreground);
                }
                case "selectText":
                {
                    Selected(app, parameters, context);
                    await mta.Invoke(() =>
                    {
                        var element = Accessibility.Element(app, String(parameters, "snapshotId"), String(parameters, "elementId"), context);
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
