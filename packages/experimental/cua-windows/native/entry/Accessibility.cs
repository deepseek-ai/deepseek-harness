// One traversal owns both the disclosed RuntimeIds and their retained UI Automation elements.
using System.Globalization;
using System.Text;
using System.Windows.Automation;
using System.Windows.Automation.Text;
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal sealed record ElementReference(AutomationElement Element, WindowState Window);
internal sealed record Snapshot(string Id, nint Scope, WindowState[] Windows, IReadOnlyDictionary<string, ElementReference> Elements);

internal static class Accessibility
{
    private static readonly AutomationProperty[] Properties = [
        AutomationElement.ControlTypeProperty, AutomationElement.NameProperty, AutomationElement.HelpTextProperty,
        AutomationElement.AutomationIdProperty, AutomationElement.IsEnabledProperty,
        AutomationElement.HasKeyboardFocusProperty, AutomationElement.IsPasswordProperty,
        AutomationElement.BoundingRectangleProperty,
        ValuePattern.ValueProperty, ValuePattern.IsReadOnlyProperty,
        RangeValuePattern.ValueProperty, RangeValuePattern.IsReadOnlyProperty, SelectionItemPattern.IsSelectedProperty,
        TogglePattern.ToggleStateProperty, ExpandCollapsePattern.ExpandCollapseStateProperty,
    ];

    internal static object State(AppState app, nint selected, int maximumElements, int maximumDepth,
        bool includeMenus, bool details, bool showDiff, WindowNotifications? notifications, RequestContext context)
    {
        var all = Windows.Refresh(app, context);
        var target = Windows.Resolve(app, selected, context);
        if (!all.Any(window => window.Id == target.Id)) all = [.. all, target];
        var targets = new[] { target };
        var previous = app.Snapshots.GetValueOrDefault(selected);
        NotificationBatch? batch = null;
        var eventRows = new Dictionary<string, string?>(StringComparer.Ordinal);
        if (!showDiff && notifications != null) context.Ax(() => { notifications.Stop(); return true; });
        var rows = new List<string>();
        var elements = new Dictionary<string, ElementReference>(StringComparer.Ordinal);
        var cache = new CacheRequest { AutomationElementMode = AutomationElementMode.Full, TreeScope = TreeScope.Element };
        foreach (var property in Properties.Concat(PatternActions.Patterns.Select(pattern => pattern.Available))) cache.Add(property);
        var bytes = 0;
        void Add(string row)
        {
            bytes += Encoding.UTF8.GetByteCount(row) + (rows.Count == 0 ? 0 : 1);
            if (bytes > context.Config.MaxResponseBytes) throw new NativeFailure("NATIVE_RESPONSE_LIMIT", "Accessibility text exceeds the response limit; select a narrower window or reduce traversal limits");
            rows.Add(row);
        }
        var geometry = target.Geometry(app, context);
        var source = new AccessibilitySource<AutomationElement>(
            element => WindowNotifications.Id(context.Ax(element.GetRuntimeId))
                ?? throw new NativeFailure("STALE_SNAPSHOT", "An element has no RuntimeId; read fresh state"),
            element => Read(element, target, geometry, context),
            element => context.Ax(() => TreeWalker.ControlViewWalker.GetFirstChild(element, cache)),
            element => context.Ax(() => TreeWalker.ControlViewWalker.GetNextSibling(element, cache)),
            error => error is ElementNotAvailableException,
            context.Check);
        var traversal = new AccessibilityTraversal<AutomationElement>(source, maximumElements, maximumDepth, includeMenus, details, Add,
            (runtimeId, element, row) =>
            {
                elements.Add(runtimeId, new(element, target));
                if (eventRows.ContainsKey(runtimeId)) eventRows[runtimeId] = row[2..];
            });
        try
        {
            var root = context.Ax(() => AutomationElement.FromHandle(target.Handle).GetUpdatedCache(cache));
            if (showDiff)
            {
                batch = context.Ax(() => notifications!.Begin(root,
                    new(target, maximumElements, maximumDepth, includeMenus, details), previous?.Id, Properties));
                if (batch?.Notices is { } notices)
                    foreach (var notice in notices)
                        if (notice.Id is { } id) eventRows.TryAdd(id, null);
            }
            traversal.Walk(root);
        }
        catch (ElementNotAvailableException) { throw new NativeFailure("STALE_SNAPSHOT", "The window's accessibility root disappeared; read fresh state without repeating input"); }
        var after = target.Geometry(app, context);
        if (after.Pixels.Width != geometry.Pixels.Width || after.Pixels.Height != geometry.Pixels.Height || after.Dpi != geometry.Dpi)
            throw new NativeFailure("WINDOW_CHANGED", "The window changed during AX observation; read fresh state");
        var truncated = traversal.Truncated;
        var hasUnreadableElements = traversal.HasUnreadableElements;
        // A partial tree is shown in full and never becomes the baseline of a later diff.
        var complete = !truncated && !hasUnreadableElements;
        if (truncated) Add($"[truncated: maxElements={maximumElements}, maxDepth={maximumDepth}]");
        DesktopSession.RequireInteractive();
        var descriptions = Windows.DescribeAll(app, all, context);
        if (!descriptions.Windows.Any(window => window.Id == selected))
            throw new NativeFailure("WINDOW_CHANGED", "The selected window disappeared during observation; read fresh application state");
        var snapshot = new Snapshot(Guid.NewGuid().ToString("N"), selected, targets, elements);
        var tree = string.Join('\n', rows);
        if (batch is { } changes)
            tree = changes.Format(eventRows.GetValueOrDefault, id => previous!.Elements.ContainsKey(id), tree, !complete);
        var result = new
        {
            appHandle = app.Handle, windowId = selected.ToString(CultureInfo.InvariantCulture),
            focusedWindowId = Windows.Focused(app, descriptions.Windows)?.Id.ToString(CultureInfo.InvariantCulture),
            snapshotId = snapshot.Id, tree, windows = descriptions.Values, truncated, hasUnreadableElements,
        };
        context.Check();
        app.Snapshots[selected] = snapshot;
        if (showDiff && complete) notifications!.LastSnapshot = snapshot.Id;
        target.Observe(after);
        return result;
    }

    private static object Property(AutomationElement element, AutomationProperty property) => element.GetCachedPropertyValue(property, true);
    private static bool Flag(AutomationElement element, AutomationProperty property) => Property(element, property) is true;
    private static string Text(AutomationElement element, AutomationProperty property) => Property(element, property) as string ?? "";

    private static AccessibilityNode Read(AutomationElement element, WindowState window, WindowGeometry geometry, RequestContext context)
    {
        var type = Property(element, AutomationElement.ControlTypeProperty) as ControlType;
        var patterns = PatternActions.Patterns.Where(pattern => Flag(element, pattern.Available)).ToArray();
        var password = Flag(element, AutomationElement.IsPasswordProperty);
        string? value = null;
        var hasValue = false;
        string? writable = type == ControlType.Edit || type == ControlType.Document ? "unknown" : null;
        if (Flag(element, AutomationElement.IsValuePatternAvailableProperty))
        {
            hasValue = true;
            if (!password) value = Property(element, ValuePattern.ValueProperty) as string;
            writable = Property(element, ValuePattern.IsReadOnlyProperty) is bool readOnly ? readOnly ? "false" : "true" : "unknown";
        }
        else if (Flag(element, AutomationElement.IsRangeValuePatternAvailableProperty))
        {
            hasValue = true;
            if (Property(element, RangeValuePattern.ValueProperty) is double number) value = number.ToString("G", CultureInfo.InvariantCulture);
            writable = Property(element, RangeValuePattern.IsReadOnlyProperty) is bool readOnly ? readOnly ? "false" : "true" : "unknown";
        }
        else if (Property(element, TogglePattern.ToggleStateProperty) is ToggleState toggle)
        {
            hasValue = true; value = toggle == ToggleState.Indeterminate ? "mixed" : toggle == ToggleState.On ? "true" : "false";
        }
        bool? selectionWritable = null;
        var hasSelection = false;
        TextMatch? selection = null;
        string? selectedText = null;
        if (!password && Flag(element, AutomationElement.IsTextPatternAvailableProperty))
        {
            var text = context.Ax(() => (TextPattern)element.GetCurrentPattern(TextPattern.Pattern));
            var document = context.Ax(() => text.DocumentRange);
            value = context.Ax(() => document.GetText(context.Config.MaxResponseBytes));
            hasValue = true;
            selectionWritable = context.Ax(() => text.SupportedTextSelection) != SupportedTextSelection.None;
            hasSelection = true;
            var ranges = context.Ax(text.GetSelection);
            if (ranges.Length == 1)
            {
                var prefix = context.Ax(document.Clone);
                context.Ax(() => { prefix.MoveEndpointByRange(TextPatternRangeEndpoint.End, ranges[0], TextPatternRangeEndpoint.Start); return true; });
                var start = context.Ax(() => prefix.GetText(context.Config.MaxResponseBytes)).Length;
                selectedText = context.Ax(() => ranges[0].GetText(context.Config.MaxResponseBytes));
                selection = new(start, selectedText.Length);
            }
        }
        var bounds = Property(element, AutomationElement.BoundingRectangleProperty) is System.Windows.Rect rectangle && !rectangle.IsEmpty
            ? ((double, double, double, double)?)(rectangle.X, rectangle.Y, rectangle.Width, rectangle.Height) : null;
        var expanded = Property(element, ExpandCollapsePattern.ExpandCollapseStateProperty) is ExpandCollapseState state
            ? state == ExpandCollapseState.Expanded ? true : state == ExpandCollapseState.Collapsed ? false : (bool?)null : null;
        return new()
        {
            ControlType = ControlTypeName(type), Name = Text(element, AutomationElement.NameProperty), HelpText = Text(element, AutomationElement.HelpTextProperty),
            AutomationId = Text(element, AutomationElement.AutomationIdProperty),
            Value = value, HasValue = hasValue, ValueWritable = writable,
            Enabled = Property(element, AutomationElement.IsEnabledProperty) as bool?, Focused = Property(element, AutomationElement.HasKeyboardFocusProperty) as bool?,
            Selected = Property(element, SelectionItemPattern.IsSelectedProperty) as bool?, Expanded = expanded,
            HasSelection = hasSelection, Selection = selection, SelectedText = selectedText, SelectionWritable = selectionWritable,
            Patterns = patterns.Select(pattern => pattern.Name).ToArray(), Bounds = bounds,
        };
    }

    private static string ControlTypeName(ControlType? type)
    {
        if (type == ControlType.Edit) return nameof(ControlType.Edit);
        if (type == ControlType.Document) return nameof(ControlType.Document);
        if (type == ControlType.Button) return nameof(ControlType.Button);
        if (type == ControlType.CheckBox) return nameof(ControlType.CheckBox);
        if (type == ControlType.RadioButton) return nameof(ControlType.RadioButton);
        if (type == ControlType.Text) return nameof(ControlType.Text);
        if (type == ControlType.Window) return nameof(ControlType.Window);
        if (type == ControlType.MenuBar) return nameof(ControlType.MenuBar);
        if (type == ControlType.Menu) return nameof(ControlType.Menu);
        if (type == ControlType.MenuItem) return nameof(ControlType.MenuItem);
        if (type == ControlType.ComboBox) return nameof(ControlType.ComboBox);
        if (type == ControlType.List) return nameof(ControlType.List);
        if (type == ControlType.ListItem) return nameof(ControlType.ListItem);
        if (type == ControlType.Tree) return nameof(ControlType.Tree);
        if (type == ControlType.TreeItem) return nameof(ControlType.TreeItem);
        if (type == ControlType.Tab) return nameof(ControlType.Tab);
        if (type == ControlType.TabItem) return nameof(ControlType.TabItem);
        if (type == ControlType.Slider) return nameof(ControlType.Slider);
        if (type == ControlType.Spinner) return nameof(ControlType.Spinner);
        if (type == ControlType.ScrollBar) return nameof(ControlType.ScrollBar);
        if (type == ControlType.Image) return nameof(ControlType.Image);
        if (type == ControlType.Hyperlink) return nameof(ControlType.Hyperlink);
        if (type == ControlType.Table) return nameof(ControlType.Table);
        if (type == ControlType.DataGrid) return nameof(ControlType.DataGrid);
        if (type == ControlType.Group) return nameof(ControlType.Group);
        return "Other";
    }

    internal static ElementReference Element(AppState app, WindowState window, string snapshotId, string elementId,
        RequestContext context)
    {
        window.Geometry(app, context);
        if (!app.Snapshots.TryGetValue(window.Id, out var snapshot) || snapshot.Id != snapshotId
            || snapshot.Windows.Length != 1 || snapshot.Windows[0].Id != window.Id)
            throw new NativeFailure("STALE_SNAPSHOT", "Read fresh AX state before using element identifiers");
        if (!snapshot.Elements.TryGetValue(elementId, out var element)) throw new NativeFailure("INVALID_ELEMENT", "Use an elementId from this snapshot");
        if (element.Window.Id != window.Id)
            throw new NativeFailure("STALE_SNAPSHOT", "The element belongs to another window; read fresh AX state");
        return element;
    }

    internal static void RequireSnapshot(AppState app, string snapshotId, nint windowId)
    {
        if (!app.Snapshots.TryGetValue(windowId, out var snapshot) || snapshot.Id != snapshotId
            || snapshot.Windows.Length != 1 || snapshot.Windows[0].Id != windowId)
            throw new NativeFailure("STALE_SNAPSHOT", "Use a fresh observation from this window");
    }
}
