// A stalled MTA must not prevent an explicit close, even if removal later fails.
using DeepSeek.Cua.Windows;

internal static class NotificationCleanupChecks
{
    internal static async Task Run(Action<bool, string> check)
    {
        var failure = new AggregateException("UIA refused to remove a handler");
        Exception? reported = null;
        await NotificationCleanup.WaitForDisconnect(Task.CompletedTask, TimeSpan.Zero, error => reported = error);
        check(reported == null, "Completed unsubscription permits close without a diagnostic");
        await NotificationCleanup.WaitForDisconnect(Task.FromException(failure), TimeSpan.Zero, error => reported = error);
        check(reported == failure, "Failed unsubscription permits close and reports the failure");

        var queued = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var lateFailure = new TaskCompletionSource<Exception>(TaskCreationOptions.RunContinuationsAsynchronously);
        var timeout = false;
        await NotificationCleanup.WaitForDisconnect(queued.Task, TimeSpan.Zero, error =>
        {
            if (error is TimeoutException) timeout = true;
            else lateFailure.TrySetResult(error);
        });
        check(timeout && !queued.Task.IsCompleted, "Close can proceed while unsubscription remains queued");
        queued.SetException(failure);
        check(await lateFailure.Task.WaitAsync(TimeSpan.FromSeconds(5)) == failure, "Late unsubscription faults are observed");
    }
}
