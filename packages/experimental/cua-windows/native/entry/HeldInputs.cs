// Held keys and buttons share one dispatch order across all connections to this desktop executor.
using System.Globalization;
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal sealed class HeldInputs(Action<Win32.Input> send, Action requireInteractive)
{
    internal readonly record struct Target(string AppHandle, nint Window, int ProcessId, long ProcessStarted);
    private sealed record Press(Guid Connection, string Task, Target Target, ushort Control, string Name, Win32.Input Up)
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

    internal void RequireOwner(Guid connection, string? task, string app, nint window)
    {
        lock (gate)
            if (pressed.Any(press => press.Connection != connection
                || (task is not null && press.Task != task)
                || press.Target.AppHandle != app || press.Target.Window != window))
                throw new NativeFailure("INPUT_BUSY", "Another task or window owns held desktop input; release it before sending input to this window");
    }

    internal void RequireAvailable(ushort control)
    {
        lock (gate)
            if (pressed.Any(press => press.Control == control))
                throw new NativeFailure("INPUT_BUSY", "This key or button is already held; release it before a complete action uses it");
    }

    internal bool Down(Guid connection, string task, Target target, ushort control, string name, Win32.Input down,
        Win32.Input up, CancellationToken cancellation)
    {
        lock (gate)
        {
            cancellation.ThrowIfCancellationRequested();
            var existing = pressed.Find(press => press.Control == control);
            if (existing is not null)
            {
                if (existing.Connection == connection && existing.Task == task && existing.Target == target && existing.Name == name)
                    return false;
                throw new NativeFailure("INPUT_BUSY", "This key or button is already held by another input target");
            }

            var press = new Press(connection, task, target, control, name, up);
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

    internal void Up(Guid connection, string task, string app, nint window, string name, bool keyboard)
    {
        lock (gate)
        {
            var index = pressed.FindIndex(press => press.Connection == connection && press.Task == task && press.Target.AppHandle == app
                && press.Target.Window == window && press.Name == name && (press.Up.Type == 1) == keyboard);
            if (index < 0) throw new NativeFailure("INPUT_NOT_HELD", "This task did not hold that input on the selected window");
            ReleaseAt(index);
        }
    }

    internal object[] Get(Guid connection, string task)
    {
        lock (gate)
            return pressed.Where(press => press.Connection == connection && press.Task == task).Select(press => press.Describe()).ToArray();
    }

    internal bool HasConnection(Guid connection)
    {
        lock (gate) return pressed.Exists(press => press.Connection == connection);
    }

    internal object[] Release(Guid connection, string? task, CancellationToken cancellation)
    {
        lock (gate)
        {
            var released = new List<object>();
            var failures = new List<string>();
            for (var index = pressed.Count - 1; index >= 0; index--)
            {
                var press = pressed[index];
                if (press.Connection != connection || (task is not null && press.Task != task)) continue;
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
        requireInteractive();
        send(pressed[index].Up);
        pressed.RemoveAt(index);
    }
}
