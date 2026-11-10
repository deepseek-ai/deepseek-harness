// One traversal owns both the disclosed indices and their retained UI Automation elements.
using System.Globalization;
using System.Text;
using System.Windows.Automation;
using System.Windows.Automation.Text;
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal sealed record ElementReference(AutomationElement Element, WindowState Window);
internal sealed record Snapshot(string Id, nint Scope, WindowState[] Windows, IReadOnlyDictionary<int, ElementReference> Elements);

internal static class Accessibility
{
    private static readonly AutomationProperty[] Properties = [
        AutomationElement.ControlTypeProperty, AutomationElement.NameProperty, AutomationElement.HelpTextProperty,
        AutomationElement.AutomationIdProperty, AutomationElement.ClassNameProperty, AutomationElement.IsEnabledProperty,
        AutomationElement.HasKeyboardFocusProperty, AutomationElement.IsKeyboardFocusableProperty, AutomationElement.IsPasswordProperty,
        AutomationElement.BoundingRectangleProperty, AutomationElement.IsInvokePatternAvailableProperty,
        AutomationElement.IsValuePatternAvailableProperty, AutomationElement.IsRangeValuePatternAvailableProperty,
        AutomationElement.IsTextPatternAvailableProperty, AutomationElement.IsSelectionItemPatternAvailableProperty,
        AutomationElement.IsTogglePatternAvailableProperty, AutomationElement.IsExpandCollapsePatternAvailableProperty,
        AutomationElement.IsScrollItemPatternAvailableProperty, ValuePattern.ValueProperty, ValuePattern.IsReadOnlyProperty,
        RangeValuePattern.ValueProperty, RangeValuePattern.IsReadOnlyProperty, SelectionItemPattern.IsSelectedProperty,
        TogglePattern.ToggleStateProperty, ExpandCollapsePattern.ExpandCollapseStateProperty,
    ];

    internal static object State(AppState app, nint selected, int maximumElements, int maximumDepth,
        bool includeMenus, bool details, RequestContext context)
    {
        var all = Windows.Refresh(app, context);
        var target = Windows.Resolve(app, selected, context);
        if (!all.Any(window => window.Id == target.Id)) all = [.. all, target];
        var targets = new[] { target };
        var rows = new List<string> { "AX scope=window offsets=UTF-16" };
        var elements = new Dictionary<int, ElementReference>();
        var observations = new List<(WindowState Window, WindowGeometry Geometry)>();
        var visited = new HashSet<string>(StringComparer.Ordinal);
        var cache = new CacheRequest { AutomationElementMode = AutomationElementMode.Full, TreeScope = TreeScope.Element };
        foreach (var property in Properties) cache.Add(property);
        var truncated = false;
        var count = 0;
        var nextIndex = 0;
        var bytes = Encoding.UTF8.GetByteCount(rows[0]);
        void Add(string row)
        {
            bytes += Encoding.UTF8.GetByteCount(row) + 1;
            if (bytes > context.Config.MaxResponseBytes) throw new NativeFailure("NATIVE_RESPONSE_LIMIT", "Accessibility text exceeds the response limit; select a narrower window or reduce traversal limits");
            rows.Add(row);
        }
        foreach (var window in targets)
        {
            if (count >= maximumElements) { truncated = true; break; }
            var geometry = window.Geometry(app, context);
            try
            {
                var root = context.Ax(() => AutomationElement.FromHandle(window.Handle).GetUpdatedCache(cache));
                Walk(root, window, geometry, 0, 0);
            }
            catch (ElementNotAvailableException) { throw new NativeFailure("STALE_SNAPSHOT", "An accessibility element disappeared; read fresh state without repeating input"); }
            var after = window.Geometry(app, context);
            if (after.Pixels.Width != geometry.Pixels.Width || after.Pixels.Height != geometry.Pixels.Height || after.Dpi != geometry.Dpi)
                throw new NativeFailure("WINDOW_CHANGED", "The window changed during AX observation; read fresh state");
            observations.Add((window, after));
        }
        if (truncated) Add($"[truncated: maxElements={maximumElements}, maxDepth={maximumDepth}]");
        DesktopSession.RequireInteractive();
        var descriptions = Windows.DescribeAll(app, all, context);
        if (!descriptions.Windows.Any(window => window.Id == selected))
            throw new NativeFailure("WINDOW_CHANGED", "The selected window disappeared during observation; read fresh application state");
        var snapshot = new Snapshot(Guid.NewGuid().ToString("N"), selected, targets, elements);
        var result = new
        {
            appHandle = app.Handle, pid = 4, windowId = selected.ToString(CultureInfo.InvariantCulture),
            focusedWindowId = Windows.Focused(app, descriptions.Windows)?.Id.ToString(CultureInfo.InvariantCulture),
            snapshotId = snapshot.Id, tree = string.Join('\n', rows), windows = descriptions.Values, truncated,
        };
        context.Check();
        app.Snapshots[selected] = snapshot;
        foreach (var observation in observations) observation.Window.Observe(observation.Geometry);
        return result;

        void Walk(AutomationElement element, WindowState window, WindowGeometry geometry, int depth, int indent)
        {
            context.Check();
            if (count >= maximumElements || depth >= maximumDepth) { truncated = true; return; }
            count++;
            if (!visited.Add(string.Join(',', context.Ax(element.GetRuntimeId)))) return;
            var node = Read(element, window, geometry, context);
            var retained = AccessibilityText.Retain(node);
            if (retained)
            {
                int? index = null;
                if (node.Enabled != false && (node.Actions.Length != 0 || node.ValueWritable == "true" || node.SelectionWritable == true))
                {
                    index = nextIndex++;
                    elements.Add(index.Value, new(element, window));
                }
                Add(new string(' ', indent * 2) + AccessibilityText.Format(node, index, details));
            }
            if (!includeMenus && node.Role == "AXMenu")
            {
                Add(new string(' ', (indent + 1) * 2) + "[menu contents omitted; includeMenus:true]");
                return;
            }
            var first = context.Ax(() => TreeWalker.ControlViewWalker.GetFirstChild(element, cache));
            if (first is not null && depth + 1 >= maximumDepth) { truncated = true; return; }
            for (var child = first; child is not null;
                 child = context.Ax(() => TreeWalker.ControlViewWalker.GetNextSibling(child, cache)))
            {
                Walk(child, window, geometry, depth + 1, indent + (retained ? 1 : 0));
                if (count >= maximumElements)
                {
                    if (context.Ax(() => TreeWalker.ControlViewWalker.GetNextSibling(child, cache)) is not null) truncated = true;
                    break;
                }
            }
        }
    }

    private static object Property(AutomationElement element, AutomationProperty property) => element.GetCachedPropertyValue(property, true);
    private static bool Flag(AutomationElement element, AutomationProperty property) => Property(element, property) is true;
    private static string Text(AutomationElement element, AutomationProperty property) => Property(element, property) as string ?? "";

    private static AccessibilityNode Read(AutomationElement element, WindowState window, WindowGeometry geometry, RequestContext context)
    {
        var type = Property(element, AutomationElement.ControlTypeProperty) as ControlType ?? ControlType.Custom;
        var actions = new List<string>();
        if (Flag(element, AutomationElement.IsInvokePatternAvailableProperty)) actions.Add("Press");
        if (Flag(element, AutomationElement.IsTogglePatternAvailableProperty)) actions.Add("Toggle");
        if (Flag(element, AutomationElement.IsSelectionItemPatternAvailableProperty)) actions.Add("Pick");
        if (Flag(element, AutomationElement.IsExpandCollapsePatternAvailableProperty)) { actions.Add("Expand"); actions.Add("Collapse"); }
        if (Flag(element, AutomationElement.IsScrollItemPatternAvailableProperty)) actions.Add("ScrollToVisible");
        if (Flag(element, AutomationElement.IsKeyboardFocusableProperty)) actions.Add("Focus");
        if (type == ControlType.Window) actions.Add("Raise");
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
        var role = Role(type, password, value);
        var bounds = Property(element, AutomationElement.BoundingRectangleProperty) is System.Windows.Rect rectangle && !rectangle.IsEmpty
            ? ((double, double, double, double)?)(rectangle.X, rectangle.Y, rectangle.Width, rectangle.Height) : null;
        var expanded = Property(element, ExpandCollapsePattern.ExpandCollapseStateProperty) is ExpandCollapseState state
            ? state == ExpandCollapseState.Expanded ? true : state == ExpandCollapseState.Collapsed ? false : (bool?)null : null;
        return new()
        {
            Role = role, Name = Text(element, AutomationElement.NameProperty), Help = Text(element, AutomationElement.HelpTextProperty),
            Identifier = Text(element, AutomationElement.AutomationIdProperty), Subrole = type == ControlType.Custom ? Text(element, AutomationElement.ClassNameProperty) : null,
            Value = value, HasValue = hasValue, ValueWritable = writable,
            Enabled = Property(element, AutomationElement.IsEnabledProperty) as bool?, Focused = Property(element, AutomationElement.HasKeyboardFocusProperty) as bool?,
            Selected = Property(element, SelectionItemPattern.IsSelectedProperty) as bool?, Expanded = expanded,
            HasSelection = hasSelection, Selection = selection, SelectedText = selectedText, SelectionWritable = selectionWritable,
            Actions = actions.ToArray(), Bounds = bounds,
        };
    }

    private static string Role(ControlType type, bool password, string? value)
    {
        if (password) return "AXSecureTextField";
        if (type == ControlType.Edit) return value?.Contains('\n') == true ? "AXTextArea" : "AXTextField";
        if (type == ControlType.Document) return "AXTextArea";
        if (type == ControlType.Button) return "AXButton";
        if (type == ControlType.CheckBox) return "AXCheckBox";
        if (type == ControlType.RadioButton) return "AXRadioButton";
        if (type == ControlType.Text) return "AXStaticText";
        if (type == ControlType.Window) return "AXWindow";
        if (type == ControlType.MenuBar) return "AXMenuBar";
        if (type == ControlType.Menu) return "AXMenu";
        if (type == ControlType.MenuItem) return "AXMenuItem";
        if (type == ControlType.ComboBox) return "AXComboBox";
        if (type == ControlType.List) return "AXList";
        if (type == ControlType.ListItem) return "AXRow";
        if (type == ControlType.Tree) return "AXOutline";
        if (type == ControlType.TreeItem) return "AXRow";
        if (type == ControlType.Tab) return "AXTabGroup";
        if (type == ControlType.TabItem) return "AXRadioButton";
        if (type == ControlType.Slider) return "AXSlider";
        if (type == ControlType.Spinner) return "AXIncrementor";
        if (type == ControlType.ScrollBar) return "AXScrollBar";
        if (type == ControlType.Image) return "AXImage";
        if (type == ControlType.Hyperlink) return "AXLink";
        if (type == ControlType.Table || type == ControlType.DataGrid) return "AXTable";
        return "AXGroup";
    }

    internal static ElementReference Element(AppState app, WindowState window, string snapshotId, string elementId,
        RequestContext context)
    {
        if (!int.TryParse(elementId, NumberStyles.None, CultureInfo.InvariantCulture, out var index))
            throw new NativeFailure("INVALID_ELEMENT", "Use an elementId from this snapshot");
        window.Geometry(app, context);
        if (!app.Snapshots.TryGetValue(window.Id, out var snapshot) || snapshot.Id != snapshotId
            || snapshot.Windows.Length != 1 || snapshot.Windows[0].Id != window.Id)
            throw new NativeFailure("STALE_SNAPSHOT", "Read fresh AX state before using element identifiers");
        if (!snapshot.Elements.TryGetValue(index, out var element)) throw new NativeFailure("INVALID_ELEMENT", "Use an elementId from this snapshot");
        if (element.Window.Id != window.Id)
            throw new NativeFailure("STALE_SNAPSHOT", "The element belongs to another window; read fresh AX state");
        if (!context.Ax(() => element.Element.Current.IsEnabled)) throw new NativeFailure("ELEMENT_DISABLED", "The element is disabled");
        return element;
    }

    internal static void RequireSnapshot(AppState app, string snapshotId, nint windowId)
    {
        if (!app.Snapshots.TryGetValue(windowId, out var snapshot) || snapshot.Id != snapshotId
            || snapshot.Windows.Length != 1 || snapshot.Windows[0].Id != windowId)
            throw new NativeFailure("STALE_SNAPSHOT", "Use a fresh observation from this window");
    }
}
