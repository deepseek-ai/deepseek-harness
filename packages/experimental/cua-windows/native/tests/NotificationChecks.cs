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
        var batch = buffer.Take()!;
        check(batch.SequenceEqual([added]), "Repeated notices for one element occupy one entry");
        check(buffer.Take()!.Length == 0, "Reading consumes notifications");
        buffer.Add(added);
        buffer.Add(new("ChildrenBulkAdded", "1"));
        buffer.Add(new("ChildRemoved", "1/2"));
        check(buffer.Take() == null, "Overflow asks for the current full tree");
        buffer.Add(added);
        check(buffer.Take()!.SequenceEqual(batch), "The next interval can report changes after overflow");

        const string parent = "- [1] Window \"Editor\"";
        const string left = "  - [1/1] Button \"Open\"";
        const string right = "  - [1/2] Button \"Close\"";
        const string save = "[1/3] Button \"Save\"";
        var atStart = string.Join('\n', parent, "  - " + save, left, right);
        var atEnd = string.Join('\n', parent, left, right, "  - " + save);
        string Summary(UiaNotice[] changes, string tree) => NotificationBuffer.Format(changes,
            id => id == "1/3" ? save : null, id => id == "1/2", tree);
        var summary = Summary(batch, atStart);
        check(summary == "ChildAdded " + save && Summary(batch, atEnd) == summary && atStart != atEnd,
            "The UIA child-added summary names a child without asserting its sibling position");
        check(Summary([new("ChildRemoved", "1/2"), new("ChildRemoved", "9")], atEnd) ==
            "ChildRemoved (previous ID 1/2)\nChildRemoved", "Only disclosed old IDs identify removed nodes");
        check(Summary([new("ChildrenInvalidated", "9")], atEnd) == "ChildrenInvalidated",
            "An absent sender has no actionable ID");
        check(Summary([], atEnd) == "No UIA notifications received.", "An empty batch reports only notification delivery");
        check(Summary(batch, "树") == "树", "The full tree is returned when shorter");
        Console.WriteLine($"UIA insertion example: full {Encoding.UTF8.GetByteCount(atStart)} bytes; notification {Encoding.UTF8.GetByteCount(summary)} bytes");
    }
}
