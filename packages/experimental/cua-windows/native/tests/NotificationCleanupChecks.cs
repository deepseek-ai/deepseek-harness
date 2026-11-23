// A queued UIA unsubscription reports only faults from the removal itself.
using DeepSeek.Cua.Windows;

internal static class NotificationCleanupChecks
{
    internal static async Task Run(Action<bool, string> check)
    {
        foreach (var fails in new[] { false, true })
        {
            var removal = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var diagnostics = new List<Exception>();
            var observation = NotificationCleanup.ObserveRemovalAsync(removal.Task, diagnostics.Add);
            check(!observation.IsCompleted && diagnostics.Count == 0, "Queued unsubscription has no diagnostic");

            var failure = new AggregateException("UIA refused to remove a handler");
            if (fails) removal.SetException(failure);
            else removal.SetResult();
            await observation;
            if (fails) check(diagnostics.SequenceEqual([failure]), "Failed unsubscription reports its error exactly once");
            else check(diagnostics.Count == 0, "Successful unsubscription completes quietly");
        }
    }
}
