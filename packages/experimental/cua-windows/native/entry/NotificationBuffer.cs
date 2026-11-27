// Event callbacks may run concurrently with reads on the UI Automation dispatcher.
using System.Text;

namespace DeepSeek.Cua.Windows;

internal readonly record struct UiaNotice(string Kind, string? Id);

internal sealed class NotificationBuffer(int limit)
{
    private readonly object gate = new();
    private readonly HashSet<UiaNotice> pending = [];
    private bool overflow;

    internal void Add(UiaNotice notice)
    {
        lock (gate)
        {
            if (!overflow && pending.Add(notice) && pending.Count > limit)
            {
                overflow = true;
                pending.Clear();
            }
        }
    }

    // New callbacks after the drain belong to the next read.
    internal NotificationBatch Take()
    {
        lock (gate)
        {
            var batch = overflow ? null : pending.ToArray();
            overflow = false;
            pending.Clear();
            return new(batch);
        }
    }
}

// A missing notice array records overflow, including when the current tree is also incomplete.
internal readonly record struct NotificationBatch(UiaNotice[]? Notices)
{
    private const string TooLarge = "Diff too large. Showing the current tree instead.\n";

    internal string Format(Func<string, string?> currentRow, Func<string, bool> wasVisible, string fullTree, bool incomplete)
    {
        if (Notices == null) return TooLarge + fullTree;
        if (incomplete) return fullTree;
        if (Notices.Length == 0) return "No UIA notifications received.";
        var lines = new HashSet<string>(StringComparer.Ordinal);
        long bytes = 0;
        var fullBytes = Encoding.UTF8.GetByteCount(fullTree);
        foreach (var notice in Notices)
        {
            var line = notice.Kind;
            if (notice.Id is { } id)
            {
                if (notice.Kind == "ChildRemoved")
                {
                    if (wasVisible(id)) line += $" (previous ID {id})";
                }
                else if (currentRow(id) is { } row) line += " " + row;
            }
            if (!lines.Add(line)) continue;
            bytes += Encoding.UTF8.GetByteCount(line) + (lines.Count > 1 ? 1 : 0);
            if (bytes >= fullBytes) return TooLarge + fullTree;
        }
        return string.Join('\n', lines);
    }
}
