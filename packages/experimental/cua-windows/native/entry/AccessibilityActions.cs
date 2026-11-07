// Actions use retained UIA references only after snapshot and window validation.
using System.Globalization;
using System.Text.Json;
using System.Windows.Automation;
using System.Windows.Automation.Text;
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal static class AccessibilityActions
{
    private static T Pattern<T>(AutomationElement element, AutomationPattern pattern, RequestContext context) where T : BasePattern
    {
        object? value = null;
        if (!context.Ax(() => element.TryGetCurrentPattern(pattern, out value)))
            throw new NativeFailure("UNSUPPORTED", "The control does not expose this accessibility action");
        return (T)value!;
    }

    internal static string[] Actions(ElementReference reference, RequestContext context)
    {
        var element = reference.Element;
        var actions = new List<string>();
        if (context.Ax(() => element.TryGetCurrentPattern(InvokePattern.Pattern, out _))) actions.Add("Press");
        if (context.Ax(() => element.TryGetCurrentPattern(TogglePattern.Pattern, out _))) actions.Add("Toggle");
        if (context.Ax(() => element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out _))) actions.Add("Pick");
        if (context.Ax(() => element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out _))) { actions.Add("Expand"); actions.Add("Collapse"); }
        if (context.Ax(() => element.TryGetCurrentPattern(ScrollItemPattern.Pattern, out _))) actions.Add("ScrollToVisible");
        if (context.Ax(() => element.Current.IsKeyboardFocusable)) actions.Add("Focus");
        if (context.Ax(() => element.Current.ControlType) == ControlType.Window) actions.Add("Raise");
        return actions.ToArray();
    }

    internal static void Perform(AppState app, ElementReference reference, string action, JsonElement? argument, RequestContext context)
    {
        if (argument is { } value && value.ValueKind is not (JsonValueKind.Null or JsonValueKind.Undefined))
            throw new NativeFailure("INVALID_ARGUMENT", "This accessibility action does not accept an argument");
        Secondary(app, reference, action, context);
    }

    internal static bool Invoke(ElementReference reference, RequestContext context)
    {
        object? pattern = null;
        var element = reference.Element;
        if (context.Ax(() => element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)))
            context.Ax(() => { ((InvokePattern)pattern!).Invoke(); return true; });
        else if (context.Ax(() => element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)))
            context.Ax(() => { ((SelectionItemPattern)pattern!).Select(); return true; });
        else return false;
        return true;
    }

    internal static bool Click(ElementReference reference, RequestContext context)
    {
        object? pattern = null;
        var element = reference.Element;
        if (context.Ax(() => element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)))
            context.Ax(() => { ((InvokePattern)pattern!).Invoke(); return true; });
        else if (context.Ax(() => element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)))
            context.Ax(() => { ((SelectionItemPattern)pattern!).Select(); return true; });
        else if (context.Ax(() => element.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)))
            context.Ax(() => { ((TogglePattern)pattern!).Toggle(); return true; });
        else return false;
        return true;
    }

    internal static void SetValue(ElementReference reference, JsonElement value, RequestContext context)
    {
        if (value.ValueKind is not (JsonValueKind.String or JsonValueKind.Number)
            || value.ValueKind == JsonValueKind.Number && (!value.TryGetDouble(out var numeric) || !double.IsFinite(numeric)))
            throw new NativeFailure("INVALID_ARGUMENT", "The value must be a string or a finite number");
        object? pattern = null;
        if (context.Ax(() => reference.Element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)))
        {
            var setter = (ValuePattern)pattern!;
            if (context.Ax(() => setter.Current.IsReadOnly)) throw new NativeFailure("UNSUPPORTED", "The control value is read-only");
            var text = value.ValueKind == JsonValueKind.String
                ? value.GetString()! : value.GetDouble().ToString("G", CultureInfo.InvariantCulture);
            context.Ax(() => { setter.SetValue(text); return true; });
            return;
        }
        var number = double.NaN;
        if (value.ValueKind == JsonValueKind.Number) { if (!value.TryGetDouble(out number)) number = double.NaN; }
        else if (!double.TryParse(value.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out number)) number = double.NaN;
        if (!double.IsFinite(number)) throw new NativeFailure("INVALID_ARGUMENT", "This control requires a finite numeric value");
        var range = Pattern<RangeValuePattern>(reference.Element, RangeValuePattern.Pattern, context);
        var current = context.Ax(() => range.Current);
        if (current.IsReadOnly || number < current.Minimum || number > current.Maximum)
            throw new NativeFailure("UNSUPPORTED", "The control cannot accept this value");
        context.Ax(() => { range.SetValue(number); return true; });
    }

    internal static void Secondary(AppState app, ElementReference reference, string action, RequestContext context)
    {
        switch (action.ToLowerInvariant())
        {
            case "press":
                context.Ax(() => { Pattern<InvokePattern>(reference.Element, InvokePattern.Pattern, context).Invoke(); return true; });
                break;
            case "pick":
                context.Ax(() => { Pattern<SelectionItemPattern>(reference.Element, SelectionItemPattern.Pattern, context).Select(); return true; });
                break;
            case "toggle":
                context.Ax(() => { Pattern<TogglePattern>(reference.Element, TogglePattern.Pattern, context).Toggle(); return true; });
                break;
            case "expand":
                context.Ax(() => { Pattern<ExpandCollapsePattern>(reference.Element, ExpandCollapsePattern.Pattern, context).Expand(); return true; });
                break;
            case "collapse":
                context.Ax(() => { Pattern<ExpandCollapsePattern>(reference.Element, ExpandCollapsePattern.Pattern, context).Collapse(); return true; });
                break;
            case "scrolltovisible":
                context.Ax(() => { Pattern<ScrollItemPattern>(reference.Element, ScrollItemPattern.Pattern, context).ScrollIntoView(); return true; });
                break;
            case "focus":
                context.Ax(() => { reference.Element.SetFocus(); return true; });
                break;
            case "raise":
                if (context.Ax(() => reference.Element.Current.ControlType) != ControlType.Window)
                    throw new NativeFailure("UNSUPPORTED", "Raise is available only on the observed window element");
                Windows.Activate(app, reference.Window, context);
                break;
            default: throw new NativeFailure("UNSUPPORTED", "Use an action name from a fresh details:true observation");
        }
    }

    internal static void SelectText(ElementReference reference, string text, string? prefix, string? suffix,
        string selectionType, RequestContext context)
    {
        var pattern = Pattern<TextPattern>(reference.Element, TextPattern.Pattern, context);
        if (context.Ax(() => pattern.SupportedTextSelection) == SupportedTextSelection.None)
            throw new NativeFailure("UNSUPPORTED", "The control does not support text selection");
        var document = context.Ax(() => pattern.DocumentRange);
        var value = context.Ax(() => document.GetText(context.Config.MaxResponseBytes));
        var expected = TextSelection.Find(value, text, prefix, suffix);
        var search = context.Ax(document.Clone);
        TextPatternRange? selected = null;
        while (true)
        {
            context.Check();
            var found = context.Ax(() => search.FindText(text, false, false));
            if (found is null) break;
            var before = context.Ax(document.Clone);
            context.Ax(() => { before.MoveEndpointByRange(TextPatternRangeEndpoint.End, found, TextPatternRangeEndpoint.Start); return true; });
            if (context.Ax(() => before.GetText(context.Config.MaxResponseBytes)).Length == expected.Start) { selected = found; break; }
            var oldStart = context.Ax(search.Clone);
            context.Ax(() => { search.MoveEndpointByRange(TextPatternRangeEndpoint.Start, found, TextPatternRangeEndpoint.Start);
                search.MoveEndpointByUnit(TextPatternRangeEndpoint.Start, TextUnit.Character, 1); return true; });
            if (context.Ax(() => search.CompareEndpoints(TextPatternRangeEndpoint.Start, oldStart, TextPatternRangeEndpoint.Start)) <= 0) break;
        }
        if (selected is null || context.Ax(() => selected.GetText(context.Config.MaxResponseBytes)) != text)
            throw new NativeFailure("SELECTION_CHANGED", "The control text changed; read fresh state before selecting");
        if (selectionType == "cursor_before")
            context.Ax(() => { selected.MoveEndpointByRange(TextPatternRangeEndpoint.End, selected, TextPatternRangeEndpoint.Start); return true; });
        else if (selectionType == "cursor_after")
            context.Ax(() => { selected.MoveEndpointByRange(TextPatternRangeEndpoint.Start, selected, TextPatternRangeEndpoint.End); return true; });
        context.Ax(() => { selected.Select(); return true; });
        var actual = context.Ax(pattern.GetSelection);
        if (actual.Length != 1 || context.Ax(() => actual[0].CompareEndpoints(TextPatternRangeEndpoint.Start, selected, TextPatternRangeEndpoint.Start)) != 0
            || context.Ax(() => actual[0].CompareEndpoints(TextPatternRangeEndpoint.End, selected, TextPatternRangeEndpoint.End)) != 0)
            throw new NativeFailure("SELECTION_CHANGED", "The control did not retain the requested selection; read fresh state");
    }
}
