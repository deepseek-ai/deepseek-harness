// UI Automation and clipboard COM objects each stay on their owning apartment.
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text.Json;
using DeepSeek.Cua.Protocol;
using Forms = System.Windows.Forms;
using Timer = System.Threading.Timer;

namespace DeepSeek.Cua.Windows;

internal sealed record NativeConfig(int MaxRequestBytes, int MaxResponseBytes, int AxTimeoutMs,
    double TextEventIntervalMs, int ScreenshotTimeoutMs, int TimeoutMs, int GraceMs, int PollIntervalMs, int MaxClickHoldMs)
{
    internal static NativeConfig Parse(JsonElement value)
    {
        string[] fields = ["maxRequestBytes", "maxResponseBytes", "axTimeoutMs", "textEventIntervalMs", "screenshotTimeoutMs", "timeoutMs", "graceMs", "pollIntervalMs", "maxClickHoldMs"];
        if (value.ValueKind != JsonValueKind.Object || value.EnumerateObject().Any(item => !fields.Contains(item.Name))
            || fields.Any(field => !value.TryGetProperty(field, out _))) throw new NativeFailure("INVALID_CONFIG", "Expected explicit native resource limits");
        int Positive(string field)
        {
            if (!value.GetProperty(field).TryGetInt32(out var number) || number <= 0) throw new NativeFailure("INVALID_CONFIG", field + " must be a positive Int32");
            return number;
        }
        var interval = value.GetProperty("textEventIntervalMs").GetDouble();
        if (!double.IsFinite(interval) || interval < 0 || interval > 1000) throw new NativeFailure("INVALID_CONFIG", "Invalid text event interval");
        return new(Positive("maxRequestBytes"), Positive("maxResponseBytes"), Positive("axTimeoutMs"), interval,
            Positive("screenshotTimeoutMs"), Positive("timeoutMs"), Positive("graceMs"), Positive("pollIntervalMs"), Positive("maxClickHoldMs"));
    }
}

internal sealed class MtaDispatcher : IAsyncDisposable
{
    private readonly BlockingCollection<Action> queue = new();
    private readonly TaskCompletionSource<object?> stopped = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource<object?> ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly Thread thread;

    internal MtaDispatcher()
    {
        thread = new Thread(() =>
        {
            var initialized = false;
            try
            {
                Marshal.ThrowExceptionForHR(Win32.RoInitialize(1));
                initialized = true;
                Win32.SetThreadDpiAwarenessContext(-4);
                ready.SetResult(null);
                foreach (var work in queue.GetConsumingEnumerable()) work();
            }
            catch (Exception error) { ready.TrySetException(error); }
            finally { if (initialized) Win32.RoUninitialize(); stopped.TrySetResult(null); }
        }) { IsBackground = true, Name = "dsh-cua-uia" };
        thread.SetApartmentState(ApartmentState.MTA);
        thread.Start();
    }

    internal async Task<T> Invoke<T>(Func<T> work, CancellationToken cancellation)
    {
        await ready.Task.WaitAsync(cancellation);
        var result = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        queue.Add(() =>
        {
            try { cancellation.ThrowIfCancellationRequested(); var value = work(); cancellation.ThrowIfCancellationRequested(); result.TrySetResult(value); }
            catch (OperationCanceledException) { result.TrySetCanceled(cancellation); }
            catch (Exception error) { result.TrySetException(error); }
        });
        return await result.Task;
    }

    public async ValueTask DisposeAsync()
    {
        queue.CompleteAdding();
        await stopped.Task;
        queue.Dispose();
    }
}

internal sealed class ServiceControl : Forms.Control
{
    internal Func<int, nint, bool>? ClipboardMessage;
    protected override Forms.CreateParams CreateParams
    {
        get { var value = base.CreateParams; value.Parent = -3; return value; }
    }
    protected override void WndProc(ref Forms.Message message)
    {
        if (ClipboardMessage?.Invoke(message.Msg, message.WParam) == true) return;
        base.WndProc(ref message);
    }
}

internal sealed class StaDispatcher : IAsyncDisposable
{
    private readonly TaskCompletionSource<ServiceControl> ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource<object?> stopped = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly Thread thread;
    private ServiceControl? service;

    internal StaDispatcher()
    {
        thread = new Thread(() =>
        {
            try
            {
                Win32.SetThreadDpiAwarenessContext(-4);
                using var control = new ServiceControl();
                _ = control.Handle;
                service = control;
                ready.SetResult(control);
                Forms.Application.Run();
            }
            catch (Exception error) { ready.TrySetException(error); }
            finally { stopped.TrySetResult(null); }
        }) { IsBackground = true, Name = "dsh-cua-clipboard" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
    }

    internal async Task<T> Invoke<T>(Func<ServiceControl, T> work, CancellationToken cancellation)
    {
        var control = await ready.Task.WaitAsync(cancellation);
        cancellation.ThrowIfCancellationRequested();
        // A caller already on the STA must not enqueue work for the message loop it is blocking.
        if (Environment.CurrentManagedThreadId == thread.ManagedThreadId)
        {
            var inline = work(control);
            cancellation.ThrowIfCancellationRequested();
            return inline;
        }
        var result = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        control.BeginInvoke(() =>
        {
            try { cancellation.ThrowIfCancellationRequested(); var value = work(control); cancellation.ThrowIfCancellationRequested(); result.TrySetResult(value); }
            catch (OperationCanceledException) { result.TrySetCanceled(cancellation); }
            catch (Exception error) { result.TrySetException(error); }
        });
        return await result.Task;
    }

    internal T InvokeSync<T>(Func<ServiceControl, T> work, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        if (Environment.CurrentManagedThreadId == thread.ManagedThreadId)
        {
            var control = service ?? throw new InvalidOperationException("The STA dispatcher has not started");
            var inline = work(control);
            cancellation.ThrowIfCancellationRequested();
            return inline;
        }
        return Invoke(work, cancellation).GetAwaiter().GetResult();
    }

    internal Task Invoke(Action work, CancellationToken cancellation) => Invoke(_ => { work(); return true; }, cancellation);

    public async ValueTask DisposeAsync()
    {
        try { await ready.Task; }
        catch (Exception error) { _ = error; await stopped.Task; return; }
        await Invoke(() => Forms.Application.ExitThread(), CancellationToken.None);
        await stopped.Task;
    }
}

internal sealed class RequestContext(NativeConfig config, CancellationToken cancellation, MtaDispatcher mta, StaDispatcher sta)
{
    internal NativeConfig Config { get; } = config;
    internal CancellationToken Cancellation { get; } = cancellation;
    internal MtaDispatcher Mta { get; } = mta;
    internal StaDispatcher Sta { get; } = sta;
    internal void Check() => Cancellation.ThrowIfCancellationRequested();

    internal T Ax<T>(Func<T> call)
    {
        Check();
        var completed = 0;
        using var timer = new Timer(_ =>
        {
            if (Interlocked.Exchange(ref completed, 1) == 0)
                NativeServer.Fatal("AX_TIMEOUT", "A Windows accessibility call did not return within its configured deadline");
        }, null, Config.AxTimeoutMs, Timeout.Infinite);
        try { var result = call(); Cancellation.ThrowIfCancellationRequested(); return result; }
        finally { Interlocked.Exchange(ref completed, 1); }
    }
}
