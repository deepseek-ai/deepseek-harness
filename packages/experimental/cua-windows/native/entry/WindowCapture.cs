using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using DeepSeek.Cua.Protocol;
using global::Windows.Graphics.Capture;
using global::Windows.Graphics.DirectX;
using global::Windows.Graphics.DirectX.Direct3D11;
using global::Windows.Graphics.Imaging;
using global::Windows.Storage.Streams;
using WinRT;

namespace DeepSeek.Cua.Windows;

internal sealed class WindowCapture
{
    internal static bool IsSupported => GraphicsCaptureSession.IsSupported();

    internal async Task<object> Capture(AppState app, WindowState window, RequestContext context)
    {
        var geometry = window.Geometry(app, context);
        using var bitmap = await CaptureBitmap(window.Handle, context);
        if (bitmap.PixelWidth != geometry.Pixels.Width || bitmap.PixelHeight != geometry.Pixels.Height)
            throw new NativeFailure("WINDOW_CHANGED", "The captured size does not match the window bounds; capture the window again");

        using var stream = new InMemoryRandomAccessStream();
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream);
        context.Check();
        encoder.SetSoftwareBitmap(bitmap);
        await encoder.FlushAsync();
        context.Check();
        if (4 * ((stream.Size + 2) / 3) > (ulong)context.Config.MaxResponseBytes)
            throw new NativeFailure("NATIVE_RESPONSE_LIMIT", "The screenshot exceeds the configured response byte limit");
        var bytes = new byte[checked((int)stream.Size)];
        using (var reader = new DataReader(stream.GetInputStreamAt(0)))
        {
            if (await reader.LoadAsync((uint)bytes.Length) != (uint)bytes.Length)
                throw new NativeFailure("NATIVE_OPERATION", "The encoded screenshot could not be read completely");
            reader.ReadBytes(bytes);
        }

        DesktopSession.RequireInteractive();
        var current = window.Geometry(app, context);
        if (current.Pixels.Width != geometry.Pixels.Width || current.Pixels.Height != geometry.Pixels.Height || current.Dpi != geometry.Dpi)
            throw new NativeFailure("WINDOW_CHANGED", "The window size or display scale changed during capture; capture the window again");
        window.Observe(current);
        return new
        {
            mimeType = "image/png", data = Convert.ToBase64String(bytes),
            pixelWidth = bitmap.PixelWidth, pixelHeight = bitmap.PixelHeight,
            windowId = window.Id.ToString(CultureInfo.InvariantCulture),
            bounds = current.Bounds, coordinateSpace = "window-pixels",
        };
    }

    // The caller owns the CPU bitmap. The frame wait has its own timeout; request cancellation also covers initialization and encoding.
    private static async Task<SoftwareBitmap> CaptureBitmap(nint hwnd, RequestContext context)
    {
        context.Check();
        if (!IsSupported)
            throw new NativeFailure("UNSUPPORTED", "Windows Graphics Capture is not supported on this system");

        using var device = CreateCaptureDevice();
        var item = CreateItemForWindow(hwnd);
        var size = item.Size;
        if (size.Width <= 0 || size.Height <= 0)
            throw new NativeFailure("WINDOW_CHANGED", "The window has no usable capture size");

        using var pool = Direct3D11CaptureFramePool.CreateFreeThreaded(
            device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, size);
        using var session = pool.CreateCaptureSession(item);
        session.IsCursorCaptureEnabled = false;
        context.Check();
        session.StartCapture();

        var timer = Stopwatch.StartNew();
        while (timer.Elapsed.TotalMilliseconds < context.Config.ScreenshotTimeoutMs)
        {
            context.Check();
            using var frame = pool.TryGetNextFrame();
            if (frame is not null)
            {
                var contentSize = frame.ContentSize;
                if (contentSize.Width != size.Width || contentSize.Height != size.Height)
                    throw new NativeFailure("WINDOW_CHANGED", "The window size changed during capture; capture the window again");

                // Keep the frame alive until GPU readback settles, even when the request is cancelled.
                var bitmap = await SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface);
                if (context.Cancellation.IsCancellationRequested)
                {
                    bitmap.Dispose();
                    context.Check();
                }
                return bitmap;
            }
            await Task.Delay(context.Config.PollIntervalMs, context.Cancellation).ConfigureAwait(false);
        }
        throw new NativeFailure("SCREENSHOT_TIMEOUT", "No capture frame arrived before the deadline; the window may be minimized, closed, or unavailable for capture");
    }

    private static GraphicsCaptureItem CreateItemForWindow(nint hwnd)
    {
        var initHr = RoInitialize(RO_INIT_MULTITHREADED);
        if (initHr < 0 && initHr != RPC_E_CHANGED_MODE)
            Marshal.ThrowExceptionForHR(initHr);

        nint className = 0;
        nint itemPointer = 0;
        IGraphicsCaptureItemInterop? factory = null;
        try
        {
            className = MarshalString.FromManaged("Windows.Graphics.Capture.GraphicsCaptureItem");
            var interopIid = typeof(IGraphicsCaptureItemInterop).GUID;
            Marshal.ThrowExceptionForHR(RoGetActivationFactory(className, in interopIid, out factory));
            var itemIid = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
            Marshal.ThrowExceptionForHR(factory.CreateForWindow(hwnd, in itemIid, out itemPointer));
            return MarshalInspectable<GraphicsCaptureItem>.FromAbi(itemPointer);
        }
        finally
        {
            if (itemPointer != 0) Marshal.Release(itemPointer);
            if (factory is not null) Marshal.ReleaseComObject(factory);
            if (className != 0) MarshalString.DisposeAbi(className);
            // S_OK and S_FALSE require a matching call on this thread; RPC_E_CHANGED_MODE does not.
            if (initHr >= 0) RoUninitialize();
        }
    }

    private static IDirect3DDevice CreateCaptureDevice()
    {
        nint d3dDevice = 0;
        nint immediateContext = 0;
        nint dxgiDevice = 0;
        nint winrtDevice = 0;
        try
        {
            Marshal.ThrowExceptionForHR(D3D11CreateDevice(
                0, D3D_DRIVER_TYPE_HARDWARE, 0, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                0, 0, D3D11_SDK_VERSION, out d3dDevice, out _, out immediateContext));
            var dxgiDeviceIid = new Guid("54EC77FA-1377-44E6-8C32-88FD5F44C84C");
            Marshal.ThrowExceptionForHR(Marshal.QueryInterface(d3dDevice, in dxgiDeviceIid, out dxgiDevice));
            Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice, out winrtDevice));
            return MarshalInterface<IDirect3DDevice>.FromAbi(winrtDevice);
        }
        finally
        {
            // The projection owns its references; release only the raw references returned by the native APIs.
            if (winrtDevice != 0) Marshal.Release(winrtDevice);
            if (dxgiDevice != 0) Marshal.Release(dxgiDevice);
            if (immediateContext != 0) Marshal.Release(immediateContext);
            if (d3dDevice != 0) Marshal.Release(d3dDevice);
        }
    }

    private const uint RO_INIT_MULTITHREADED = 1;
    private const int RPC_E_CHANGED_MODE = unchecked((int)0x80010106);
    private const uint D3D_DRIVER_TYPE_HARDWARE = 1;
    private const uint D3D11_CREATE_DEVICE_BGRA_SUPPORT = 0x20;
    private const uint D3D11_SDK_VERSION = 7;

    [ComImport]
    [Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IGraphicsCaptureItemInterop
    {
        [PreserveSig]
        int CreateForWindow(nint window, in Guid iid, out nint result);

        [PreserveSig]
        int CreateForMonitor(nint monitor, in Guid iid, out nint result);
    }

    [DllImport("combase.dll", ExactSpelling = true)]
    private static extern int RoInitialize(uint initType);

    [DllImport("combase.dll", ExactSpelling = true)]
    private static extern void RoUninitialize();

    [DllImport("combase.dll", ExactSpelling = true)]
    private static extern int RoGetActivationFactory(nint activatableClassId, in Guid iid,
        [MarshalAs(UnmanagedType.Interface)] out IGraphicsCaptureItemInterop factory);

    [DllImport("d3d11.dll", ExactSpelling = true)]
    private static extern int D3D11CreateDevice(nint pAdapter, uint driverType, nint software, uint flags,
        nint pFeatureLevels, uint featureLevels, uint sdkVersion,
        out nint ppDevice, out uint pFeatureLevel, out nint ppImmediateContext);

    [DllImport("d3d11.dll", ExactSpelling = true)]
    private static extern int CreateDirect3D11DeviceFromDXGIDevice(nint dxgiDevice, out nint graphicsDevice);
}
