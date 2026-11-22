// Disconnect bounds the acknowledgement wait. The MTA still owns any pending unsubscription.
namespace DeepSeek.Cua.Windows;

internal static class NotificationCleanup
{
    internal static async Task WaitForDisconnect(Task removal, TimeSpan grace, Action<Exception> report)
    {
        async Task ObserveRemoval()
        {
            try { await removal; }
            catch (Exception error) { report(error); }
        }

        try { await ObserveRemoval().WaitAsync(grace); }
        catch (TimeoutException error) { report(error); }
    }
}
