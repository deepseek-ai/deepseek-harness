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

    // Null means the observation must return the full tree. New callbacks belong to the next read.
    internal UiaNotice[]? Take()
    {
        lock (gate)
        {
            var batch = overflow ? null : pending.ToArray();
            overflow = false;
            pending.Clear();
            return batch;
        }
    }

    internal static string Format(UiaNotice[] notices, Func<string, string?> currentRow, Func<string, bool> wasVisible,
        string fullTree)
    {
        if (notices.Length == 0) return "No UIA notifications received.";
        var lines = new HashSet<string>(StringComparer.Ordinal);
        var bytes = 0;
        var fullBytes = Encoding.UTF8.GetByteCount(fullTree);
        foreach (var notice in notices)
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
            if (bytes >= fullBytes) return fullTree;
        }
        return string.Join('\n', lines);
    }
}
