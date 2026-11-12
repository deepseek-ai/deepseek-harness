// Global key and pointer injection requires an explicitly foregrounded target.
using System.Runtime.InteropServices;
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal static class Input
{
    private const ushort VkShift = 0x10;
    private const ushort VkControl = 0x11;
    private const ushort VkAlt = 0x12;
    private const ushort VkLeftWin = 0x5B;

    private static ushort Modifier(string name) => name switch
    {
        "shift" => VkShift, "ctrl" => VkControl, "alt" => VkAlt, "win" => VkLeftWin,
        "fn" => throw new NativeFailure("UNSUPPORTED", "Fn is typically handled by keyboard firmware rather than exposed as a distinct key in the Windows input layer"),
        _ => throw new NativeFailure("INVALID_ARGUMENT", "Unknown key modifier"),
    };
    private static Win32.Input Keyboard(ushort key, ushort scan = 0, uint flags = 0) => new()
    { Type = 1, Data = new() { Keyboard = new() { Key = key, Scan = scan, Flags = flags } } };
    private static Win32.Input Mouse(uint flags, int x = 0, int y = 0, uint data = 0) => new()
    { Type = 0, Data = new() { Mouse = new() { X = x, Y = y, Data = data, Flags = flags } } };

    private static void Send(params Win32.Input[] events)
    {
        if (Win32.SendInput((uint)events.Length, events, Marshal.SizeOf<Win32.Input>()) != events.Length)
            throw new NativeFailure("INPUT_BLOCKED", "Windows did not dispatch all input; privileges or user input may have intervened. Observe before retrying");
    }

    private static void Release(Win32.Input input) => Win32.SendInput(1, [input], Marshal.SizeOf<Win32.Input>());

    private static void WithModifiers(IEnumerable<string> modifiers, Action action)
    {
        var keys = modifiers.Select(KeyChord.NormalizeModifier).Select(Modifier).Distinct().ToArray();
        var attempted = new List<ushort>();
        try
        {
            foreach (var key in keys) { attempted.Add(key); Send(Keyboard(key, flags: key == VkLeftWin ? 1u : 0)); }
            action();
        }
        finally { foreach (var key in attempted.AsEnumerable().Reverse()) Release(Keyboard(key, flags: 2u | (key == VkLeftWin ? 1u : 0))); }
    }

    private static (ushort Key, bool Extended, string[] Modifiers) ResolveKey(string name, bool includeModifiers = false)
    {
        var key = name.ToLowerInvariant();
        if (includeModifiers && key is ("shift" or "ctrl" or "control" or "alt" or "win" or "fn"))
            return (Modifier(KeyChord.NormalizeModifier(key)), key == "win", []);
        if (key.StartsWith("kp_", StringComparison.Ordinal))
        {
            var keypad = key[3..];
            if (keypad.Length == 1 && char.IsAsciiDigit(keypad[0])) return ((ushort)(0x60 + keypad[0] - '0'), false, []);
            return keypad switch
            {
                "enter" => (0x0D, true, []), "add" or "plus" => (0x6B, false, []), "subtract" or "minus" => (0x6D, false, []),
                "multiply" => (0x6A, false, []), "divide" => (0x6F, true, []), "decimal" or "period" => (0x6E, false, []),
                _ => throw new NativeFailure("UNSUPPORTED", "Unknown numeric-keypad key"),
            };
        }
        if (key.Length > 1 && key[0] == 'f' && int.TryParse(key[1..], out var function) && function is >= 1 and <= 24)
            return ((ushort)(0x70 + function - 1), false, []);
        ushort named = key switch
        {
            "enter" or "return" => 0x0D, "tab" => 0x09, "escape" or "esc" => 0x1B, "backspace" => 0x08,
            "delete" or "forwarddelete" => 0x2E, "insert" => 0x2D, "home" => 0x24, "end" => 0x23,
            "pageup" => 0x21, "pagedown" => 0x22, "left" or "arrowleft" => 0x25, "up" or "arrowup" => 0x26,
            "right" or "arrowright" => 0x27, "down" or "arrowdown" => 0x28, "space" => 0x20,
            "capslock" => 0x14, "numlock" => 0x90, "scrolllock" => 0x91, "printscreen" => 0x2C,
            _ => 0,
        };
        if (named != 0) return (named, named is >= 0x21 and <= 0x2E || named == 0x90, []);
        var character = key == "plus" ? '+' : name.Length == 1 ? char.IsAsciiLetter(name[0]) ? char.ToLowerInvariant(name[0]) : name[0] : '\0';
        if (character == '\0') throw new NativeFailure("UNSUPPORTED", "Unknown key name; use typeText for text input");
        var foreground = Win32.GetForegroundWindow();
        var thread = Win32.GetWindowThreadProcessId(foreground, out _);
        var mapped = Win32.VkKeyScanEx(character, Win32.GetKeyboardLayout(thread));
        if (mapped == -1) throw new NativeFailure("UNSUPPORTED", "This character has no key in the target keyboard layout; use typeText");
        var modifiers = new List<string>();
        if ((mapped & 0x100) != 0) modifiers.Add("shift");
        if ((mapped & 0x200) != 0) modifiers.Add("ctrl");
        if ((mapped & 0x400) != 0) modifiers.Add("alt");
        return ((ushort)(mapped & 0xFF), false, modifiers.ToArray());
    }

    internal static bool KeyEvent(AppState app, WindowState window, string name, string direction, RequestContext context)
    {
        Windows.RequireForeground(app, window, context);
        var key = ResolveKey(name, includeModifiers: true);
        if (key.Modifiers.Length != 0)
            throw new NativeFailure("UNSUPPORTED", "This key requires modifiers in the target keyboard layout; send each modifier and the base key separately");
        var down = direction == "down";
        if (((Win32.GetAsyncKeyState(key.Key) & 0x8000) != 0) == down) return false;
        Send(Keyboard(key.Key, flags: (key.Extended ? 1u : 0) | (down ? 0u : 2u)));
        return true;
    }

    internal static void Press(AppState app, WindowState window, string key, string[] modifiers, RequestContext context)
    {
        Windows.RequireForeground(app, window, context);
        var held = KeyChord.ModifiersForPress(key, modifiers);
        var resolved = ResolveKey(key);
        WithModifiers(held.Concat(resolved.Modifiers), () =>
        {
            Windows.RequireForeground(app, window, context);
            var flags = resolved.Extended ? 1u : 0;
            try { Send(Keyboard(resolved.Key, flags: flags), Keyboard(resolved.Key, flags: flags | 2)); }
            catch { Release(Keyboard(resolved.Key, flags: flags | 2)); throw; }
        });
    }

    internal static async Task Type(AppState app, WindowState window, string text, RequestContext context)
    {
        if (text.Contains('\0')) throw new NativeFailure("INVALID_ARGUMENT", "Text input cannot contain NUL");
        for (var index = 0; index < text.Length; index++)
        {
            Windows.RequireForeground(app, window, context);
            var character = text[index];
            if (character is '\r' or '\n' or '\t')
            {
                if (character == '\r' && index + 1 < text.Length && text[index + 1] == '\n') index++;
                Press(app, window, character == '\t' ? "Tab" : "Enter", [], context);
            }
            else
            {
                try { Send(Keyboard(0, character, 4), Keyboard(0, character, 6)); }
                catch { Release(Keyboard(0, character, 6)); throw; }
            }
            if (context.Config.TextEventIntervalMs > 0)
                await Task.Delay(TimeSpan.FromMilliseconds(context.Config.TextEventIntervalMs * 2), context.Cancellation);
        }
    }

    private static Win32.Input Move(Win32.Point point)
    {
        int left = Win32.GetSystemMetrics(76), top = Win32.GetSystemMetrics(77);
        int width = Win32.GetSystemMetrics(78), height = Win32.GetSystemMetrics(79);
        if (width <= 1 || height <= 1) throw new NativeFailure("SESSION_LOCKED", "The virtual desktop has no usable bounds");
        return Mouse(0x8000 | 0x4000 | 0x0001,
            (int)Math.Round((point.X - left) * 65535d / (width - 1)), (int)Math.Round((point.Y - top) * 65535d / (height - 1)));
    }

    private static (uint Down, uint Up) Button(string button) => button switch
    {
        "left" => (0x0002, 0x0004), "right" => (0x0008, 0x0010), "middle" => (0x0020, 0x0040),
        _ => throw new NativeFailure("INVALID_ARGUMENT", "Unknown mouse button"),
    };

    private static void Hit(AppState app, WindowState window, Win32.Point point, RequestContext context)
    {
        Windows.RequireForeground(app, window, context);
        if (Win32.GetAncestor(Win32.WindowFromPoint(point), 2) != window.Handle)
            throw new NativeFailure("WINDOW_OBSCURED", "Another window covers the target coordinate; restore or raise the selected window and observe again");
    }

    internal static object MouseMove(AppState app, WindowState window, double x, double y, RequestContext context)
    {
        var point = WindowState.Point(window.RequireObservation(app, context), x, y);
        Hit(app, window, point, context);
        if (!Win32.GetCursorPos(out var before)) throw new NativeFailure("INPUT_UNAVAILABLE", "The current pointer position is unavailable");
        Send(Move(point));
        return new { dispatched = true, hoverRoute = "system-pointer", systemPointerMoved = before.X != point.X || before.Y != point.Y };
    }

    internal static void Click(AppState app, WindowState window, double x, double y, string button, int count, string[] modifiers, RequestContext context)
    {
        if (button != "left" && count != 1) throw new NativeFailure("UNSUPPORTED", "Only left clicks support double-click");
        var geometry = window.RequireObservation(app, context);
        var point = WindowState.Point(geometry, x, y);
        var flags = Button(button);
        Hit(app, window, point, context);
        WithModifiers(modifiers, () =>
        {
            point = WindowState.Point(window.RequireObservation(app, context), x, y);
            Hit(app, window, point, context);
            var events = new List<Win32.Input> { Move(point) };
            for (var click = 0; click < count; click++) { events.Add(Mouse(flags.Down)); events.Add(Mouse(flags.Up)); }
            try { Send(events.ToArray()); } catch { Release(Mouse(flags.Up)); throw; }
        });
    }

    internal static async Task HoldClick(AppState app, WindowState window, double x, double y, string button, int count, string[] modifiers, int holdMs, RequestContext context)
    {
        if (button != "left" && count != 1) throw new NativeFailure("UNSUPPORTED", "Only left clicks support double-click");
        var point = WindowState.Point(window.RequireObservation(app, context), x, y);
        var flags = Button(button);
        var keys = modifiers.Select(KeyChord.NormalizeModifier).Select(Modifier).Distinct().ToArray();
        Hit(app, window, point, context);
        var attempted = new List<ushort>();
        var buttonAttempted = false;
        try
        {
            foreach (var key in keys) { attempted.Add(key); Send(Keyboard(key, flags: key == VkLeftWin ? 1u : 0)); }
            point = WindowState.Point(window.RequireObservation(app, context), x, y);
            Hit(app, window, point, context);
            Send(Move(point));
            for (var click = 0; click < count; click++)
            {
                Hit(app, window, point, context);
                buttonAttempted = true;
                Send(Mouse(flags.Down));
                await Task.Delay(holdMs, context.Cancellation);
                Windows.RequireForeground(app, window, context);
                Send(Mouse(flags.Up));
                buttonAttempted = false;
            }
        }
        finally
        {
            if (buttonAttempted) Release(Mouse(flags.Up));
            foreach (var key in attempted.AsEnumerable().Reverse()) Release(Keyboard(key, flags: 2u | (key == VkLeftWin ? 1u : 0)));
        }
    }

    internal static void Scroll(AppState app, WindowState window, double x, double y, int deltaX, int deltaY, RequestContext context)
    {
        var point = WindowState.Point(window.RequireObservation(app, context), x, y);
        Hit(app, window, point, context);
        uint lines = 1, columns = 1;
        if (deltaY != 0 && (!Win32.SystemParametersInfo(0x0068, 0, out lines, 0) || lines == uint.MaxValue || lines == 0)
            || deltaX != 0 && (!Win32.SystemParametersInfo(0x006C, 0, out columns, 0) || columns == 0))
            throw new NativeFailure("UNSUPPORTED", "Windows wheel scrolling does not currently use line/character units");
        var events = new List<Win32.Input> { Move(point) };
        if (deltaY != 0) events.Add(Mouse(0x0800, data: unchecked((uint)(int)Math.Round(deltaY * 120d / lines))));
        if (deltaX != 0) events.Add(Mouse(0x1000, data: unchecked((uint)(int)Math.Round(-deltaX * 120d / columns))));
        Send(events.ToArray());
    }

    internal static async Task Drag(AppState app, WindowState window, double fromX, double fromY, double toX, double toY,
        string button, string[] modifiers, int durationMs, int steps, RequestContext context)
    {
        var geometry = window.RequireObservation(app, context);
        var from = WindowState.Point(geometry, fromX, fromY);
        _ = WindowState.Point(geometry, toX, toY);
        Hit(app, window, from, context);
        var flags = Button(button);
        var keys = modifiers.Select(KeyChord.NormalizeModifier).Select(Modifier).Distinct().ToArray();
        var attempted = new List<ushort>();
        var buttonAttempted = false;
        try
        {
            foreach (var key in keys) { attempted.Add(key); Send(Keyboard(key, flags: key == VkLeftWin ? 1u : 0)); }
            geometry = window.RequireObservation(app, context);
            from = WindowState.Point(geometry, fromX, fromY);
            Hit(app, window, from, context);
            buttonAttempted = true;
            Send(Move(from), Mouse(flags.Down));
            for (var step = 1; step <= steps; step++)
            {
                await Task.Delay(TimeSpan.FromMilliseconds(durationMs / (double)steps), context.Cancellation);
                geometry = window.RequireObservation(app, context);
                Windows.RequireForeground(app, window, context);
                Send(Move(WindowState.Point(geometry, fromX + (toX - fromX) * step / steps, fromY + (toY - fromY) * step / steps)));
            }
        }
        finally
        {
            if (buttonAttempted) Release(Mouse(flags.Up));
            foreach (var key in attempted.AsEnumerable().Reverse()) Release(Keyboard(key, flags: 2u | (key == VkLeftWin ? 1u : 0)));
        }
    }
}
