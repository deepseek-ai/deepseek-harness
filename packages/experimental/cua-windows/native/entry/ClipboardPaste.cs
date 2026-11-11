// Delayed rendering waits for clipboard data consumption before restoring the previous formats.
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal sealed class ClipboardPaste
{
    private sealed class Transaction(ServiceControl control, int targetPid, uint format, byte[] payload, List<(uint Format, byte[] Data)> previous, uint originalSequence)
    {
        internal readonly TaskCompletionSource<object?> Consumed = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private uint sequence = originalSequence;
        private bool replaced;
        private bool restoring;
        private bool changed;
        private bool rendered;

        internal void Begin()
        {
            if (!Win32.OpenClipboard(control.Handle)) throw new NativeFailure("CLIPBOARD_BUSY", "Another application is using the clipboard");
            try
            {
                if (Win32.GetClipboardSequenceNumber() != sequence) throw new NativeFailure("CLIPBOARD_CHANGED", "The clipboard changed before paste; it was not replaced");
                if (!Win32.EmptyClipboard()) throw new NativeFailure("CLIPBOARD_UNAVAILABLE", "Windows refused clipboard replacement");
                replaced = true;
                control.ClipboardMessage = Message;
                Marshal.SetLastPInvokeError(0);
                Win32.SetClipboardData(format, 0);
                var error = Marshal.GetLastPInvokeError();
                sequence = Win32.GetClipboardSequenceNumber();
                if (error != 0) throw new NativeFailure("CLIPBOARD_UNAVAILABLE", "Windows refused the temporary clipboard format");
            }
            finally { Win32.CloseClipboard(); }
            // CloseClipboard can add synthesized formats and advance the sequence.
            sequence = Win32.GetClipboardSequenceNumber();
        }

        private bool Message(int message, nint parameter)
        {
            if (message == 0x0307 && !restoring)
            {
                changed = true;
                Consumed.TrySetException(new NativeFailure("CLIPBOARD_CHANGED", "Another writer replaced the clipboard; observe before deciding on further input"));
                return true;
            }
            if (message is not (0x0305 or 0x0306)) return false;
            if (message == 0x0305 && (uint)parameter != format) return false;
            if (message == 0x0305)
            {
                Win32.GetWindowThreadProcessId(Win32.GetOpenClipboardWindow(), out var readerPid);
                // Clipboard monitors can request data before the target handles Control+V.
                // Leave the format delayed until the selected application requests it.
                if (readerPid != targetPid) return true;
            }
            var opened = false;
            try
            {
                if (Win32.GetClipboardOwner() != control.Handle) return true;
                if (message == 0x0306)
                {
                    if (!Win32.OpenClipboard(control.Handle)) return true;
                    opened = true;
                }
                if (Win32.GetClipboardSequenceNumber() != sequence) changed = true;
                Publish(format, payload);
                rendered = true;
                sequence = Win32.GetClipboardSequenceNumber();
                if (changed) Consumed.TrySetException(new NativeFailure("CLIPBOARD_CHANGED", "Another writer changed the clipboard during paste"));
                else if (message == 0x0305) Consumed.TrySetResult(null);
            }
            catch (Exception error) { Consumed.TrySetException(error); }
            finally { if (opened) Win32.CloseClipboard(); }
            return true;
        }

        internal bool Restore()
        {
            if (!replaced) return true;
            if (Win32.GetClipboardOwner() != control.Handle) { control.ClipboardMessage = null; return true; }
            if (!Win32.OpenClipboard(control.Handle)) return false;
            try
            {
                if (Win32.GetClipboardSequenceNumber() != sequence) changed = true;
                if (changed)
                {
                    // A later writer keeps its data; fulfill any remaining promise before releasing its renderer.
                    if (!rendered) Publish(format, payload);
                    return true;
                }
                restoring = true;
                if (!Win32.EmptyClipboard()) throw new NativeFailure("CLIPBOARD_UNAVAILABLE", "Windows refused clipboard restoration");
                foreach (var original in previous) Publish(original.Format, original.Data);
                return true;
            }
            finally { control.ClipboardMessage = null; Win32.CloseClipboard(); }
        }
    }

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

    private static Transaction Prepare(ServiceControl control, int targetPid, string text, string format, int maximumBytes)
    {
        if (!Win32.OpenClipboard(control.Handle)) throw new NativeFailure("CLIPBOARD_BUSY", "Another application is using the clipboard");
        try
        {
            var previous = new List<(uint, byte[])>();
            long total = 0;
            uint current = 0;
            while (true)
            {
                Marshal.SetLastPInvokeError(0);
                current = Win32.EnumClipboardFormats(current);
                if (current == 0)
                {
                    if (Marshal.GetLastPInvokeError() != 0) throw new NativeFailure("CLIPBOARD_UNAVAILABLE", "The existing clipboard formats could not be enumerated");
                    break;
                }
                if (current is 3 or 0x0083)
                    throw new NativeFailure("CLIPBOARD_UNAVAILABLE", "The clipboard contains a metafile with nested handles; paste left it unchanged");
                var memory = Win32.GetClipboardData(current);
                var size = memory == 0 ? 0 : Win32.GlobalSize(memory);
                if (size == 0 || size > int.MaxValue)
                    throw new NativeFailure("CLIPBOARD_UNAVAILABLE", "The current clipboard includes a format that cannot be preserved as bytes; paste left it unchanged");
                total += (long)size;
                if (total > maximumBytes) throw new NativeFailure("CLIPBOARD_LIMIT", "The existing clipboard exceeds maxClipboardBytes; it was not replaced");
                var pointer = Win32.GlobalLock(memory);
                if (pointer == 0) throw new NativeFailure("CLIPBOARD_UNAVAILABLE", "The current clipboard data could not be read; it was not replaced");
                var bytes = new byte[(int)size];
                try { Marshal.Copy(pointer, bytes, 0, bytes.Length); }
                finally { Win32.GlobalUnlock(memory); }
                previous.Add((current, bytes));
            }
            var payload = format == "html" ? HtmlClipboard.Encode(text) : Encoding.Unicode.GetBytes(text + "\0");
            var nativeFormat = format == "html" ? Win32.RegisterClipboardFormat("HTML Format") : 13u;
            if (nativeFormat == 0) throw new NativeFailure("CLIPBOARD_UNAVAILABLE", "Windows could not register the requested clipboard format");
            return new(control, targetPid, nativeFormat, payload, previous, Win32.GetClipboardSequenceNumber());
        }
        finally { Win32.CloseClipboard(); }
    }

    internal async Task Paste(AppState app, WindowState window, string text, string format, int maximumBytes, int readTimeoutMs, RequestContext context)
    {
        Windows.RequireForeground(app, window, context);
        // Clipboard readers are matched against this window's real process, not a removal-only app identity.
        var targetPid = window.ProcessId;
        var transaction = await context.Sta.Invoke(control => Prepare(control, targetPid, text, format, maximumBytes), context.Cancellation);
        try
        {
            await context.Sta.Invoke(() => transaction.Begin(), context.Cancellation);
            Input.Press(app, window, "v", ["control"], context);
            try { await transaction.Consumed.Task.WaitAsync(TimeSpan.FromMilliseconds(readTimeoutMs), context.Cancellation); }
            catch (TimeoutException)
            {
                throw new NativeFailure("PASTE_NOT_CONSUMED", "The target did not request clipboard data before pasteReadTimeoutMs; observe before deciding on further input");
            }
        }
        finally
        {
            var clock = Stopwatch.StartNew();
            while (!await context.Sta.Invoke(_ => transaction.Restore(), CancellationToken.None))
            {
                if (clock.ElapsedMilliseconds >= context.Config.GraceMs)
                    NativeServer.Fatal("CLIPBOARD_CLEANUP", "Clipboard cleanup did not finish before the native grace deadline");
                await Task.Delay(context.Config.PollIntervalMs);
            }
        }
    }
}
