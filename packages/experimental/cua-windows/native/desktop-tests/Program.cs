// Private desktop fixture: commands inspect or arrange only the windows owned by this process.
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Security.Cryptography;
using System.Text;

internal sealed class FixtureForm : Form
{
    protected override bool ShowWithoutActivation => true;
    internal readonly TextBox Editor = new() { Name = "editor", AccessibleName = "CUA test text", Multiline = true, Bounds = new(20, 20, 440, 100) };
    private readonly Button button = new() { Name = "submit", Text = "Record click", Bounds = new(20, 140, 180, 40) };
    private int clicks;
    private readonly ToolTip tooltip = new();

    internal FixtureForm(string title)
    {
        Text = title;
        StartPosition = FormStartPosition.Manual;
        Location = new(100, 100);
        ClientSize = new(500, 300);
        Controls.Add(Editor);
        Controls.Add(button);
        button.Click += (_, _) => clicks++;
        tooltip.SetToolTip(button, "CUA hover is retained");
    }

    internal object Inspect() => new
    {
        text = Editor.Text, clicks, window = Handle.ToString(CultureInfo.InvariantCulture), foreground = GetForegroundWindow().ToString(CultureInfo.InvariantCulture),
        cursor = new { x = Cursor.Position.X, y = Cursor.Position.Y },
        button = new { x = button.Left + button.Width / 2, y = button.Top + button.Height / 2 },
        selection = new { start = Editor.SelectionStart, length = Editor.SelectionLength },
        buttons = MouseButtons.ToString(), minimized = WindowState == FormWindowState.Minimized, visible = Visible,
    };

    protected override void Dispose(bool disposing)
    {
        if (disposing) tooltip.Dispose();
        base.Dispose(disposing);
    }

    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
}

internal static class Program
{
    private static void Write(object value) { Console.WriteLine(JsonSerializer.Serialize(value)); Console.Out.Flush(); }

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
                            case "inspect": Write(form.Inspect()); break;
                            case "focus": form.Activate(); form.Editor.Focus(); Write(form.Inspect()); break;
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
}
