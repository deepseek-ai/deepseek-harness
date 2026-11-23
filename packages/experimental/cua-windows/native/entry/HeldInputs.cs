// Held keys and buttons share one dispatch order across all connections to this desktop executor.
using System.Globalization;
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal sealed class HeldInputs(Action<Win32.Input> send)
{
    internal readonly record struct Target(string AppHandle, nint Window);
    private sealed record Press(Guid Connection, Target Target, ushort Control, string Name, Win32.Input Up)
    {
        internal object Describe() => new
        {
            kind = Up.Type == 1 ? "key" : "mouse", key = Up.Type == 1 ? Name : null,
            button = Up.Type == 0 ? Name : null, appHandle = Target.AppHandle,
            windowId = Target.Window.ToString(CultureInfo.InvariantCulture), mode = "system",
        };
    }

    private readonly object gate = new();
    private readonly List<Press> pressed = [];

    internal void RequireAvailable(ushort control)
    {
        lock (gate)
            if (pressed.Any(press => press.Control == control))
                throw new NativeFailure("INPUT_BUSY", "This key or button is already held; release it before a complete action uses it");
    }

    internal bool Down(Guid connection, Target target, ushort control, string name, Win32.Input down,
        Win32.Input up, CancellationToken cancellation)
    {
        lock (gate)
        {
            cancellation.ThrowIfCancellationRequested();
            var existing = pressed.Find(press => press.Control == control);
            if (existing is not null)
            {
                if (existing.Connection == connection && existing.Target == target && existing.Name == name)
                    return false;
                throw new NativeFailure("INPUT_BUSY", "This key or button is already held by another input target");
            }

            var press = new Press(connection, target, control, name, up);
            pressed.Add(press);
            try { send(down); }
            catch (NativeFailure error) when (error.Code == "INPUT_BLOCKED")
            {
                // SendInput accepted zero events, so there is no corresponding up to send.
                pressed.Remove(press);
                throw;
            }
            return true;
        }
    }

    internal void Up(Guid connection, string app, nint? window, string name, bool keyboard)
    {
        lock (gate)
        {
            var index = pressed.FindIndex(press => press.Connection == connection && press.Target.AppHandle == app
                && press.Target.Window == window && press.Name == name && (press.Up.Type == 1) == keyboard);
            if (index < 0) throw new NativeFailure("INPUT_NOT_HELD", "This connection did not hold that input on the selected window");
            ReleaseAt(index);
        }
    }

    internal object[] Get(Guid connection)
    {
        lock (gate)
            return pressed.Where(press => press.Connection == connection).Select(press => press.Describe()).ToArray();
    }

    internal async Task ReleaseOnDisconnect(Guid connection, SemaphoreSlim desktopQueue, int graceMs)
    {
        lock (gate)
            if (!pressed.Exists(press => press.Connection == connection)) return;

        using var deadline = new CancellationTokenSource(graceMs);
        try
        {
            await desktopQueue.WaitAsync(deadline.Token);
            try { Release(connection, deadline.Token); }
            finally { desktopQueue.Release(); }
        }
        catch (Exception error)
        {
            _ = error; // The disconnected owner cannot retry or receive a cleanup result.
            lock (gate) pressed.RemoveAll(press => press.Connection == connection);
        }
    }

    internal object[] Release(Guid connection, CancellationToken cancellation)
    {
        lock (gate)
        {
            var released = new List<object>();
            var failures = new List<string>();
            for (var index = pressed.Count - 1; index >= 0; index--)
            {
                var press = pressed[index];
                if (press.Connection != connection) continue;
                cancellation.ThrowIfCancellationRequested();
                try { ReleaseAt(index); released.Add(press.Describe()); }
                catch (NativeFailure error) { failures.Add(error.Message); }
            }
            if (failures.Count != 0) throw new NativeFailure("INPUT_CLEANUP_FAILED", string.Join("; ", failures));
            return released.ToArray();
        }
    }

    private void ReleaseAt(int index)
    {
        send(pressed[index].Up);
        pressed.RemoveAt(index);
    }
}
