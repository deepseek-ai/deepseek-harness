// Formatting owns no native references or snapshot indices.
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace DeepSeek.Cua.Protocol;

public sealed record AccessibilityNode
{
    public required string Role { get; init; }
    public string Name { get; init; } = "";
    public string? Subrole { get; init; }
    public string? Help { get; init; }
    public string? Identifier { get; init; }
    public string? Value { get; init; }
    public string? Placeholder { get; init; }
    public bool HasValue { get; init; }
    public bool? Enabled { get; init; }
    public bool? Focused { get; init; }
    public bool? Selected { get; init; }
    public bool? Expanded { get; init; }
    public string? ValueWritable { get; init; }
    public bool? SelectionWritable { get; init; }
    public bool HasSelection { get; init; }
    public TextMatch? Selection { get; init; }
    public string? SelectedText { get; init; }
    public string[] Actions { get; init; } = [];
    public (double X, double Y, double Width, double Height)? Bounds { get; init; }
}

public static class AccessibilityText
{
    private static string Quote(string value) => JsonSerializer.Serialize(value, WireJson.Options);

    public static bool Retain(AccessibilityNode node) => node.Role is not ("AXGroup" or "AXScrollArea")
        || node.Name.Length != 0 || !string.IsNullOrEmpty(node.Help) || node.HasValue || node.Actions.Length != 0
        || node.Enabled == false || node.Focused == true || node.Selected.HasValue || node.Expanded.HasValue;

    public static string Format(AccessibilityNode node, int? index, bool details)
    {
        var text = new StringBuilder("- ");
        if (index is { } number) text.Append('[').Append(number).Append("] ");
        text.Append(node.Role);
        if (node.Subrole is { Length: > 0 } subrole) text.Append(" subrole=").Append(Quote(subrole));
        if (node.Enabled == false) text.Append(" disabled");
        if (node.Focused == true) text.Append(" focused");
        if (node.Selected is { } selected) text.Append(" selected=").Append(selected ? "true" : "false");
        if (node.Expanded is { } expanded) text.Append(" expanded=").Append(expanded ? "true" : "false");
        if (node.ValueWritable is { } writable) text.Append(" valueWritable=").Append(writable);
        if (node.SelectionWritable is { } selectionWritable) text.Append(" selectionWritable=").Append(selectionWritable ? "true" : "false");
        if (node.Name.Length != 0) text.Append(' ').Append(Quote(node.Name));
        if (node.HasValue) text.Append(" = ").Append(node.Value is { } value ? Quote(value) : "unavailable");
        if (node.Placeholder is { } placeholder) text.Append(" placeholder=").Append(Quote(placeholder));
        if (node.Help is { Length: > 0 } help && help != node.Name) text.Append(" help=").Append(Quote(help));
        if (node.HasSelection)
        {
            if (node.Selection is { } range && node.Value is { } value && range.Start >= 0 && range.Length >= 0
                && range.Start <= value.Length - range.Length)
                text.Append(" selection=[").Append(range.Start).Append(',').Append(range.Length).Append(']');
            else text.Append(" selection=unavailable");
            if (node.SelectedText is { Length: > 0 } selectedText) text.Append(" selectedText=").Append(Quote(selectedText));
        }
        var actions = details ? node.Actions : node.Actions.Where(action => action is not ("Press" or "Pick" or "ScrollToVisible")).ToArray();
        if (actions.Length != 0) text.Append(" actions=[").Append(string.Join(", ", actions.Select(Quote))).Append(']');
        if (details)
        {
            if (node.Identifier is { Length: > 0 } identifier) text.Append(" id=").Append(Quote(identifier));
            if (index.HasValue && node.Bounds is { } bounds)
                text.Append(" bounds=[").Append(string.Join(",", new[] { bounds.X, bounds.Y, bounds.Width, bounds.Height }
                    .Select(number => number.ToString("G", CultureInfo.InvariantCulture)))).Append(']');
        }
        return text.ToString();
    }
}
