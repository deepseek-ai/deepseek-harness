// The native operation owns its capture slot until cleanup finishes, independently of the caller's await.
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal sealed class CaptureAdmission
{
    private readonly object gate = new();
    private Task<byte[]>? pending;

    internal Task<byte[]> Start(Func<Task<byte[]>> operation)
    {
        lock (gate)
        {
            if (pending is { IsCompleted: false })
                throw new NativeFailure("CAPTURE_BUSY", "The previous Windows capture is still releasing its resources; UIA and input remain available");
            pending = operation();
            _ = pending.ContinueWith(completed => { _ = completed.Exception; }, CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            return pending;
        }
    }

    internal async Task Join()
    {
        Task<byte[]>? active;
        lock (gate) active = pending;
        if (active is not null)
        {
            try { await active; }
            catch (Exception error) { _ = error; /* The requesting connection owns the capture failure. */ }
        }
    }
}
