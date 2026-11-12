// Cached observations and live dispatch share the same UIA operation definitions.
using System.Text.Json;
using System.Windows.Automation;
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal sealed record PatternAction(string Name, Func<JsonElement?, Action<BasePattern>> Bind);
internal sealed record PatternOperations(AutomationPattern Pattern, AutomationProperty Available, PatternAction[] Actions)
{
    internal string Name => Pattern.ProgrammaticName[..^"PatternIdentifiers.Pattern".Length];
}

internal static class PatternActions
{
    internal static readonly PatternOperations[] Patterns = [
        new(InvokePattern.Pattern, AutomationElement.IsInvokePatternAvailableProperty, [
            NoArgument<InvokePattern>(nameof(InvokePattern.Invoke), pattern => pattern.Invoke()),
        ]),
        new(TogglePattern.Pattern, AutomationElement.IsTogglePatternAvailableProperty, [
            NoArgument<TogglePattern>(nameof(TogglePattern.Toggle), pattern => pattern.Toggle()),
        ]),
        new(SelectionItemPattern.Pattern, AutomationElement.IsSelectionItemPatternAvailableProperty, [
            NoArgument<SelectionItemPattern>(nameof(SelectionItemPattern.Select), pattern => pattern.Select()),
            NoArgument<SelectionItemPattern>(nameof(SelectionItemPattern.AddToSelection), pattern => pattern.AddToSelection()),
            NoArgument<SelectionItemPattern>(nameof(SelectionItemPattern.RemoveFromSelection), pattern => pattern.RemoveFromSelection()),
        ]),
        new(ExpandCollapsePattern.Pattern, AutomationElement.IsExpandCollapsePatternAvailableProperty, [
            NoArgument<ExpandCollapsePattern>(nameof(ExpandCollapsePattern.Expand), pattern => pattern.Expand()),
            NoArgument<ExpandCollapsePattern>(nameof(ExpandCollapsePattern.Collapse), pattern => pattern.Collapse()),
        ]),
        new(ScrollItemPattern.Pattern, AutomationElement.IsScrollItemPatternAvailableProperty, [
            NoArgument<ScrollItemPattern>(nameof(ScrollItemPattern.ScrollIntoView), pattern => pattern.ScrollIntoView()),
        ]),
        new(ValuePattern.Pattern, AutomationElement.IsValuePatternAvailableProperty, [
            WithArgument<ValuePattern, string>(nameof(ValuePattern.SetValue), String, (pattern, value) => pattern.SetValue(value)),
        ]),
        new(RangeValuePattern.Pattern, AutomationElement.IsRangeValuePatternAvailableProperty, [
            WithArgument<RangeValuePattern, double>(nameof(RangeValuePattern.SetValue), Number, (pattern, value) => pattern.SetValue(value)),
        ]),
        new(ScrollPattern.Pattern, AutomationElement.IsScrollPatternAvailableProperty, [
            WithArgument<ScrollPattern, (ScrollAmount X, ScrollAmount Y)>(nameof(ScrollPattern.Scroll),
                value => Pair(value, "horizontalAmount", "verticalAmount", EnumValue<ScrollAmount>),
                (pattern, amount) => pattern.Scroll(amount.X, amount.Y)),
            WithArgument<ScrollPattern, ScrollAmount>(nameof(ScrollPattern.ScrollHorizontal), EnumValue<ScrollAmount>,
                (pattern, amount) => pattern.ScrollHorizontal(amount)),
            WithArgument<ScrollPattern, ScrollAmount>(nameof(ScrollPattern.ScrollVertical), EnumValue<ScrollAmount>,
                (pattern, amount) => pattern.ScrollVertical(amount)),
            WithArgument<ScrollPattern, (double X, double Y)>(nameof(ScrollPattern.SetScrollPercent),
                value => Pair(value, "horizontalPercent", "verticalPercent", Percent),
                (pattern, percent) => pattern.SetScrollPercent(percent.X, percent.Y)),
        ]),
        new(TransformPattern.Pattern, AutomationElement.IsTransformPatternAvailableProperty, [
            WithArgument<TransformPattern, (double X, double Y)>(nameof(TransformPattern.Move),
                value => Pair(value, "x", "y", Number), (pattern, point) => pattern.Move(point.X, point.Y)),
            WithArgument<TransformPattern, (double Width, double Height)>(nameof(TransformPattern.Resize),
                value => Pair(value, "width", "height", PositiveNumber), (pattern, size) => pattern.Resize(size.Width, size.Height)),
            WithArgument<TransformPattern, double>(nameof(TransformPattern.Rotate), Number, (pattern, degrees) => pattern.Rotate(degrees)),
        ]),
        new(WindowPattern.Pattern, AutomationElement.IsWindowPatternAvailableProperty, [
            NoArgument<WindowPattern>(nameof(WindowPattern.Close), pattern => pattern.Close()),
            WithArgument<WindowPattern, WindowVisualState>(nameof(WindowPattern.SetWindowVisualState), EnumValue<WindowVisualState>,
                (pattern, state) => pattern.SetWindowVisualState(state)),
        ]),
        new(DockPattern.Pattern, AutomationElement.IsDockPatternAvailableProperty, [
            WithArgument<DockPattern, DockPosition>(nameof(DockPattern.SetDockPosition), EnumValue<DockPosition>,
                (pattern, position) => pattern.SetDockPosition(position)),
        ]),
        new(MultipleViewPattern.Pattern, AutomationElement.IsMultipleViewPatternAvailableProperty, [
            WithArgument<MultipleViewPattern, int>(nameof(MultipleViewPattern.SetCurrentView), Integer, (pattern, view) => pattern.SetCurrentView(view)),
        ]),
        new(VirtualizedItemPattern.Pattern, AutomationElement.IsVirtualizedItemPatternAvailableProperty, [
            NoArgument<VirtualizedItemPattern>(nameof(VirtualizedItemPattern.Realize), pattern => pattern.Realize()),
        ]),
        new(SynchronizedInputPattern.Pattern, AutomationElement.IsSynchronizedInputPatternAvailableProperty, [
            WithArgument<SynchronizedInputPattern, SynchronizedInputType>(nameof(SynchronizedInputPattern.StartListening), EnumValue<SynchronizedInputType>,
                (pattern, inputType) => pattern.StartListening(inputType)),
            NoArgument<SynchronizedInputPattern>(nameof(SynchronizedInputPattern.Cancel), pattern => pattern.Cancel()),
        ]),
        new(SelectionPattern.Pattern, AutomationElement.IsSelectionPatternAvailableProperty, []),
        new(GridPattern.Pattern, AutomationElement.IsGridPatternAvailableProperty, []),
        new(GridItemPattern.Pattern, AutomationElement.IsGridItemPatternAvailableProperty, []),
        new(TablePattern.Pattern, AutomationElement.IsTablePatternAvailableProperty, []),
        new(TableItemPattern.Pattern, AutomationElement.IsTableItemPatternAvailableProperty, []),
        new(TextPattern.Pattern, AutomationElement.IsTextPatternAvailableProperty, []),
        new(ItemContainerPattern.Pattern, AutomationElement.IsItemContainerPatternAvailableProperty, []),
    ];

    internal static string[] Names(Func<PatternOperations, bool> supported) => Patterns
        .Where(supported).SelectMany(pattern => pattern.Actions.Select(action => action.Name)).ToArray();

    // Bind validates the complete JSON argument before any UIA operation is attempted.
    internal static (AutomationPattern Pattern, Action<BasePattern> Invoke) Resolve(string name, JsonElement? argument)
    {
        foreach (var pattern in Patterns)
            foreach (var action in pattern.Actions)
                if (action.Name == name) return (pattern.Pattern, action.Bind(argument));
        throw new NativeFailure("UNSUPPORTED", "Use an exact Pattern.Action name from listActions");
    }

    private static PatternAction NoArgument<T>(string method, Action<T> invoke) where T : BasePattern =>
        WithArgument<T, bool>(method, value =>
        {
            if (value is { ValueKind: not (JsonValueKind.Null or JsonValueKind.Undefined) })
                throw Invalid("omit argument or pass null for this no-argument action");
            return true;
        }, (pattern, _) => invoke(pattern));

    // Single parameters are direct JSON values; multiple parameters use their native parameter names.
    private static PatternAction WithArgument<T, TValue>(string method, Func<JsonElement?, TValue> parse, Action<T, TValue> invoke)
        where T : BasePattern
    {
        var name = typeof(T).Name[..^"Pattern".Length] + "." + method;
        return new(name, argument =>
        {
            var value = parse(argument);
            return pattern => invoke((T)pattern, value);
        });
    }

    private static NativeFailure Invalid(string expected) => new("INVALID_ARGUMENT", "Pattern action argument: " + expected);

    private static string String(JsonElement? value) => value is { ValueKind: JsonValueKind.String } text
        ? text.GetString()! : throw Invalid("pass a string");

    private static double Number(JsonElement? value) => value is { ValueKind: JsonValueKind.Number } number
        && number.TryGetDouble(out var result) && double.IsFinite(result) ? result : throw Invalid("pass a finite number");

    private static int Integer(JsonElement? value) => value is { ValueKind: JsonValueKind.Number } number
        && number.TryGetInt32(out var result) ? result : throw Invalid("pass a 32-bit integer viewId");

    private static double PositiveNumber(JsonElement? value)
    {
        var number = Number(value);
        return number > 0 ? number : throw Invalid("width and height must be positive");
    }

    private static double Percent(JsonElement? value)
    {
        var number = Number(value);
        return number == ScrollPattern.NoScroll || number is >= 0 and <= 100
            ? number : throw Invalid("pass a scroll percentage from 0 to 100, or -1 to leave that axis unchanged");
    }

    private static T EnumValue<T>(JsonElement? value) where T : struct, Enum
    {
        if (value is { ValueKind: JsonValueKind.String } text && Enum.TryParse<T>(text.GetString(), out var result)
            && Enum.IsDefined(result) && result.ToString() == text.GetString()) return result;
        throw Invalid("pass one of: " + string.Join(", ", Enum.GetNames<T>()));
    }

    private static (T, T) Pair<T>(JsonElement? value, string first, string second, Func<JsonElement?, T> parse)
    {
        if (value is not { ValueKind: JsonValueKind.Object } fields
            || !fields.TryGetProperty(first, out var a) || !fields.TryGetProperty(second, out var b)
            || fields.EnumerateObject().Count() != 2)
            throw Invalid($"pass an object containing exactly {first} and {second}");
        return (parse(a), parse(b));
    }
}
