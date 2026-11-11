// Native desktop operations keep physical pixels and process identity at the Windows edge.
using System.Runtime.InteropServices;
using System.Text;

namespace DeepSeek.Cua.Windows;

internal static class Win32
{
    [DllImport("combase.dll")] internal static extern int RoInitialize(uint initialization);
    [DllImport("combase.dll")] internal static extern void RoUninitialize();
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] internal static extern nint GetWindowLongPtr(nint window, int index);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetCursorPos(out Point point);
    internal delegate bool WindowVisitor(nint window, nint parameter);

    [StructLayout(LayoutKind.Sequential)] internal struct Point { internal int X, Y; }
    [StructLayout(LayoutKind.Sequential)] internal struct Rect
    {
        internal int Left, Top, Right, Bottom;
        internal int Width => Right - Left;
        internal int Height => Bottom - Top;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct GuiThreadInfo
    {
        internal uint Size, Flags;
        internal nint Active, Focus, Capture, MenuOwner, MoveSize, Caret;
        internal Rect CaretRect;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct Input { internal uint Type; internal InputData Data; }
    [StructLayout(LayoutKind.Explicit)] internal struct InputData
    {
        [FieldOffset(0)] internal MouseInput Mouse;
        [FieldOffset(0)] internal KeyboardInput Keyboard;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct MouseInput
    {
        internal int X, Y;
        internal uint Data, Flags, Time;
        internal nuint Extra;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct KeyboardInput
    {
        internal ushort Key, Scan;
        internal uint Flags, Time;
        internal nuint Extra;
    }

    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool EnumWindows(WindowVisitor visitor, nint parameter);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(nint window, out uint processId);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool IsWindow(nint window);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool IsWindowVisible(nint window);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool IsIconic(nint window);
    [DllImport("user32.dll")] internal static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] internal static extern nint GetAncestor(nint window, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetWindowText(nint window, StringBuilder text, int maximum);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern int GetWindowTextLength(nint window);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetWindowRect(nint window, out Rect rectangle);
    [DllImport("dwmapi.dll")] internal static extern int DwmGetWindowAttribute(nint window, int attribute, out Rect rectangle, int size);
    [DllImport("dwmapi.dll")] internal static extern int DwmGetWindowAttribute(nint window, int attribute, out int value, int size);
    [DllImport("user32.dll")] internal static extern uint GetDpiForWindow(nint window);
    [DllImport("user32.dll")] internal static extern nint SetThreadDpiAwarenessContext(nint context);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetForegroundWindow(nint window);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool ShowWindowAsync(nint window, int command);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
    [DllImport("user32.dll", SetLastError = true)] internal static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")] internal static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] internal static extern nint GetKeyboardLayout(uint thread);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern short VkKeyScanEx(char character, nint layout);
    [DllImport("user32.dll")] internal static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] internal static extern nint WindowFromPoint(Point point);
    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SystemParametersInfo(uint action, uint parameter, out uint value, uint flags);
    [DllImport("user32.dll", SetLastError = true)] internal static extern nint OpenInputDesktop(uint flags, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint access);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CloseDesktop(nint desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetUserObjectInformation(nint handle, int index, StringBuilder value, int length, out int needed);
    [DllImport("wtsapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool WTSQuerySessionInformation(nint server, int session, int information, out nint buffer, out int bytes);
    [DllImport("wtsapi32.dll")] internal static extern void WTSFreeMemory(nint memory);

    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool OpenClipboard(nint owner);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CloseClipboard();
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool EmptyClipboard();
    [DllImport("user32.dll")] internal static extern nint GetClipboardOwner();
    [DllImport("user32.dll")] internal static extern nint GetOpenClipboardWindow();
    [DllImport("user32.dll")] internal static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll", SetLastError = true)] internal static extern uint EnumClipboardFormats(uint previous);
    [DllImport("user32.dll", SetLastError = true)] internal static extern nint GetClipboardData(uint format);
    [DllImport("user32.dll", SetLastError = true)] internal static extern nint SetClipboardData(uint format, nint data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern uint RegisterClipboardFormat(string name);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern nint GlobalAlloc(uint flags, nuint bytes);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern nint GlobalLock(nint memory);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GlobalUnlock(nint memory);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern nuint GlobalSize(nint memory);
    [DllImport("kernel32.dll")] internal static extern nint GlobalFree(nint memory);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern uint GetFinalPathNameByHandle(Microsoft.Win32.SafeHandles.SafeFileHandle file, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetProcessTimes(Microsoft.Win32.SafeHandles.SafeProcessHandle process, out long created, out long exited, out long kernel, out long user);

    [DllImport("shell32.dll", PreserveSig = true)]
    internal static extern int SHGetPropertyStoreForWindow(nint window, ref Guid id,
        [MarshalAs(UnmanagedType.Interface)] out IPropertyStore? store);
    [DllImport("ole32.dll")] internal static extern int PropVariantClear(ref PropVariant value);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    internal static extern int GetApplicationUserModelId(nint process, ref uint length, StringBuilder? value);
    [DllImport("kernel32.dll", EntryPoint = "QueryFullProcessImageNameW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool QueryFullProcessImageName(nint process, uint flags, StringBuilder name, ref uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern nint OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseHandle(nint handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);

    [StructLayout(LayoutKind.Sequential)] internal struct PropertyKey { internal Guid FormatId; internal uint PropertyId; }
    // PROPVARIANT is 24 bytes on supported x64/arm64 targets; the trailing field reserves its union.
    [StructLayout(LayoutKind.Sequential)] internal struct PropVariant
    {
        internal ushort ValueType;
        internal ushort Reserved1, Reserved2, Reserved3;
        internal nint Pointer;
        internal nint Pointer2;
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
    }
}
