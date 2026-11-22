// One connection listens to the subtree of its most recent opted-in window.
using System.Globalization;
using System.Runtime.InteropServices;
using System.Windows.Automation;

namespace DeepSeek.Cua.Windows;

internal sealed record ObservationScope(WindowState Window, int MaxElements, int MaxDepth, bool IncludeMenus, bool Details);

internal sealed class WindowNotifications(int maxDiffNotifications)
{
    private readonly Stack<Action> unsubscribe = new();
    private ObservationScope? scope;
    private NotificationBuffer? buffer;
    internal string? LastSnapshot { get; set; }

    // Only the MTA dispatcher changes registrations. A late callback owns only its original buffer.
    internal NotificationBatch? Begin(AutomationElement root, ObservationScope next, string? previousSnapshot,
        AutomationProperty[] properties)
    {
        var comparable = scope == next && LastSnapshot != null && LastSnapshot == previousSnapshot;
        LastSnapshot = null;
        if (scope != next)
        {
            Stop();
            var pending = new NotificationBuffer(maxDiffNotifications);
            using var cache = new CacheRequest { TreeScope = TreeScope.Element, AutomationElementMode = AutomationElementMode.None }.Activate();
            StructureChangedEventHandler structure = (sender, e) =>
            {
                var id = e.StructureChangeType == StructureChangeType.ChildRemoved ? e.GetRuntimeId() : CachedId(sender);
                pending.Add(new(e.StructureChangeType.ToString(), Id(id)));
            };
            AutomationPropertyChangedEventHandler property = (sender, _) => pending.Add(new("PropertyChanged", Id(CachedId(sender))));
            AutomationEventHandler text = (sender, e) => pending.Add(new(
                e.EventId == TextPattern.TextChangedEvent ? "TextChanged" : "TextSelectionChanged", Id(CachedId(sender))));
            try
            {
                Automation.AddStructureChangedEventHandler(root, TreeScope.Subtree, structure);
                unsubscribe.Push(() => Automation.RemoveStructureChangedEventHandler(root, structure));
                Automation.AddAutomationPropertyChangedEventHandler(root, TreeScope.Subtree, property, properties);
                unsubscribe.Push(() => Automation.RemoveAutomationPropertyChangedEventHandler(root, property));
                foreach (var eventId in new[] { TextPattern.TextChangedEvent, TextPattern.TextSelectionChangedEvent })
                {
                    Automation.AddAutomationEventHandler(eventId, root, TreeScope.Subtree, text);
                    unsubscribe.Push(() => Automation.RemoveAutomationEventHandler(eventId, root, text));
                }
            }
            catch
            {
                Stop();
                throw;
            }
            scope = next;
            buffer = pending;
        }
        var notices = buffer!.Take();
        return comparable ? notices : null;
    }

    private static int[]? CachedId(object sender)
    {
        // RuntimeId is included in the default CacheRequest, even with no live element reference.
        try { return (sender as AutomationElement)?.GetCachedPropertyValue(AutomationElement.RuntimeIdProperty, true) as int[]; }
        catch (Exception error) when (error is InvalidOperationException or ElementNotAvailableException or COMException)
        { return null; }
    }

    internal static string? Id(int[]? parts) => parts is { Length: > 0 }
        ? string.Join('/', parts.Select(part => part.ToString(CultureInfo.InvariantCulture))) : null;

    internal void Stop()
    {
        LastSnapshot = null;
        scope = null;
        buffer = null;
        List<Exception>? failures = null;
        while (unsubscribe.TryPop(out var remove))
        {
            try { remove(); }
            catch (Exception error) { (failures ??= []).Add(error); }
        }
        if (failures != null) throw new AggregateException("Failed to remove UI Automation event handlers", failures);
    }
}
