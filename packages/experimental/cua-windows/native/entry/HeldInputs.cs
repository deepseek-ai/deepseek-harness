// The shared desktop executor serializes dispatch. Hooks arbitrate external input in the Windows input stream.
using System.Globalization;
using System.Runtime.InteropServices;
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal sealed class HeldInputs(Func<ushort, bool> isDown, Action<Win32.Input> send, Action requireInteractive)
{
    internal readonly record struct Target(string AppHandle, nint Window, int ProcessId, long ProcessStarted);
    private sealed record Press(Guid Connection, string Task, Target Target, ushort Control, string Name, Win32.Input Up)
    {
        internal bool Confirmed { get; set; }
        internal object Describe() => new
        {
            kind = Up.Type == 1 ? "key" : "mouse", key = Up.Type == 1 ? Name : null,
            button = Up.Type == 0 ? Name : null, appHandle = Target.AppHandle,
            windowId = Target.Window.ToString(CultureInfo.InvariantCulture), mode = "system",
        };
    }

    private sealed record Dispatch(Press Press, nuint Tag, TaskCompletionSource<bool> Completion);

    private readonly object gate = new();
    private readonly List<Press> pressed = [];
    private readonly nuint prefix = unchecked((nuint)Random.Shared.NextInt64(1, int.MaxValue)) << 32;
    private uint sequence;
    private Dispatch? pending;

    internal static ushort CanonicalControl(ushort key) => key switch
    {
        0xA0 or 0xA1 => 0x10, // Shift
        0xA2 or 0xA3 => 0x11, // Control
        0xA4 or 0xA5 => 0x12, // Alt
        _ => key,
    };

    // An accepted external event supersedes an owned hold on the same global Windows input.
    internal nint Observe(ushort control, nuint tag, Func<nint> next)
    {
        Dispatch? dispatch;
        lock (gate)
        {
            dispatch = pending?.Tag == tag ? pending : null;
            if (dispatch is not null && !pressed.Contains(dispatch.Press))
            {
                dispatch.Completion.TrySetResult(false);
                return 1;
            }
            // A delayed synthetic event without an admitted dispatch must not reach the desktop.
            if (dispatch is null && tag >> 32 == prefix >> 32) return 1;
        }
        var outcome = next();
        lock (gate)
        {
            if (dispatch is not null) dispatch.Completion.TrySetResult(outcome == 0);
            else if (outcome == 0) pressed.RemoveAll(press => press.Control == control);
        }
        return outcome;
    }

    internal void RequireOwner(Guid connection, string? task, string app, nint window)
    {
        lock (gate)
        {
            if (pressed.Exists(press => !press.Confirmed))
                throw new NativeFailure("INPUT_DISPATCH_UNCONFIRMED", "Release unconfirmed held input before sending more desktop input");
            if (pressed.Any(press => press.Connection != connection
                || (task is not null && press.Task != task)
                || press.Target.AppHandle != app || press.Target.Window != window))
                throw new NativeFailure("INPUT_BUSY", "Another task or window owns held desktop input; release it before sending input to this window");
        }
    }

    internal void RequireAvailable(ushort control)
    {
        lock (gate)
            if (pressed.Any(press => press.Control == control) || isDown(control))
                throw new NativeFailure("INPUT_BUSY", "This key or button is already held; release it before a complete action uses it");
    }

    internal bool Down(Guid connection, string task, Target target, ushort control, string name, Win32.Input down,
        Win32.Input up, CancellationToken cancellation, int graceMs)
    {
        Press press;
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
            if (isDown(control))
                throw new NativeFailure("INPUT_BUSY", "This key or button is already down outside this task; ask the user to release it before retrying");
            press = new(connection, task, target, control, name, up);
            pressed.Add(press);
        }
        try
        {
            if (Post(press, down, graceMs))
            {
                lock (gate) press.Confirmed = true;
                return true;
            }
        }
        catch (NativeFailure error) when (error.Code == "INPUT_BLOCKED")
        {
            lock (gate) pressed.Remove(press);
            throw;
        }
        lock (gate) pressed.Remove(press);
        throw new NativeFailure("INPUT_BLOCKED", "Windows did not deliver the requested press to its input stream");
    }

    internal bool Up(Guid connection, string task, string app, nint window, string name, bool keyboard, int graceMs)
    {
        Press? press;
        lock (gate)
            press = pressed.Find(press => press.Connection == connection && press.Task == task && press.Target.AppHandle == app
                && press.Target.Window == window && press.Name == name && (press.Up.Type == 1) == keyboard);
        if (press is null) throw new NativeFailure("INPUT_NOT_HELD", "This task did not hold that input on the selected window");
        return Release(press, graceMs);
    }

    internal object[] Get(Guid connection, string task)
    {
        lock (gate)
        {
            var owned = pressed.Where(press => press.Connection == connection && press.Task == task).ToArray();
            if (owned.Any(press => !press.Confirmed))
                throw new NativeFailure("INPUT_DISPATCH_UNCONFIRMED", "Windows did not confirm which inputs are held");
            return owned.Select(press => press.Describe()).ToArray();
        }
    }

    internal bool HasConnection(Guid connection)
    {
        lock (gate) return pressed.Exists(press => press.Connection == connection);
    }

    internal object[] Release(Guid connection, string? task, CancellationToken cancellation, int graceMs)
    {
        Press[] owned;
        lock (gate) owned = pressed.Where(press => press.Connection == connection && (task is null || press.Task == task)).Reverse().ToArray();
        var released = new List<object>();
        var failures = new List<string>();
        foreach (var press in owned)
        {
            cancellation.ThrowIfCancellationRequested();
            try { if (Release(press, graceMs)) released.Add(press.Describe()); }
            catch (NativeFailure error) { failures.Add(error.Message); }
        }
        if (failures.Count != 0) throw new NativeFailure("INPUT_CLEANUP_FAILED", string.Join("; ", failures));
        return released.ToArray();
    }

    private bool Release(Press press, int graceMs)
    {
        lock (gate) if (!pressed.Contains(press)) return false;
        // SendInput releases the global input at its current destination; never reactivate an old HWND.
        requireInteractive();
        var posted = Post(press, press.Up, graceMs);
        lock (gate)
        {
            if (posted) pressed.Remove(press);
            else if (pressed.Contains(press))
                throw new NativeFailure("INPUT_BLOCKED", "Windows did not deliver the requested release to its input stream");
        }
        return posted;
    }

    private bool Post(Press press, Win32.Input input, int graceMs)
    {
        Dispatch dispatch;
        lock (gate)
        {
            if (!pressed.Contains(press)) return false;
            if (pending is not null) throw new NativeFailure("INPUT_BUSY", "Another held input is being dispatched");
            dispatch = new(press, prefix | ++sequence, new(TaskCreationOptions.RunContinuationsAsynchronously));
            pending = dispatch;
        }
        try
        {
            if (input.Type == 1) input.Data.Keyboard.Extra = dispatch.Tag;
            else input.Data.Mouse.Extra = dispatch.Tag;
            send(input);
            return dispatch.Completion.Task.WaitAsync(TimeSpan.FromMilliseconds(graceMs)).GetAwaiter().GetResult();
        }
        catch (TimeoutException)
        {
            lock (gate) press.Confirmed = false;
            throw new NativeFailure("INPUT_DISPATCH_UNCONFIRMED", "Windows did not confirm the held-input event; inspect the desktop before retrying");
        }
        finally
        {
            lock (gate) pending = null;
        }
    }

}

internal sealed class HeldInputHooks(HeldInputs inputs) : IDisposable
{
    [StructLayout(LayoutKind.Sequential)]
    private struct KeyEvent { internal uint Key, Scan, Flags, Time; internal nuint Extra; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MouseEvent { internal Win32.Point Point; internal uint Data, Flags, Time; internal nuint Extra; }

    private nint keyboard;
    private nint mouse;
    private readonly Win32.InputHook keyHook = (code, message, value) =>
    {
        if (code < 0) return Win32.CallNextHookEx(0, code, message, value);
        var input = Marshal.PtrToStructure<KeyEvent>(value);
        if (input.Key > ushort.MaxValue) return Win32.CallNextHookEx(0, code, message, value);
        return inputs.Observe(HeldInputs.CanonicalControl((ushort)input.Key), input.Extra, () => Win32.CallNextHookEx(0, code, message, value));
    };
    private readonly Win32.InputHook mouseHook = (code, message, value) =>
    {
        ushort control = message switch
        {
            0x0201 or 0x0202 => 1, // Left down/up
            0x0204 or 0x0205 => 2, // Right down/up
            0x0207 or 0x0208 => 4, // Middle down/up
            _ => 0,
        };
        if (code < 0 || control == 0) return Win32.CallNextHookEx(0, code, message, value);
        var input = Marshal.PtrToStructure<MouseEvent>(value);
        return inputs.Observe(control, input.Extra, () => Win32.CallNextHookEx(0, code, message, value));
    };

    // Low-level hooks must be installed on a thread that pumps Windows messages.
    internal void Start()
    {
        if (keyboard != 0) return;
        var module = Win32.GetModuleHandle(null);
        keyboard = Win32.SetWindowsHookEx(13, keyHook, module, 0);
        mouse = Win32.SetWindowsHookEx(14, mouseHook, module, 0);
        if (keyboard != 0 && mouse != 0) return;
        Dispose();
        throw new NativeFailure("INPUT_UNAVAILABLE", "Windows could not observe ownership of held desktop input");
    }

    public void Dispose()
    {
        if (keyboard != 0) Win32.UnhookWindowsHookEx(keyboard);
        if (mouse != 0) Win32.UnhookWindowsHookEx(mouse);
        keyboard = mouse = 0;
    }
}
