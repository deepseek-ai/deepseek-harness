// A disappeared descendant becomes a marker row; readable siblings and the rest of the tree remain observable.
using DeepSeek.Cua.Protocol;

internal static class AccessibilityTraversalChecks
{
    internal static void Run(Action<bool, string> check)
    {
        var whole = Traverse(new FakeElement("R", new FakeElement("A"), new FakeElement("B")));
        check(whole.Rows.SequenceEqual([Row(0, "R"), Row(1, "A"), Row(1, "B")]) && !whole.Traversal.HasUnreadableElements
            && !whole.Traversal.Truncated, "A stable tree has no unreadable marker");

        var vanished = Traverse(new FakeElement("R", new FakeElement("A"), new FakeElement("B") { Gone = true }, new FakeElement("C")));
        check(vanished.Rows.SequenceEqual([Row(0, "R"), Row(1, "A"), "  [One child could not be read.]", Row(1, "C")]),
            "A disappeared element is replaced by a positioned marker and later siblings remain readable");
        check(vanished.Retained.SequenceEqual(["R", "A", "C"]) && vanished.Traversal.HasUnreadableElements,
            "A disappeared element receives no element ID and marks the observation");

        var siblings = Traverse(new FakeElement("R",
            new FakeElement("P1", new FakeElement("A") { SiblingsGone = true }, new FakeElement("A2")), new FakeElement("P2")));
        check(siblings.Rows.SequenceEqual([Row(0, "R"), Row(1, "P1"), Row(2, "A"), "    [Child list incomplete.]", Row(1, "P2")]),
            "A failed sibling step marks only that child list and keeps the parent's siblings");

        var children = Traverse(new FakeElement("R", new FakeElement("P1", new FakeElement("A")) { ChildrenGone = true }, new FakeElement("P2")));
        check(children.Rows.SequenceEqual([Row(0, "R"), Row(1, "P1"), "    [Child list incomplete.]", Row(1, "P2")])
            && children.Traversal.HasUnreadableElements, "A failed first-child step marks the unread child list");

        var limited = Traverse(new FakeElement("R", new FakeElement("A"), new FakeElement("B") { Gone = true }, new FakeElement("C")), maximumElements: 2);
        check(limited.Rows.SequenceEqual([Row(0, "R"), Row(1, "A")]) && limited.Traversal.Truncated && !limited.Traversal.HasUnreadableElements,
            "Element limits stop traversal before unread elements are reached");

        check(Throws(() => Traverse(new FakeElement("R", new FakeElement("A")) { Gone = true })), "A disappeared root fails the observation");
        check(Throws(() => Traverse(new FakeElement("R", new FakeElement("A") { Gone = true }), disappeared: _ => false)),
            "Element failures that are not disappearance propagate");
    }

    private static string Row(int level, string id) => AccessibilityText.Indent(level) + $"- [{id}] Button \"{id}\"";

    private static bool Throws(Action action)
    {
        try { action(); return false; }
        catch (FakeDisappeared) { return true; }
    }

    private static (List<string> Rows, List<string> Retained, AccessibilityTraversal<FakeElement> Traversal) Traverse(FakeElement root,
        int maximumElements = 100, int maximumDepth = 10, Func<Exception, bool>? disappeared = null)
    {
        Link(root);
        var rows = new List<string>();
        var retained = new List<string>();
        var traversal = new AccessibilityTraversal<FakeElement>(new(
            element => element.Gone ? throw new FakeDisappeared() : element.Id,
            element => new AccessibilityNode { ControlType = "Button", Name = element.Id },
            element => element.ChildrenGone ? throw new FakeDisappeared() : element.Children.FirstOrDefault(),
            element => element.SiblingsGone ? throw new FakeDisappeared() : NextSibling(element),
            disappeared ?? (error => error is FakeDisappeared), () => { }),
            maximumElements, maximumDepth, includeMenus: false, details: false, rows.Add, (runtimeId, _, _) => retained.Add(runtimeId));
        traversal.Walk(root);
        return (rows, retained, traversal);
    }

    private static void Link(FakeElement element)
    {
        foreach (var child in element.Children)
        {
            child.Parent = element;
            Link(child);
        }
    }

    private static FakeElement? NextSibling(FakeElement element)
    {
        if (element.Parent is not { } parent) return null;
        var index = Array.IndexOf(parent.Children, element);
        return index + 1 < parent.Children.Length ? parent.Children[index + 1] : null;
    }

    private sealed class FakeElement(string id, params FakeElement[] children)
    {
        public string Id { get; } = id;
        public FakeElement[] Children { get; } = children;
        public FakeElement? Parent { get; set; }
        public bool Gone { get; init; }
        public bool ChildrenGone { get; init; }
        public bool SiblingsGone { get; init; }
    }

    private sealed class FakeDisappeared() : Exception("The element disappeared");
}
