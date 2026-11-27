// Bounded traversal publishes readable nodes and marks elements that disappear while the tree is read.
namespace DeepSeek.Cua.Protocol;

/// <summary>
/// Element reads for one accessibility observation. Every callback may throw an exception that
/// <see cref="Disappeared"/> accepts when the element stopped existing during the observation.
/// </summary>
public sealed record AccessibilitySource<TElement>(
    Func<TElement, string> RuntimeId,
    Func<TElement, AccessibilityNode> Read,
    Func<TElement, TElement?> FirstChild,
    Func<TElement, TElement?> NextSibling,
    Func<Exception, bool> Disappeared,
    Action Check) where TElement : class;

/// <summary>
/// Depth-first traversal under element and depth limits. A disappeared descendant becomes a marker row
/// and sets <see cref="HasUnreadableElements"/>; a disappeared root propagates its exception.
/// <c>retain</c> receives each disclosed RuntimeId with its element and unindented row before <c>add</c> receives the row.
/// </summary>
public sealed class AccessibilityTraversal<TElement>(AccessibilitySource<TElement> source, int maximumElements, int maximumDepth,
    bool includeMenus, bool details, Action<string> add, Action<string, TElement, string> retain) where TElement : class
{
    private readonly HashSet<string> visited = new(StringComparer.Ordinal);
    private int count;

    /// <summary>Whether an element or depth limit omitted part of the tree.</summary>
    public bool Truncated { get; private set; }

    /// <summary>Whether a marker row replaces an element or the rest of a child list.</summary>
    public bool HasUnreadableElements { get; private set; }

    /// <summary>Appends the rows of <paramref name="root"/> and its readable descendants.</summary>
    /// <param name="root">Element whose own disappearance fails the observation.</param>
    public void Walk(TElement root) => Visit(root, 0, 0);

    private void Visit(TElement element, int depth, int indent)
    {
        source.Check();
        if (count >= maximumElements || depth >= maximumDepth) { Truncated = true; return; }
        count++;
        string runtimeId;
        AccessibilityNode node;
        try
        {
            runtimeId = source.RuntimeId(element);
            if (!visited.Add(runtimeId)) return;
            node = source.Read(element);
        }
        catch (Exception error) when (depth > 0 && source.Disappeared(error))
        {
            Unreadable(indent, positioned: true);
            return;
        }
        var retained = AccessibilityText.Retain(node);
        if (retained)
        {
            var row = AccessibilityText.Format(node, runtimeId, details);
            retain(runtimeId, element, row);
            add(AccessibilityText.Indent(indent) + row);
        }
        if (!includeMenus && node.ControlType == "Menu")
        {
            add(AccessibilityText.Indent(indent + 1) + "[menu contents omitted; includeMenus:true]");
            return;
        }
        var childIndent = indent + (retained ? 1 : 0);
        if (!Step(() => source.FirstChild(element), childIndent, out var child)) return;
        if (child is not null && depth + 1 >= maximumDepth) { Truncated = true; return; }
        while (child is not null)
        {
            var current = child;
            Visit(current, depth + 1, childIndent);
            if (!Step(() => source.NextSibling(current), childIndent, out child)) return;
            if (count >= maximumElements)
            {
                if (child is not null) Truncated = true;
                return;
            }
        }
    }

    private bool Step(Func<TElement?> step, int indent, out TElement? element)
    {
        try
        {
            element = step();
            return true;
        }
        catch (Exception error) when (source.Disappeared(error))
        {
            element = null;
            Unreadable(indent, positioned: false);
            return false;
        }
    }

    private void Unreadable(int indent, bool positioned)
    {
        HasUnreadableElements = true;
        add(AccessibilityText.Indent(indent) + (positioned ? AccessibilityText.UnreadableElement : AccessibilityText.IncompleteChildList));
    }
}
