// The receiver records accepted dispatches and can refuse an individual down or up.
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
        var events = new List<string>();
        var blocked = false;
        void Receive(Win32.Input input)
        {
            if (blocked) throw new NativeFailure("INPUT_BLOCKED", "SendInput returned zero");
            var isKey = input.Type == 1;
            var control = isKey ? input.Data.Keyboard.Key : (ushort)1;
            var up = isKey ? (input.Data.Keyboard.Flags & 2) != 0 : input.Data.Mouse.Flags == 4;
            events.Add($"{control}:{(up ? "up" : "down")}");
        }
        var inputs = new HeldInputs(Receive);

        bool Key(Guid connection, ushort key, string name, CancellationToken cancellation = default)
            => inputs.Down(connection, target, key, name,
                new() { Type = 1, Data = new() { Keyboard = new() { Key = key } } },
                new() { Type = 1, Data = new() { Keyboard = new() { Key = key, Flags = 2 } } },
                cancellation);

        refuses(() => inputs.Up(a, "app", 72, "shift", true), "INPUT_NOT_HELD");
        check(events.Count == 0, "No up is sent for a key the helper never pressed");
        blocked = true;
        refuses(() => Key(a, 16, "shift"), "INPUT_BLOCKED");
        check(inputs.Get(a).Length == 0, "A refused down does not cause an up");
        blocked = false;
        check(Key(a, 16, "shift"), "Record the accepted keyboard down");
        check(inputs.Down(a, target, 1, "left",
            new() { Data = new() { Mouse = new() { Flags = 2 } } },
            new() { Data = new() { Mouse = new() { Flags = 4 } } }, default), "Record the accepted mouse down");
        check(Key(a, 87, "w") && !Key(a, 87, "w"), "A repeated key does not duplicate a hold");
        refuses(() => Key(b, 87, "w"), "INPUT_BUSY");
        refuses(() => inputs.RequireAvailable(1), "INPUT_BUSY");
        refuses(() => inputs.Up(b, "app", 72, "w", true), "INPUT_NOT_HELD");
        refuses(() => inputs.Up(a, "app", 73, "w", true), "INPUT_NOT_HELD");
        check(inputs.Release(b, default).Length == 0, "Another connection releases nothing");
        check(inputs.Get(b).Length == 0 && inputs.Get(a).Length == 3, "State query is connection-scoped");
        var described = JsonSerializer.SerializeToElement(inputs.Get(a), WireJson.Options);
        check(described[0].GetProperty("windowId").GetString() == "72" && described[0].GetProperty("mode").GetString() == "system",
            "Keyboard reminders identify the window and actual desktop mode");
        inputs.Up(a, "app", 72, "shift", true);
        check(Key(a, 16, "shift"), "Explicit up and repress update the dispatch order");
        check(inputs.Release(a, default).Length == 3
            && events.TakeLast(3).SequenceEqual(["16:up", "87:up", "1:up"]), "Release in mixed reverse order, including repress");
        check(inputs.Release(a, default).Length == 0, "Duplicate connection cleanup sends no up");
        Key(a, 87, "w");
        Key(b, 68, "d");
        var beforeRelease = events.Count;
        inputs.Up(a, "app", 72, "w", true);
        check(inputs.Get(b).Length == 1 && events.Skip(beforeRelease).SequenceEqual(["87:up"]),
            "One connection can release W while another holds D");
        inputs.Up(b, "app", 72, "d", true);
        using (var cancelled = new CancellationTokenSource())
        {
            cancelled.Cancel();
            try { Key(a, 87, "w", cancelled.Token); throw new Exception("Expected cancelled down"); }
            catch (OperationCanceledException) { check(inputs.Get(a).Length == 0, "Cancelled down never dispatches"); }
        }
        Key(a, 87, "w");
        blocked = true;
        refuses(() => inputs.Release(a, default), "INPUT_CLEANUP_FAILED");
        check(inputs.Get(a).Length == 1, "A refused release stays recorded for disconnect fallback");
        blocked = false;
        // Another source releases W and presses D at the same receiver.
        Receive(new() { Type = 1, Data = new() { Keyboard = new() { Key = 87, Flags = 2 } } });
        Receive(new() { Type = 1, Data = new() { Keyboard = new() { Key = 68 } } });
        described = JsonSerializer.SerializeToElement(inputs.Get(a), WireJson.Options);
        check(described.GetArrayLength() == 1 && described[0].GetProperty("key").GetString() == "w",
            "The reminder still reports only the helper's W down");
        var count = events.Count;
        using var desktopQueue = new SemaphoreSlim(1, 1);
        inputs.ReleaseOnDisconnect(a, desktopQueue, 1000).GetAwaiter().GetResult();
        check(inputs.Get(a).Length == 0 && events.Skip(count).SequenceEqual(["87:up"]),
            "Disconnect retries the helper's W release and leaves D alone");

        Key(b, 68, "d");
        foreach (var occupied in new[] { false, true })
        {
            Key(a, 87, "w");
            if (occupied) desktopQueue.Wait();
            blocked = !occupied;
            inputs.ReleaseOnDisconnect(a, desktopQueue, occupied ? 0 : 1000).GetAwaiter().GetResult();
            blocked = false;
            check(inputs.Get(a).Length == 0 && inputs.Get(b).Length == 1,
                "Refused or expired disconnect cleanup drops only the disconnected owner's records");
            if (occupied) desktopQueue.Release();
        }
        check(Key(b, 87, "w"), "The remaining connection can use W after disconnect cleanup fails");
        inputs.Release(b, default);
    }
}
