// Private .NET Framework experiment. Each blocking capture runs in a disposable child process.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

internal static class CaptureProbe
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly string[] Methods = { "screen", "window-dc", "print", "print-full" };

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            SetProcessDpiAwarenessContext(new IntPtr(-4));
            if (args.Length == 4 && args[0] == "--one")
            {
                Capture(new IntPtr(long.Parse(args[1])), args[2], args[3]);
                return 0;
            }
            if (args.Length == 3 && args[0] == "--compare")
            {
                var output = NewOutput(args[2]);
                Compare(new IntPtr(long.Parse(args[1])), output, "selected");
                return 0;
            }
            if (args.Length != 2 || args[0] != "--demo")
                throw new ArgumentException("Expected --demo OUTPUT or --compare DECIMAL_HWND OUTPUT");
            var directory = NewOutput(args[1]);
            Application.EnableVisualStyles();
            using (var target = new Form())
            using (var cover = new Form())
            {
                target.Text = "DSH capture probe: owned target";
                target.StartPosition = cover.StartPosition = FormStartPosition.Manual;
                target.Bounds = new Rectangle(100, 100, 520, 400);
                target.BackColor = Color.FromArgb(20, 180, 60);
                target.TopMost = true;
                cover.Text = "DSH capture probe: owned cover";
                cover.Bounds = target.Bounds;
                cover.BackColor = Color.Magenta;
                cover.TopMost = true;
                Exception failure = null;
                target.Shown += async delegate
                {
                    try
                    {
                        var hwnd = target.Handle;
                        var automation = await Task.Run(() => AutomationElement.FromHandle(hwnd).Current.Name);
                        Write(Path.Combine(directory, "runtime.json"), new
                        {
                            framework = Environment.Version.ToString(),
                            automationName = automation,
                            os = Environment.OSVersion.VersionString,
                            pointerBytes = IntPtr.Size
                        });
                        target.Refresh();
                        var center = new Point(target.Left + target.Width / 2, target.Top + target.Height / 2);
                        await WaitForPixel(center, target.BackColor);
                        await Task.Run(() => Compare(hwnd, directory, "visible"));
                        cover.Show();
                        cover.Refresh();
                        await WaitForPixel(center, cover.BackColor);
                        // A new marker distinguishes a fresh covered image from a cached visible image.
                        target.BackColor = Color.FromArgb(30, 90, 220);
                        target.Refresh();
                        await Task.Run(() => Compare(hwnd, directory, "covered-updated"));
                        target.WindowState = FormWindowState.Minimized;
                        await Task.Run(() => Compare(hwnd, directory, "minimized"));
                    }
                    catch (Exception error) { failure = error; }
                    finally { cover.Close(); target.Close(); }
                };
                Application.Run(target);
                if (failure != null) throw failure;
            }
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
    }

    private static string NewOutput(string path)
    {
        var result = Path.GetFullPath(path);
        if (Directory.Exists(result)) throw new IOException("Use a new output directory for each experiment");
        Directory.CreateDirectory(result);
        return result;
    }

    private static async Task WaitForPixel(Point point, Color expected)
    {
        var clock = Stopwatch.StartNew();
        using (var sample = new Bitmap(1, 1))
        using (var graphics = Graphics.FromImage(sample))
        {
            while (true)
            {
                graphics.CopyFromScreen(point.X, point.Y, 0, 0, sample.Size);
                if (sample.GetPixel(0, 0).ToArgb() == expected.ToArgb()) return;
                if (clock.ElapsedMilliseconds > 5000) throw new TimeoutException("The owned window marker is not visible");
                await Task.Delay(25);
            }
        }
    }

    private static void Compare(IntPtr window, string directory, string scenario)
    {
        foreach (var method in Methods)
        {
            var prefix = Path.Combine(directory, scenario + "-" + method);
            var start = new ProcessStartInfo(Application.ExecutablePath,
                "--one " + window.ToInt64() + " " + method + " \"" + prefix + "\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true
            };
            using (var process = Process.Start(start))
            {
                if (!process.WaitForExit(5000))
                {
                    process.Kill();
                    process.WaitForExit();
                    Write(prefix + ".json", new { method, timeout = true });
                }
                else if (process.ExitCode != 0)
                    throw new InvalidOperationException(method + " child exited " + process.ExitCode);
            }
            Console.WriteLine(File.ReadAllText(prefix + ".json"));
        }
    }

    private static void Capture(IntPtr window, string method, string prefix)
    {
        Rect bounds;
        if (!GetWindowRect(window, out bounds)) throw new InvalidOperationException("Window no longer exists");
        var width = bounds.Right - bounds.Left;
        var height = bounds.Bottom - bounds.Top;
        if (width <= 0 || height <= 0 || (long)width * height > 40000000)
            throw new InvalidOperationException("Window dimensions exceed the experiment limit");
        var foreground = GetForegroundWindow();
        var clock = Stopwatch.StartNew();
        using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
        {
            bool returned;
            using (var graphics = Graphics.FromImage(bitmap))
            {
                graphics.Clear(Color.Yellow);
                if (method == "screen")
                {
                    graphics.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, new Size(width, height));
                    returned = true;
                }
                else if (method == "window-dc")
                {
                    var source = GetWindowDC(window);
                    if (source == IntPtr.Zero) throw new InvalidOperationException("Window DC is unavailable");
                    try
                    {
                        var destination = graphics.GetHdc();
                        try { returned = BitBlt(destination, 0, 0, width, height, source, 0, 0, 0x00CC0020); }
                        finally { graphics.ReleaseHdc(destination); }
                    }
                    finally { ReleaseDC(window, source); }
                }
                else
                {
                    var dc = graphics.GetHdc();
                    try { returned = PrintWindow(window, dc, method == "print-full" ? 2u : 0u); }
                    finally { graphics.ReleaseHdc(dc); }
                }
            }
            clock.Stop();
            var markers = new Dictionary<string, int> { { "green", 0 }, { "blue", 0 }, { "cover", 0 }, { "black", 0 } };
            for (var y = 0; y < height; y += 4)
                for (var x = 0; x < width; x += 4)
                {
                    var pixel = bitmap.GetPixel(x, y);
                    if (pixel.R == 20 && pixel.G == 180 && pixel.B == 60) markers["green"]++;
                    if (pixel.R == 30 && pixel.G == 90 && pixel.B == 220) markers["blue"]++;
                    if (pixel.R == 255 && pixel.G == 0 && pixel.B == 255) markers["cover"]++;
                    if (pixel.R == 0 && pixel.G == 0 && pixel.B == 0) markers["black"]++;
                }
            bitmap.Save(prefix + ".png", ImageFormat.Png);
            Write(prefix + ".json", new
            {
                method, returned, width, height, elapsedMs = clock.ElapsedMilliseconds, markers,
                minimized = IsIconic(window), foregroundChanged = foreground != GetForegroundWindow()
            });
        }
    }

    private static void Write(string path, object value)
    {
        File.WriteAllText(path, Json.Serialize(value) + Environment.NewLine);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { internal int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr GetWindowDC(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
    [DllImport("gdi32.dll")] private static extern bool BitBlt(IntPtr destination, int x, int y, int width, int height,
        IntPtr source, int sourceX, int sourceY, uint operation);
}
