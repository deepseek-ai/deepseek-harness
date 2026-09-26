Add-Type -AssemblyName System.Drawing
if (-not ('InstallerCapture' -as [type])) {
    Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public static class InstallerCapture {
    public static string ProductName;
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    public static void Initialize() { SetProcessDPIAware(); }
    public delegate bool WindowCallback(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, WindowCallback callback, IntPtr data);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetProp(IntPtr window, string name);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] static extern bool RedrawWindow(IntPtr window, IntPtr rect, IntPtr region, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowEx(uint exStyle, string name, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr data);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("dwmapi.dll")] static extern int DwmFlush();
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr window, int id);
    [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wparam, string text);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool SetWindowText(IntPtr window, string text);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }

    public static string Bounds(IntPtr window) {
        Rect rect;
        if (!GetWindowRect(window, out rect)) throw new InvalidOperationException("Could not read window bounds");
        return rect.Left + "," + rect.Top + "," + rect.Right + "," + rect.Bottom;
    }

    public static void MoveBy(IntPtr window, int x, int y) {
        Rect rect;
        if (!GetWindowRect(window, out rect) || !SetWindowPos(window, IntPtr.Zero, rect.Left + x, rect.Top + y, 0, 0, 0x15))
            throw new InvalidOperationException("Could not move window");
    }

    public static bool HasIncompleteWindow(int process) {
        bool incomplete = false;
        EnumWindows(delegate(IntPtr window, IntPtr unused) {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            var title = new StringBuilder(256);
            GetWindowText(window, title, title.Capacity);
            if (owner == process && title.ToString().Contains(ProductName) && IsWindowVisible(window)
                && GetProp(window, "HarnessInstaller.Ready") == IntPtr.Zero) incomplete = true;
            return !incomplete;
        }, IntPtr.Zero);
        return incomplete;
    }

    public static IntPtr FindClass(IntPtr parent, string name) {
        IntPtr result = IntPtr.Zero;
        EnumChildWindows(parent, delegate(IntPtr child, IntPtr unused) {
            var kind = new StringBuilder(128);
            GetClassName(child, kind, kind.Capacity);
            if (kind.ToString() == name) result = child;
            return result == IntPtr.Zero;
        }, IntPtr.Zero);
        return result;
    }

    public static int Progress(IntPtr parent) {
        IntPtr window = FindClass(parent, "HarnessInstallerProgress");
        if (window == IntPtr.Zero) throw new InvalidOperationException("Progress page is missing");
        RedrawWindow(window, IntPtr.Zero, IntPtr.Zero, 0x101);
        var text = new StringBuilder(128);
        GetWindowText(window, text, text.Capacity);
        var percent = System.Text.RegularExpressions.Regex.Match(text.ToString(), @"\d+");
        if (!percent.Success) throw new InvalidOperationException("Progress caption is missing");
        return int.Parse(percent.Value);
    }

    public static IntPtr WaitForText(IntPtr parent, string expected, bool prefix) {
        var timer = System.Diagnostics.Stopwatch.StartNew();
        while (timer.ElapsedMilliseconds < 15000) {
            IntPtr result = IntPtr.Zero;
            EnumChildWindows(parent, delegate(IntPtr child, IntPtr data) {
                var text = new StringBuilder(256);
                GetWindowText(child, text, text.Capacity);
                if (IsWindowVisible(child) && (prefix ? text.ToString().StartsWith(expected, StringComparison.Ordinal) : text.ToString() == expected)) result = child;
                return true;
            }, IntPtr.Zero);
            if (result != IntPtr.Zero) return result;
            System.Threading.Thread.Sleep(25);
        }
        throw new TimeoutException("Visible control did not appear: " + expected);
    }

    public static IntPtr FindText(int process, string expected) { return FindTextCore(process, expected, false); }
    public static IntPtr FindDialogText(int process, string expected) { return FindTextCore(process, expected, true); }
    public static IntPtr FindButton(int process, string expected) {
        IntPtr result = IntPtr.Zero;
        EnumWindows(delegate(IntPtr window, IntPtr data) {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != process) return true;
            EnumChildWindows(window, delegate(IntPtr child, IntPtr unused) {
                var text = new StringBuilder(256);
                var kind = new StringBuilder(64);
                GetWindowText(child, text, text.Capacity);
                GetClassName(child, kind, kind.Capacity);
                if (IsWindowVisible(child) && kind.ToString() == "Button" && text.ToString() == expected) result = child;
                return result == IntPtr.Zero;
            }, IntPtr.Zero);
            return result == IntPtr.Zero;
        }, IntPtr.Zero);
        return result;
    }

    static IntPtr FindTextCore(int process, string expected, bool dialogOnly) {
        IntPtr result = IntPtr.Zero;
        EnumWindows(delegate(IntPtr window, IntPtr data) {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != process) return true;
            if (dialogOnly && !IsWindowVisible(GetDlgItem(window, 1)) && !IsWindowVisible(GetDlgItem(window, 2)) && !IsWindowVisible(GetDlgItem(window, 6))) return true;
            EnumChildWindows(window, delegate(IntPtr child, IntPtr unused) {
                var text = new StringBuilder(512);
                GetWindowText(child, text, text.Capacity);
                if (IsWindowVisible(child) && text.ToString().Contains(expected)) result = child;
                return result == IntPtr.Zero;
            }, IntPtr.Zero);
            return result == IntPtr.Zero;
        }, IntPtr.Zero);
        return result;
    }

    public static string VisibleText(int process) {
        var output = new StringBuilder();
        EnumWindows(delegate(IntPtr window, IntPtr data) {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != process) return true;
            output.AppendLine("WINDOW " + window + " OK=" + GetDlgItem(window, 1) + " YES=" + GetDlgItem(window, 6));
            EnumChildWindows(window, delegate(IntPtr child, IntPtr unused) {
                var text = new StringBuilder(1024);
                GetWindowText(child, text, text.Capacity);
                var kind = new StringBuilder(256);
                GetClassName(child, kind, kind.Capacity);
                Rect rect;
                GetWindowRect(child, out rect);
                if (IsWindowVisible(child)) output.AppendLine(kind + " " + child + " ID=" + GetDlgCtrlID(child) + " " + rect.Left + "," + rect.Top + "," + rect.Right + "," + rect.Bottom + " " + text.ToString());
                return true;
            }, IntPtr.Zero);
            return true;
        }, IntPtr.Zero);
        return output.ToString();
    }

    public static IntPtr TopLevel(IntPtr child) { return GetAncestor(child, 2); }
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);

    public static void Click(IntPtr control) {
        if (!PostMessage(control, 0xF5, IntPtr.Zero, IntPtr.Zero)) throw new InvalidOperationException("Could not click native button");
    }

    public static IntPtr Find(int process) {
        IntPtr result = IntPtr.Zero;
        EnumWindows(delegate(IntPtr window, IntPtr data) {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            var title = new StringBuilder(256);
            GetWindowText(window, title, title.Capacity);
            if (owner == process && title.ToString().Contains(ProductName) && GetProp(window, "HarnessInstaller.Ready") != IntPtr.Zero) {
                if (result != IntPtr.Zero) throw new InvalidOperationException("Multiple preview windows in test process");
                result = window;
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    public static void Reveal(IntPtr window) {
        var timer = System.Diagnostics.Stopwatch.StartNew();
        while (GetProp(window, "HarnessInstaller.Ready") == IntPtr.Zero) {
            if (timer.ElapsedMilliseconds > 10000) throw new TimeoutException("Native page did not finish creating controls");
            System.Threading.Thread.Sleep(10);
        }
        ShowWindow(window, 8);
        RedrawWindow(window, IntPtr.Zero, IntPtr.Zero, 0x181);
    }

    public static string Save(IntPtr window, string path) { return SaveNative(window, path, true); }

    public static string SaveNative(IntPtr window, string path, bool waitForInstaller) {
        if (waitForInstaller) Reveal(window);
        Rect rect;
        if (!GetWindowRect(window, out rect)) throw new InvalidOperationException("Could not read preview bounds");
        int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
        using (var bitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb)) {
            using (var graphics = Graphics.FromImage(bitmap)) {
                graphics.Clear(Color.White);
                IntPtr dc = graphics.GetHdc();
                try {
                    if (!PrintWindow(window, dc, 2)) throw new InvalidOperationException("PrintWindow failed");
                } finally { graphics.ReleaseHdc(dc); }
            }
            bitmap.Save(path, ImageFormat.Png);
        }
        return width + "x" + height;
    }

    // Capture only the test window and its own white backdrop, including DWM's external shadow.
    public static string SaveWithShadow(IntPtr window, string path) {
        Reveal(window);
        Rect rect;
        if (!GetWindowRect(window, out rect)) throw new InvalidOperationException("Could not read preview bounds");
        const int padding = 64;
        int x = rect.Left - padding, y = rect.Top - padding;
        int width = rect.Right - rect.Left + padding * 2, height = rect.Bottom - rect.Top + padding * 2;
        IntPtr foreground = GetForegroundWindow();
        bool wasTopmost = (GetWindowLong(window, -20) & 8) != 0;
        IntPtr backdrop = CreateWindowEx(0x08000088, "STATIC", "Installer Lab capture backdrop", 0x80000006,
                                        x, y, width, height, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (backdrop == IntPtr.Zero) throw new InvalidOperationException("Could not create owned capture backdrop");
        try {
            ShowWindow(backdrop, 8);
            RedrawWindow(backdrop, IntPtr.Zero, IntPtr.Zero, 0x181);
            SetWindowPos(window, new IntPtr(-1), 0, 0, 0, 0, 0x43);
            SetForegroundWindow(window);
            RedrawWindow(window, IntPtr.Zero, IntPtr.Zero, 0x181);
            DwmFlush();
            // Allow the system's activation/shadow animation to settle before the visual sample.
            System.Threading.Thread.Sleep(300);
            DwmFlush();
            using (var bitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb)) {
                using (var graphics = Graphics.FromImage(bitmap)) {
                    graphics.CopyFromScreen(x, y, 0, 0, new Size(width, height));
                }
                bitmap.Save(path, ImageFormat.Png);
            }
        } finally {
            SetWindowPos(window, wasTopmost ? new IntPtr(-1) : new IntPtr(-2), 0, 0, 0, 0, 0x13);
            DestroyWindow(backdrop);
            if (foreground != IntPtr.Zero && IsWindow(foreground)) SetForegroundWindow(foreground);
        }
        return width + "x" + height;
    }
}
'@
}
