// Windows Graphics Capture returns the selected window even when another window covers it.
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using DeepSeek.Cua.Protocol;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using WinRT;
using global::Windows.Graphics.Capture;
using global::Windows.Graphics.DirectX;
using global::Windows.Graphics.DirectX.Direct3D11;

namespace DeepSeek.Cua.Windows;

internal sealed class WindowCapture : IAsyncDisposable
{
    private readonly MtaDispatcher dispatcher = new();
    private readonly CaptureAdmission admission = new();
    private ID3D11Device? device;
    private ID3D11DeviceContext? immediate;
    private IDirect3DDevice? captureDevice;

    internal Task<bool> IsSupported(CancellationToken cancellation)
        => dispatcher.Invoke(GraphicsCaptureSession.IsSupported, cancellation);

    private void EnsureDevice()
    {
        if (device is not null) return;
        var created = D3D11.D3D11CreateDevice(DriverType.Hardware, DeviceCreationFlags.BgraSupport);
        try
        {
            using var dxgi = created.QueryInterface<IDXGIDevice>();
            Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgi.NativePointer, out var pointer));
            try { captureDevice = MarshalInterface<IDirect3DDevice>.FromAbi(pointer); }
            finally { Marshal.Release(pointer); }
            immediate = created.ImmediateContext;
            device = created;
        }
        catch { created.Dispose(); throw; }
    }

    internal async Task<object> Capture(AppState app, WindowState window, RequestContext context)
    {
        if (!await IsSupported(context.Cancellation)) throw new NativeFailure("UNSUPPORTED", "Windows Graphics Capture is unavailable on this desktop");
        var geometry = window.Geometry(app, context);
        if (!window.IsOnScreen()) throw new NativeFailure("WINDOW_NOT_VISIBLE", "Restore the selected window with show and observe again before capturing");
        try
        {
            var operation = admission.Start(() => CaptureOwned(window.Handle, geometry, context));
            var data = await operation.WaitAsync(context.Cancellation);
            var current = window.Geometry(app, context);
            if (current.Pixels.Width != geometry.Pixels.Width || current.Pixels.Height != geometry.Pixels.Height || current.Dpi != geometry.Dpi)
                throw new NativeFailure("WINDOW_CHANGED", "The window changed during capture; observe again");
            DesktopSession.RequireInteractive();
            window.Observe(current);
            return new { mimeType = "image/png", data = Convert.ToBase64String(data), pixelWidth = geometry.Pixels.Width,
                pixelHeight = geometry.Pixels.Height, windowId = window.Id, bounds = current.Bounds, coordinateSpace = "window-pixels" };
        }
        catch (COMException error)
        {
            throw new NativeFailure(error.HResult == unchecked((int)0x80070005) ? "PERMISSION_DENIED" : "CAPTURE_FAILED",
                $"Windows refused the selected window capture (0x{error.HResult:X8}); restore the window and read fresh state");
        }
    }

    private async Task<byte[]> CaptureOwned(nint window, WindowGeometry geometry, RequestContext context)
    {
        CaptureRequest? request = null;
        try
        {
            await dispatcher.Invoke(() =>
            {
                EnsureDevice();
                request = new CaptureRequest(this, window, geometry, context);
                return true;
            }, context.Cancellation);
            return await request!.Result.WaitAsync(context.Cancellation);
        }
        finally
        {
            if (request is not null) await dispatcher.Invoke(() => { request.Dispose(); return true; }, CancellationToken.None);
        }
    }

    private sealed class CaptureRequest : IDisposable
    {
        private readonly object gate = new();
        private readonly TaskCompletionSource<byte[]> result = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly WindowCapture owner;
        private readonly WindowGeometry geometry;
        private readonly RequestContext context;
        private readonly GraphicsCaptureItem item;
        private Direct3D11CaptureFramePool? pool;
        private GraphicsCaptureSession? session;
        private bool disposed;

        internal Task<byte[]> Result => result.Task;

        internal CaptureRequest(WindowCapture owner, nint window, WindowGeometry geometry, RequestContext context)
        {
            this.owner = owner; this.geometry = geometry; this.context = context;
            item = ItemForWindow(window);
            if (item.Size.Width != geometry.Pixels.Width || item.Size.Height != geometry.Pixels.Height)
                throw new NativeFailure("WINDOW_CHANGED", "Windows capture bounds differ from the observed window; restore it and observe again");
            try
            {
                pool = Direct3D11CaptureFramePool.CreateFreeThreaded(owner.captureDevice!, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, item.Size);
                pool.FrameArrived += Frame;
                item.Closed += Closed;
                session = pool.CreateCaptureSession(item);
                session.IsCursorCaptureEnabled = false;
                session.StartCapture();
            }
            catch { Dispose(); throw; }
        }

        private void Closed(GraphicsCaptureItem sender, object args) => result.TrySetException(new NativeFailure("WINDOW_CHANGED", "The selected window closed during capture"));

        private void Frame(Direct3D11CaptureFramePool sender, object args)
        {
            lock (gate)
            {
                if (disposed || result.Task.IsCompleted) return;
                try
                {
                    context.Check();
                    using var frame = sender.TryGetNextFrame();
                    if (frame is null) return;
                    if (frame.ContentSize.Width != geometry.Pixels.Width || frame.ContentSize.Height != geometry.Pixels.Height)
                        throw new NativeFailure("WINDOW_CHANGED", "The capture frame dimensions changed");
                    result.TrySetResult(owner.Encode(frame.Surface, geometry.Pixels.Width, geometry.Pixels.Height, context));
                }
                catch (Exception error) { result.TrySetException(error); }
            }
        }

        public void Dispose()
        {
            lock (gate)
            {
                if (disposed) return;
                disposed = true;
                item.Closed -= Closed;
                if (pool is not null) pool.FrameArrived -= Frame;
            }
            // Native disposal can wait for callbacks; queued callbacks must be able to observe disposed.
            session?.Dispose();
            pool?.Dispose();
        }
    }

    private byte[] Encode(IDirect3DSurface surface, int width, int height, RequestContext context)
    {
        var access = surface.As<IDirect3DDxgiInterfaceAccess>();
        var textureId = typeof(ID3D11Texture2D).GUID;
        Marshal.ThrowExceptionForHR(access.GetInterface(ref textureId, out var pointer));
        using var texture = new ID3D11Texture2D(pointer);
        if (texture.Description.Width != width || texture.Description.Height != height || texture.Description.Format != Format.B8G8R8A8_UNorm)
            throw new NativeFailure("WINDOW_CHANGED", "The captured texture differs from the selected window geometry");
        var description = new Texture2DDescription(Format.B8G8R8A8_UNorm, (uint)width, (uint)height,
            mipLevels: 1, bindFlags: BindFlags.None, usage: ResourceUsage.Staging, cpuAccessFlags: CpuAccessFlags.Read);
        using var staging = device!.CreateTexture2D(description);
        immediate!.CopyResource(staging, texture);
        var mapped = immediate.Map(staging, 0, MapMode.Read);
        using var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        try
        {
            var pixels = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            try
            {
                var row = new byte[checked(width * 4)];
                for (var y = 0; y < height; y++)
                {
                    context.Check();
                    Marshal.Copy(mapped.DataPointer + checked(y * (int)mapped.RowPitch), row, 0, row.Length);
                    Marshal.Copy(row, 0, pixels.Scan0 + y * pixels.Stride, row.Length);
                }
            }
            finally { bitmap.UnlockBits(pixels); }
        }
        finally { immediate.Unmap(staging, 0); }
        context.Check();
        using var output = new MemoryStream();
        bitmap.Save(output, ImageFormat.Png);
        if (output.Length * 4 / 3 > context.Config.MaxResponseBytes)
            throw new NativeFailure("NATIVE_RESPONSE_LIMIT", "The screenshot exceeds the response byte limit");
        return output.ToArray();
    }

    private static GraphicsCaptureItem ItemForWindow(nint window)
    {
        const string className = "Windows.Graphics.Capture.GraphicsCaptureItem";
        Marshal.ThrowExceptionForHR(WindowsCreateString(className, className.Length, out var name));
        nint factoryPointer = 0;
        object? factory = null;
        try
        {
            var factoryId = typeof(IGraphicsCaptureItemInterop).GUID;
            Marshal.ThrowExceptionForHR(RoGetActivationFactory(name, ref factoryId, out factoryPointer));
            factory = Marshal.GetObjectForIUnknown(factoryPointer);
            var itemId = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
            Marshal.ThrowExceptionForHR(((IGraphicsCaptureItemInterop)factory).CreateForWindow(window, ref itemId, out var item));
            try { return MarshalInterface<GraphicsCaptureItem>.FromAbi(item); }
            finally { Marshal.Release(item); }
        }
        finally
        {
            if (factory is not null) Marshal.FinalReleaseComObject(factory);
            if (factoryPointer != 0) Marshal.Release(factoryPointer);
            WindowsDeleteString(name);
        }
    }

    public async ValueTask DisposeAsync()
    {
        await admission.Join();
        await dispatcher.Invoke(() =>
        {
            captureDevice?.Dispose();
            immediate?.Dispose();
            device?.Dispose();
            return true;
        }, CancellationToken.None);
        await dispatcher.DisposeAsync();
    }

    [ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IGraphicsCaptureItemInterop
    {
        [PreserveSig] int CreateForWindow(nint window, ref Guid id, out nint item);
        [PreserveSig] int CreateForMonitor(nint monitor, ref Guid id, out nint item);
    }
    [ComImport, Guid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IDirect3DDxgiInterfaceAccess
    {
        [PreserveSig] int GetInterface(ref Guid id, out nint value);
    }
    [DllImport("d3d11.dll", ExactSpelling = true)] private static extern int CreateDirect3D11DeviceFromDXGIDevice(nint device, out nint result);
    [DllImport("combase.dll", CharSet = CharSet.Unicode)] private static extern int WindowsCreateString(string source, int length, out nint value);
    [DllImport("combase.dll")] private static extern int WindowsDeleteString(nint value);
    [DllImport("combase.dll")] private static extern int RoGetActivationFactory(nint name, ref Guid id, out nint value);
}
