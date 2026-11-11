namespace DeepSeek.Cua.Protocol;

public sealed record KeyChord(string Key, string[] Modifiers)
{
    public static KeyChord Parse(string text, IEnumerable<string> extra)
    {
        if (text.Length == 0) throw new NativeFailure("INVALID_ARGUMENT", "A key name is required");
        var plus = text == "+" || text.EndsWith("++", StringComparison.Ordinal);
        var parts = plus ? text[..^1].TrimEnd('+').Split(new[] { '+' }, StringSplitOptions.RemoveEmptyEntries) : text.Split('+');
        var key = plus ? "+" : parts[^1];
        if (key.Length == 0) throw new NativeFailure("INVALID_ARGUMENT", "A key chord must end with a key");
        var modifiers = (plus ? parts : parts.Take(parts.Length - 1)).Concat(extra).Select(NormalizeModifier).Distinct().ToArray();
        return new(key, modifiers);
    }

    public static string NormalizeModifier(string value) => value.ToLowerInvariant() switch
    {
        "ctrl" or "control" => "ctrl",
        "shift" => "shift",
        "alt" => "alt",
        "win" => "win",
        "fn" => throw new NativeFailure("UNSUPPORTED", "Fn is typically handled by keyboard firmware rather than exposed as a distinct key in the Windows input layer"),
        _ => throw new NativeFailure("INVALID_ARGUMENT", "Unknown key modifier"),
    };
}
