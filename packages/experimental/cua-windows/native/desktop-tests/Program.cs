// Private desktop fixture: commands inspect or arrange only the windows owned by this process.
using System.Globalization;
using System.Runtime.InteropServices;
using DeepSeek.Cua.Windows;
using System.Text.Json;
using System.Security.Cryptography;
using System.Text;

internal sealed class FixtureForm : Form
{
    protected override bool ShowWithoutActivation => true;
    internal readonly TextBox Editor = new() { Name = "editor", AccessibleName = "CUA test text", Multiline = true, Bounds = new(20, 20, 440, 100) };
    private readonly Button button = new() { Name = "submit", Text = "Record click", Bounds = new(20, 140, 180, 40) };
    private int clicks;
    private readonly List<string> inputEvents = [];
    private MouseButtons receivedButtons;
    private int leftDowns, leftUps, rightDowns, rightUps, middleDowns, middleUps;
    private readonly ToolTip tooltip = new();

    internal FixtureForm(string title)
    {
        Text = title;
        StartPosition = FormStartPosition.Manual;
        Location = new(100, 100);
        ClientSize = new(500, 300);
        KeyPreview = true;
        KeyDown += (_, e) => WatchKey(e.KeyCode, "down");
        KeyUp += (_, e) => WatchKey(e.KeyCode, "up");
        Controls.Add(Editor);
        Controls.Add(button);
        button.Click += (_, _) => clicks++;
        button.MouseDown += (_, e) => Count(e.Button, down: true);
        button.MouseUp += (_, e) => Count(e.Button, down: false);
        Editor.MouseDown += (_, e) => Count(e.Button, down: true);
        Editor.MouseUp += (_, e) => Count(e.Button, down: false);
        tooltip.SetToolTip(button, "CUA hover is retained");
    }

    private void WatchKey(Keys key, string direction)
    {
        if (key is Keys.W or Keys.ShiftKey) inputEvents.Add($"{key}:{direction}");
    }

    private void Count(MouseButtons pressed, bool down)
    {
        receivedButtons = down ? receivedButtons | pressed : receivedButtons & ~pressed;
        inputEvents.Add($"{pressed}:{(down ? "down" : "up")}");
        switch (pressed)
        {
            case MouseButtons.Left: if (down) leftDowns++; else leftUps++; break;
            case MouseButtons.Right: if (down) rightDowns++; else rightUps++; break;
            case MouseButtons.Middle: if (down) middleDowns++; else middleUps++; break;
        }
    }

    internal void PointAtButton() => Cursor.Position = button.PointToScreen(new Point(button.Width / 2, button.Height / 2));

    internal void SetIdentity()
    {
        var id = typeof(Win32.IPropertyStore).GUID;
        Marshal.ThrowExceptionForHR(Win32.SHGetPropertyStoreForWindow(Handle, ref id, out var store));
        var key = new Win32.PropertyKey { FormatId = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), PropertyId = 5 };
        var value = new Win32.PropVariant { ValueType = 31, Pointer = Marshal.StringToCoTaskMemUni("DSH.Fixture." + (long)Handle) };
        try { Marshal.ThrowExceptionForHR(store!.SetValue(ref key, ref value)); }
        finally { Win32.PropVariantClear(ref value); Marshal.FinalReleaseComObject(store!); }
    }

    internal void PointOutside()
    {
        var bounds = RectangleToScreen(ClientRectangle);
        Cursor.Position = new Point(bounds.Right + 40, bounds.Top + 20);
    }

    internal void Cover(FixtureForm cover)
    {
        cover.Bounds = Bounds;
        cover.TopMost = true;
        cover.Show();
        Activate();
        PointAtButton();
    }

    internal void Uncover(FixtureForm cover)
    {
        if (cover.Visible) cover.Hide();
        cover.TopMost = false;
        Activate();
        PointAtButton();
    }

    internal object Inspect() => new
    {
        text = Editor.Text, clicks, window = Handle.ToString(CultureInfo.InvariantCulture), foreground = GetForegroundWindow().ToString(CultureInfo.InvariantCulture),
        cursor = new { x = Cursor.Position.X, y = Cursor.Position.Y },
        under = GetAncestor(WindowFromPoint(Cursor.Position), 2).ToString(CultureInfo.InvariantCulture),
        downs = new { left = leftDowns, right = rightDowns, middle = middleDowns },
        ups = new { left = leftUps, right = rightUps, middle = middleUps },
        button = new { x = button.Left + button.Width / 2, y = button.Top + button.Height / 2 },
        selection = new { start = Editor.SelectionStart, length = Editor.SelectionLength },
        inputEvents = inputEvents.ToArray(),
        buttons = receivedButtons.ToString(), minimized = WindowState == FormWindowState.Minimized, visible = Visible,
    };

    protected override void Dispose(bool disposing)
    {
        if (disposing) tooltip.Dispose();
        base.Dispose(disposing);
    }

    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] private static extern nint WindowFromPoint(Point point);
    [DllImport("user32.dll")] private static extern nint GetAncestor(nint window, uint flags);
}

internal static class Program
{
    private static void Write(object value) { Console.WriteLine(JsonSerializer.Serialize(value)); Console.Out.Flush(); }

    private static void SendMouse(params uint[] flags)
    {
        var inputs = flags.Select(flag => new Input { Type = 0, Data = new MouseInput { Flags = flag } }).ToArray();
        if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Input>()) != inputs.Length)
        {
            Console.Error.WriteLine("Fixture could not dispatch all requested mouse events");
            Environment.ExitCode = 1;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput { public int X, Y; public uint Data, Flags, Time; public nuint ExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Input { public uint Type; public MouseInput Data; }

    [STAThread]
    private static void Main()
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        using var form = new FixtureForm("DSH CUA owned test window");
        using var sibling = new FixtureForm("DSH CUA sibling test window");
        form.Shown += (_, _) =>
        {
            Write(new { pid = Environment.ProcessId, state = form.Inspect() });
            _ = Task.Run(() =>
            {
                while (Console.ReadLine() is { } command)
                {
                    form.Invoke(() =>
                    {
                        switch (command)
                        {
                            case "sibling": sibling.Show(); sibling.Activate(); sibling.Editor.Focus(); Write(sibling.Inspect()); break;
                            case "change-text": form.Editor.Text = "CUA notification sample"; Write(form.Inspect()); break;
                            case "inspect": Write(form.Inspect()); break;
                            case "identity": form.SetIdentity(); Write(form.Inspect()); break;
                            case "inspect-sibling": Write(sibling.Inspect()); break;
                            case "focus": form.Activate(); form.Editor.Focus(); Write(form.Inspect()); break;
                            case "pointer": form.PointAtButton(); Write(form.Inspect()); break;
                            case "pointer-outside": form.PointOutside(); Write(form.Inspect()); break;
                            case "cover": form.Cover(sibling); Write(new { form = form.Inspect(), sibling = sibling.Inspect() }); break;
                            case "uncover": form.Uncover(sibling); Write(form.Inspect()); break;
                            case "left-up": SendMouse(0x0004); Write(form.Inspect()); break;
                            case "release-input": SendMouse(0x0004, 0x0010, 0x0040); Write(form.Inspect()); break;
                            case "minimize": form.WindowState = FormWindowState.Minimized; Write(form.Inspect()); break;
                            case "hide": form.Hide(); Write(form.Inspect()); break;
                            case "resize": form.Width += 50; Write(form.Inspect()); break;
                            case "clipboard-digest":
                                Write(new { digest = Convert.ToHexString(SHA256.HashData(Encoding.Unicode.GetBytes(Clipboard.GetText()))) });
                                break;
                            case "close": form.Close(); break;
                            default:
                                if (command.StartsWith("allow:", StringComparison.Ordinal) && uint.TryParse(command[6..], out var pid))
                                    Write(new { allowed = AllowSetForegroundWindow(pid) });
                                else Write(new { error = "Unknown fixture command" });
                                break;
                        }
                    });
                    if (command == "close") return;
                }
                if (!form.IsDisposed) form.BeginInvoke(form.Close);
            });
        };
        Application.Run(form);
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AllowSetForegroundWindow(uint processId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, [In] Input[] inputs, int size);
}
