// Literal selection and CF_HTML encoding are independent of Windows UI Automation.
using System.Globalization;
using System.Text;

namespace DeepSeek.Cua.Protocol;

public readonly record struct TextMatch(int Start, int Length);

public static class TextSelection
{
    /// <summary>Find one literal UTF-16 range, with immediately adjacent optional context.</summary>
    public static TextMatch Find(string value, string text, string? prefix, string? suffix)
    {
        if (text.Length == 0) throw new NativeFailure("INVALID_ARGUMENT", "Selection text must not be empty");
        TextMatch? selected = null;
        for (var offset = 0; offset <= value.Length - text.Length;)
        {
            var start = value.IndexOf(text, offset, StringComparison.Ordinal);
            if (start < 0) break;
            var end = start + text.Length;
            var before = prefix is null || (start >= prefix.Length && value.AsSpan(start - prefix.Length, prefix.Length).SequenceEqual(prefix));
            var after = suffix is null || (end + suffix.Length <= value.Length && value.AsSpan(end, suffix.Length).SequenceEqual(suffix));
            if (before && after)
            {
                if (selected is not null) throw new NativeFailure("AMBIGUOUS_TEXT", "Add immediately adjacent prefix or suffix text");
                selected = new(start, text.Length);
            }
            offset = start + 1;
        }
        return selected ?? throw new NativeFailure("TEXT_NOT_FOUND", "Read fresh state before selecting text");
    }
}

public static class HtmlClipboard
{
    /// <summary>CF_HTML offsets count UTF-8 bytes, independently of UTF-16 selection offsets.</summary>
    public static byte[] Encode(string fragment)
    {
        const string before = "<html><body><!--StartFragment-->";
        const string after = "<!--EndFragment--></body></html>";
        const string template = "Version:1.0\r\nStartHTML:{0:D10}\r\nEndHTML:{1:D10}\r\nStartFragment:{2:D10}\r\nEndFragment:{3:D10}\r\n";
        var headerSize = Encoding.UTF8.GetByteCount(string.Format(CultureInfo.InvariantCulture, template, 0, 0, 0, 0));
        var start = headerSize + Encoding.UTF8.GetByteCount(before);
        var end = start + Encoding.UTF8.GetByteCount(fragment);
        var header = string.Format(CultureInfo.InvariantCulture, template, headerSize,
            end + Encoding.UTF8.GetByteCount(after), start, end);
        return Encoding.UTF8.GetBytes(header + before + fragment + after + "\0");
    }
}
