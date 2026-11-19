// Cached observations and live dispatch share the same UIA operation definitions.
using System.Text.Json;
using Json.Schema;
using System.Windows.Automation;
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

// Argument builders are used only while assembling the registered actions.
internal sealed record Argument<TValue>(Func<JsonElement?, TValue> Parse, JsonSchemaBuilder Schema);
internal sealed record PatternAction(string Name, Func<JsonElement?, Action<BasePattern>> Bind, JsonSchema ParameterSchema);
internal sealed record PatternOperations(AutomationPattern Pattern, AutomationProperty Available, PatternAction[] Actions)
{
    internal string Name => Pattern.ProgrammaticName[..^"PatternIdentifiers.Pattern".Length];
}

internal static class PatternActions
{
    private static JsonSchemaBuilder StringValue(string? description = null) => Described(SchemaValueType.String, description);
    private static JsonSchemaBuilder NumberValue(string? description = null) => Described(SchemaValueType.Number, description);
    private static JsonSchemaBuilder Described(SchemaValueType type, string? description)
    {
        var schema = new JsonSchemaBuilder().Type(type);
        return description is null ? schema : schema.Description(description);
    }

    private static double ParseFinite(JsonElement? value) => value is { ValueKind: JsonValueKind.Number } number
        && number.TryGetDouble(out var result) && double.IsFinite(result) ? result : throw Invalid("pass a finite number");

    private static Argument<string> Text(string description) => new(
        value => value is { ValueKind: JsonValueKind.String } text ? text.GetString()! : throw Invalid("pass a string"),
        StringValue(description));

    private static Argument<double> FiniteNumber(string description) => new(ParseFinite, NumberValue(description));

    private static Argument<int> Int32(string description) => new(
        value => value is { ValueKind: JsonValueKind.Number } number
            && number.TryGetInt32(out var result) ? result : throw Invalid("pass a 32-bit integer viewId"),
        NumberValue(description));

    private static Argument<double> PositiveNumber(string description) => new(
        value =>
        {
            var number = ParseFinite(value);
            return number > 0 ? number : throw Invalid("width and height must be positive");
        },
        NumberValue(description));

    private static Argument<double> Percent() => new(
        value =>
        {
            var number = ParseFinite(value);
            return number == ScrollPattern.NoScroll || number is >= 0 and <= 100
                ? number : throw Invalid("pass a scroll percentage from 0 to 100, or -1 to leave that axis unchanged");
        },
        NumberValue("Scroll percentage from 0 to 100, or -1 (NoScroll) to leave the axis unchanged."));

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
            WithArgument<ValuePattern, string>(nameof(ValuePattern.SetValue),
                Text("Text to set as the element value."), (pattern, value) => pattern.SetValue(value)),
        ]),
        new(RangeValuePattern.Pattern, AutomationElement.IsRangeValuePatternAvailableProperty, [
            WithArgument<RangeValuePattern, double>(nameof(RangeValuePattern.SetValue),
                FiniteNumber("Value within the element's current Minimum and Maximum; must be finite."),
                (pattern, value) => pattern.SetValue(value)),
        ]),
        new(ScrollPattern.Pattern, AutomationElement.IsScrollPatternAvailableProperty, [
            WithArgument<ScrollPattern, (ScrollAmount X, ScrollAmount Y)>(nameof(ScrollPattern.Scroll),
                Pair("horizontalAmount", "verticalAmount", EnumValue<ScrollAmount>()),
                (pattern, amount) => pattern.Scroll(amount.X, amount.Y)),
            WithArgument<ScrollPattern, ScrollAmount>(nameof(ScrollPattern.ScrollHorizontal), EnumValue<ScrollAmount>(),
                (pattern, amount) => pattern.ScrollHorizontal(amount)),
            WithArgument<ScrollPattern, ScrollAmount>(nameof(ScrollPattern.ScrollVertical), EnumValue<ScrollAmount>(),
                (pattern, amount) => pattern.ScrollVertical(amount)),
            WithArgument<ScrollPattern, (double X, double Y)>(nameof(ScrollPattern.SetScrollPercent),
                Pair("horizontalPercent", "verticalPercent", Percent()),
                (pattern, percent) => pattern.SetScrollPercent(percent.X, percent.Y)),
        ]),
        new(TransformPattern.Pattern, AutomationElement.IsTransformPatternAvailableProperty, [
            WithArgument<TransformPattern, (double X, double Y)>(nameof(TransformPattern.Move),
                Pair("x", "y", FiniteNumber("Screen coordinate in pixels; must be finite.")),
                (pattern, point) => pattern.Move(point.X, point.Y)),
            WithArgument<TransformPattern, (double Width, double Height)>(nameof(TransformPattern.Resize),
                Pair("width", "height", PositiveNumber("Pixel dimension; must be positive.")),
                (pattern, size) => pattern.Resize(size.Width, size.Height)),
            WithArgument<TransformPattern, double>(nameof(TransformPattern.Rotate),
                FiniteNumber("Degrees; positive rotates clockwise and negative counterclockwise; must be finite."),
                (pattern, degrees) => pattern.Rotate(degrees)),
        ]),
        new(WindowPattern.Pattern, AutomationElement.IsWindowPatternAvailableProperty, [
            NoArgument<WindowPattern>(nameof(WindowPattern.Close), pattern => pattern.Close()),
            WithArgument<WindowPattern, WindowVisualState>(nameof(WindowPattern.SetWindowVisualState), EnumValue<WindowVisualState>(),
                (pattern, state) => pattern.SetWindowVisualState(state)),
        ]),
        new(DockPattern.Pattern, AutomationElement.IsDockPatternAvailableProperty, [
            WithArgument<DockPattern, DockPosition>(nameof(DockPattern.SetDockPosition), EnumValue<DockPosition>(),
                (pattern, position) => pattern.SetDockPosition(position)),
        ]),
        new(MultipleViewPattern.Pattern, AutomationElement.IsMultipleViewPatternAvailableProperty, [
            WithArgument<MultipleViewPattern, int>(nameof(MultipleViewPattern.SetCurrentView),
                Int32("A 32-bit integer element view ID."), (pattern, view) => pattern.SetCurrentView(view)),
        ]),
        new(VirtualizedItemPattern.Pattern, AutomationElement.IsVirtualizedItemPatternAvailableProperty, [
            NoArgument<VirtualizedItemPattern>(nameof(VirtualizedItemPattern.Realize), pattern => pattern.Realize()),
        ]),
        new(SynchronizedInputPattern.Pattern, AutomationElement.IsSynchronizedInputPatternAvailableProperty, [
            WithArgument<SynchronizedInputPattern, SynchronizedInputType>(nameof(SynchronizedInputPattern.StartListening), EnumValue<SynchronizedInputType>(),
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

    // Basic types and descriptive value limits; binding enforces the action's constraints.
    internal static JsonSchema Schema(string name) => Find(name).Action.ParameterSchema;

    // Bind validates the complete JSON argument before any UIA operation is attempted.
    internal static (AutomationPattern Pattern, Action<BasePattern> Invoke) Resolve(string name, JsonElement? argument)
    {
        var (pattern, action) = Find(name);
        return (pattern.Pattern, action.Bind(argument));
    }

    private static (PatternOperations Pattern, PatternAction Action) Find(string name)
    {
        foreach (var pattern in Patterns)
            foreach (var action in pattern.Actions)
                if (action.Name == name) return (pattern, action);
        throw new NativeFailure("UNSUPPORTED", "Use an exact Pattern.Action name from listActions");
    }

    // performAction takes one optional argument; a parameter-free action accepts omission or null.
    private static JsonSchema Parameters(JsonSchemaBuilder? argument) => new JsonSchemaBuilder()
        .Type(SchemaValueType.Object)
        .Properties(("argument", argument ?? new JsonSchemaBuilder().Type(SchemaValueType.Null)))
        .Required(argument is null ? Array.Empty<string>() : ["argument"])
        .AdditionalProperties(false)
        .Build();

    private static PatternAction NoArgument<T>(string method, Action<T> invoke) where T : BasePattern =>
        new(Name<T>(method), value =>
        {
            if (value is { ValueKind: not (JsonValueKind.Null or JsonValueKind.Undefined) })
                throw Invalid("omit argument or pass null for this no-argument action");
            return pattern => invoke((T)pattern);
        }, Parameters(null));

    // Single parameters are direct JSON values; multiple parameters use their native parameter names.
    private static PatternAction WithArgument<T, TValue>(string method, Argument<TValue> argument, Action<T, TValue> invoke)
        where T : BasePattern
    {
        var parse = argument.Parse;
        return new(Name<T>(method), value =>
        {
            var parsed = parse(value);
            return pattern => invoke((T)pattern, parsed);
        }, Parameters(argument.Schema));
    }

    private static string Name<T>(string method) where T : BasePattern => typeof(T).Name[..^"Pattern".Length] + "." + method;

    private static NativeFailure Invalid(string expected) => new("INVALID_ARGUMENT", "Pattern action argument: " + expected);

    private static Argument<T> EnumValue<T>() where T : struct, Enum
    {
        var description = "Accepted values: " + string.Join(", ", Enum.GetNames<T>()) + " (case-sensitive).";
        return new(
            value =>
            {
                if (value is { ValueKind: JsonValueKind.String } text && Enum.TryParse<T>(text.GetString(), out var result)
                    && Enum.IsDefined(result) && result.ToString() == text.GetString()) return result;
                throw Invalid("pass one of: " + string.Join(", ", Enum.GetNames<T>()));
            },
            StringValue(description));
    }

    private static Argument<(T First, T Second)> Pair<T>(string first, string second, Argument<T> item)
    {
        var parse = item.Parse;
        return new(value =>
        {
            if (value is not { ValueKind: JsonValueKind.Object } fields
                || !fields.TryGetProperty(first, out var a) || !fields.TryGetProperty(second, out var b)
                || fields.EnumerateObject().Count() != 2)
                throw Invalid($"pass an object containing exactly {first} and {second}");
            return (parse(a), parse(b));
        }, new JsonSchemaBuilder()
            .Type(SchemaValueType.Object)
            .Properties((first, item.Schema), (second, item.Schema))
            .Required(first, second)
            .AdditionalProperties(false));
    }
}
