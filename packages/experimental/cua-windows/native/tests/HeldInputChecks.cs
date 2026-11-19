// The fake input stream drives the same admission and hook callbacks as SendInput.
using System.Text.Json;
using DeepSeek.Cua.Protocol;
using DeepSeek.Cua.Windows;

internal static class HeldInputChecks
{
    internal static void Run(Action<bool, string> check, Action<Action, string> refuses)
    {
        var a = Guid.NewGuid();
        var b = Guid.NewGuid();
        var target = new HeldInputs.Target("app", 72, 122, 100);
        var physical = new HashSet<ushort>();
        var events = new List<string>();
        var blocked = false;
        var overlap = false;
        var interactive = true;
        HeldInputs inputs = null!;
        inputs = new(physical.Contains, input =>
        {
            if (blocked) throw new NativeFailure("INPUT_BLOCKED", "SendInput returned zero");
            var isKey = input.Type == 1;
            var control = isKey ? input.Data.Keyboard.Key : (ushort)1;
            var tag = isKey ? input.Data.Keyboard.Extra : input.Data.Mouse.Extra;
            var up = isKey ? (input.Data.Keyboard.Flags & 2) != 0 : input.Data.Mouse.Flags == 4;
            if (overlap) inputs.Observe(control, 0, () => 0);
            inputs.Observe(control, tag, () => { events.Add($"{control}:{(up ? "up" : "down")}"); return 0; });
        }, () =>
        {
            if (!interactive) throw new NativeFailure("SESSION_LOCKED", "The interactive desktop is unavailable");
        });

        bool Key(Guid connection, string task, ushort key, string name, CancellationToken cancellation = default)
            => inputs.Down(connection, task, target, key, name,
                new() { Type = 1, Data = new() { Keyboard = new() { Key = key } } },
                new() { Type = 1, Data = new() { Keyboard = new() { Key = key, Flags = 2 } } },
                cancellation, 100);

        physical.Add(16);
        refuses(() => Key(a, "task", 16, "shift"), "INPUT_BUSY");
        check(events.Count == 0, "Physical input cannot become an owned hold");
        physical.Clear();
        blocked = true;
        refuses(() => Key(a, "task", 16, "shift"), "INPUT_BLOCKED");
        check(inputs.Get(a, "task").Length == 0, "A refused down does not cause an up");
        blocked = false;
        check(Key(a, "task", 16, "shift"), "Record the accepted keyboard down");
        check(inputs.Down(a, "task", target, 1, "left",
            new() { Data = new() { Mouse = new() { Flags = 2 } } },
            new() { Data = new() { Mouse = new() { Flags = 4 } } }, default, 100), "Record the accepted mouse down");
        check(Key(a, "task", 87, "w") && !Key(a, "task", 87, "w"), "A repeated key does not duplicate a hold");
        refuses(() => inputs.RequireOwner(b, "task", "app", 72), "INPUT_BUSY");
        refuses(() => inputs.RequireOwner(a, "other", "app", 72), "INPUT_BUSY");
        refuses(() => inputs.RequireAvailable(1), "INPUT_BUSY");
        refuses(() => inputs.Up(a, "other", "app", 72, "w", true, 100), "INPUT_NOT_HELD");
        refuses(() => inputs.Up(a, "task", "app", 73, "w", true, 100), "INPUT_NOT_HELD");
        check(inputs.Release(b, null, default, 100).Length == 0, "Another connection releases nothing");
        check(inputs.Get(a, "other").Length == 0 && inputs.Get(a, "task").Length == 3, "State query is task-scoped");
        var described = JsonSerializer.SerializeToElement(inputs.Get(a, "task"), WireJson.Options);
        check(described[0].GetProperty("windowId").GetString() == "72" && described[0].GetProperty("mode").GetString() == "system",
            "Keyboard reminders identify the window and actual desktop mode");
        check(inputs.Up(a, "task", "app", 72, "shift", true, 100) && Key(a, "task", 16, "shift"),
            "Explicit up and repress update the dispatch order");
        check(inputs.Release(a, "task", default, 100).Length == 3
            && events.TakeLast(3).SequenceEqual(["16:up", "87:up", "1:up"]), "Release in mixed reverse order, including repress");
        check(inputs.Release(a, null, default, 100).Length == 0, "Duplicate connection cleanup sends no up");
        using (var cancelled = new CancellationTokenSource())
        {
            cancelled.Cancel();
            try { Key(a, "task", 87, "w", cancelled.Token); throw new Exception("Expected cancelled down"); }
            catch (OperationCanceledException) { check(inputs.Get(a, "task").Length == 0, "Cancelled down never dispatches"); }
        }
        Key(a, "task", 87, "w");
        interactive = false;
        refuses(() => inputs.Release(a, null, default, 100), "INPUT_CLEANUP_FAILED");
        check(inputs.Get(a, "task").Length == 1, "A locked desktop leaves the failed release recorded");
        interactive = true;
        blocked = true;
        refuses(() => inputs.Release(a, null, default, 100), "INPUT_CLEANUP_FAILED");
        check(inputs.Get(a, "task").Length == 1, "A refused release stays recorded for disconnect fallback");
        blocked = false;
        var count = events.Count;
        overlap = true;
        check(inputs.Release(a, null, default, 100).Length == 0 && inputs.Get(a, "task").Length == 0 && events.Count == count,
            "An external event at dispatch time wins and the owned event cannot lift user input");
    }
}
