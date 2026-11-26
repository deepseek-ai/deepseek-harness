// Shell icons include packaged applications and shortcut resources; missing artwork never grants access.
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace DeepSeek.Cua.Windows;

internal static class ApplicationIcons
{
    internal static string? Read(string path)
    {
        try
        {
            using var bitmap = path.StartsWith(@"shell:AppsFolder\", StringComparison.Ordinal)
                ? ShellBitmap(path) : ExecutableBitmap(path);
            if (bitmap is null) return null;
            using var stream = new MemoryStream();
            bitmap.Save(stream, System.Drawing.Imaging.ImageFormat.Png);
            return "data:image/png;base64," + Convert.ToBase64String(stream.ToArray());
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException
            or System.ComponentModel.Win32Exception or COMException)
        {
            // Missing or unreadable artwork uses the client's generic application icon.
            return null;
        }
    }

    private static Bitmap? ExecutableBitmap(string path)
    {
        using var icon = Icon.ExtractAssociatedIcon(path);
        return icon?.ToBitmap();
    }

    private static Bitmap ShellBitmap(string path)
    {
        var id = typeof(IShellItemImageFactory).GUID;
        Marshal.ThrowExceptionForHR(SHCreateItemFromParsingName(path, 0, ref id, out var factory));
        try
        {
            Marshal.ThrowExceptionForHR(factory.GetImage(new Size(64, 64), 5, out var handle));
            try { return CopyShellBitmap(handle); }
            finally { DeleteObject(handle); }
        }
        finally { Marshal.FinalReleaseComObject(factory); }
    }

    private static Bitmap CopyShellBitmap(nint handle)
    {
        using var dimensions = Image.FromHbitmap(handle);
        var bitmap = new Bitmap(dimensions.Width, dimensions.Height, PixelFormat.Format32bppPArgb);
        try
        {
            var data = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height),
                ImageLockMode.WriteOnly, PixelFormat.Format32bppPArgb);
            try
            {
                // GDI+ FromHbitmap discards Shell transparency. Copy the premultiplied pixels directly.
                var info = new BitmapInfo { Size = 40, Width = bitmap.Width, Height = -bitmap.Height,
                    Planes = 1, BitCount = 32 };
                var dc = CreateCompatibleDC(0);
                if (dc == 0) throw new System.ComponentModel.Win32Exception();
                try
                {
                    if (GetDIBits(dc, handle, 0, (uint)bitmap.Height, data.Scan0, ref info, 0) != bitmap.Height)
                        throw new System.ComponentModel.Win32Exception();
                }
                finally { DeleteDC(dc); }
            }
            finally { bitmap.UnlockBits(data); }
            return bitmap;
        }
        catch
        {
            bitmap.Dispose();
            throw;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BitmapInfo
    {
        internal uint Size;
        internal int Width, Height;
        internal ushort Planes, BitCount;
        internal uint Compression, SizeImage;
        internal int XPelsPerMeter, YPelsPerMeter;
        internal uint ColorsUsed, ColorsImportant, Color;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int SHCreateItemFromParsingName(string path, nint bindContext, ref Guid id,
        [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory factory);
    [DllImport("gdi32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeleteObject(nint handle);
    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern nint CreateCompatibleDC(nint dc);
    [DllImport("gdi32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeleteDC(nint dc);
    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern int GetDIBits(nint dc, nint bitmap, uint start, uint lines, nint bits,
        ref BitmapInfo info, uint usage);

    [ComImport, Guid("BCC18B79-BA16-442F-80C4-8A59C30C463B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItemImageFactory
    {
        [PreserveSig] int GetImage(Size size, uint flags, out nint bitmap);
    }
}
