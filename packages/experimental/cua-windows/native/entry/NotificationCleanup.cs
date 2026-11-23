// The MTA owns the unsubscription after its connection closes.
namespace DeepSeek.Cua.Windows;

internal static class NotificationCleanup
{
    internal static async Task ObserveRemovalAsync(Task removal, Action<Exception> report)
    {
        try { await removal; }
        catch (Exception error) { report(error); }
    }
}
