namespace DeepSeek.Cua.Protocol;

public static class KeyChord
{
    public static string[] ModifiersForPress(string key, IEnumerable<string> names)
    {
        var modifiers = names.Select(NormalizeModifier).Distinct().ToArray();
        var name = key.ToLowerInvariant();
        if (modifiers.Contains("win") || name == "printscreen" || modifiers.Contains("alt") && name is "tab" or "escape" or "esc"
            || modifiers.Contains("ctrl") && name is "escape" or "esc"
            || modifiers.Contains("ctrl") && modifiers.Contains("alt") && name == "delete")
            throw new NativeFailure("UNSUPPORTED", "This shortcut acts on the system rather than the selected application");
        return modifiers;
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
