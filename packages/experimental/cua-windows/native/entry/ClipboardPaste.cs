// Paste publishes clipboard data immediately and leaves it available after dispatching Control+V.
using System.Runtime.InteropServices;
using System.Text;
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal sealed class ClipboardPaste
{
    private static void Publish(uint format, byte[] bytes)
    {
        var memory = Win32.GlobalAlloc(0x0002, (nuint)bytes.Length);
        if (memory == 0) throw new NativeFailure("CLIPBOARD_UNAVAILABLE", "Clipboard memory allocation failed");
        try
        {
            var pointer = Win32.GlobalLock(memory);
            if (pointer == 0) throw new NativeFailure("CLIPBOARD_UNAVAILABLE", "Clipboard memory could not be locked");
            try { Marshal.Copy(bytes, 0, pointer, bytes.Length); }
            finally { Win32.GlobalUnlock(memory); }
            if (Win32.SetClipboardData(format, memory) == 0) throw new NativeFailure("CLIPBOARD_UNAVAILABLE", "Windows refused clipboard data");
            memory = 0;
        }
        finally { if (memory != 0) Win32.GlobalFree(memory); }
    }

    private static void SetClipboard(ServiceControl control, string text, string format, int maximumBytes)
    {
        var payload = format == "html" ? HtmlClipboard.Encode(text) : Encoding.Unicode.GetBytes(text + "\0");
        if (payload.Length > maximumBytes) throw new NativeFailure("CLIPBOARD_LIMIT", "The paste content exceeds maxClipboardBytes");
        var nativeFormat = format == "html" ? Win32.RegisterClipboardFormat("HTML Format") : 13u;
        if (nativeFormat == 0) throw new NativeFailure("CLIPBOARD_UNAVAILABLE", "Windows could not register the requested clipboard format");
        if (!Win32.OpenClipboard(control.Handle)) throw new NativeFailure("CLIPBOARD_BUSY", "Another application is using the clipboard");
        try
        {
            if (!Win32.EmptyClipboard()) throw new NativeFailure("CLIPBOARD_UNAVAILABLE", "Windows refused clipboard replacement");
            Publish(nativeFormat, payload);
        }
        finally { Win32.CloseClipboard(); }
    }

    internal async Task Paste(AppState app, WindowState window, string text, string format, int maximumBytes, RequestContext context)
    {
        Windows.RequireForeground(app, window, context);
        await context.Sta.Invoke(control =>
        {
            SetClipboard(control, text, format, maximumBytes);
            return true;
        }, context.Cancellation);
        Input.Press(app, window, "v", ["ctrl"], context);
    }
}
