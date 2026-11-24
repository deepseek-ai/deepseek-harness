// Distinct insert positions can have the same UIA event and different observed trees.
using DeepSeek.Cua.Windows;
using System.Text;

internal static class NotificationChecks
{
    internal static void Run(Action<bool, string> check)
    {
        var buffer = new NotificationBuffer(2);
        var added = new UiaNotice("ChildAdded", "1/3");
        buffer.Add(added);
        buffer.Add(added);
        var batch = buffer.Take().Notices!;
        check(batch.SequenceEqual([added]), "Repeated notices for one element occupy one entry");
        check(buffer.Take().Notices!.Length == 0, "Reading consumes notifications");
        buffer.Add(added);
        var bulk = new UiaNotice("ChildrenBulkAdded", "1");
        buffer.Add(bulk);
        buffer.Add(added);
        check(buffer.Take().Notices!.Length == 2, "Exactly the configured limit of distinct notifications is retained");
        buffer.Add(added);
        buffer.Add(bulk);
        buffer.Add(new("ChildRemoved", "1/2"));
        var overflow = buffer.Take();
        check(overflow.Notices == null, "Exceeding the limit discards the partial batch");
        buffer.Add(added);
        check(buffer.Take().Notices!.SequenceEqual(batch), "The next interval can report changes after overflow");

        const string parent = "- [1] Window \"Editor\"";
        const string left = "  - [1/1] Button \"Open\"";
        const string right = "  - [1/2] Button \"Close\"";
        const string save = "[1/3] Button \"Save\"";
        var atStart = string.Join('\n', parent, "  - " + save, left, right);
        var atEnd = string.Join('\n', parent, left, right, "  - " + save);
        string Summary(UiaNotice[]? changes, string tree, bool truncated = false) => new NotificationBatch(changes).Format(
            id => id == "1/3" ? save : null, id => id == "1/2", tree, truncated);
        var summary = Summary(batch, atStart);
        check(summary == "ChildAdded " + save && Summary(batch, atEnd) == summary && atStart != atEnd,
            "The UIA child-added summary names a child without asserting its sibling position");
        check(Summary([new("ChildRemoved", "1/2"), new("ChildRemoved", "9")], atEnd) ==
            "ChildRemoved (previous ID 1/2)\nChildRemoved", "Only disclosed old IDs identify removed nodes");
        check(Summary([new("ChildrenInvalidated", "9")], atEnd) == "ChildrenInvalidated",
            "An absent sender has no actionable ID");
        check(Summary([], atEnd) == "No UIA notifications received.", "An empty batch reports only notification delivery");
        const string fallback = "Diff too large. Showing the current tree instead.\n";
        check(Summary(overflow.Notices, atEnd) == fallback + atEnd, "Count overflow labels and returns the current tree unchanged");
        check(Summary(batch, "树") == fallback + "树", "A longer summary labels the shorter tree");
        check(Summary([new("中中", null)], "123456") == fallback + "123456", "Equal UTF-8 byte counts also select the tree");
        check(Summary([new("Added", null)], "中中") == "Added", "A smaller UTF-8 summary is retained");
        check(Summary(batch, "tree [truncated]", true) == "tree [truncated]", "Truncation by itself does not label the diff too large");
        check(Summary(overflow.Notices, "tree [truncated]", true) == fallback + "tree [truncated]", "The fallback preserves the truncation marker");
        Console.WriteLine($"UIA insertion example: full {Encoding.UTF8.GetByteCount(atStart)} bytes; notification {Encoding.UTF8.GetByteCount(summary)} bytes");
    }
}
