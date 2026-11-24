// Per-connection limits from the Windows helper handshake.
using System.Text.Json;
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal sealed record NativeConfig(int MaxRequestBytes, int MaxResponseBytes, int AxTimeoutMs,
    double TextEventIntervalMs, int ScreenshotTimeoutMs, int TimeoutMs, int GraceMs, int PollIntervalMs, int LaunchWaitMs,
    int MaxClickHoldMs, int MaxDiffNotifications)
{
    internal static NativeConfig Parse(JsonElement value)
    {
        string[] required = ["maxRequestBytes", "maxResponseBytes", "axTimeoutMs", "textEventIntervalMs", "screenshotTimeoutMs", "timeoutMs", "graceMs", "pollIntervalMs", "launchWaitMs", "maxClickHoldMs"];
        if (value.ValueKind != JsonValueKind.Object || value.EnumerateObject().Any(item => item.Name != "maxDiffNotifications" && !required.Contains(item.Name))
            || required.Any(field => !value.TryGetProperty(field, out _))) throw new NativeFailure("INVALID_CONFIG", "Expected explicit native resource limits");
        int Positive(string field)
        {
            var property = value.GetProperty(field);
            if (property.ValueKind != JsonValueKind.Number || !property.TryGetInt32(out var number) || number <= 0)
                throw new NativeFailure("INVALID_CONFIG", field + " must be a positive Int32");
            return number;
        }
        var interval = value.GetProperty("textEventIntervalMs").GetDouble();
        if (!double.IsFinite(interval) || interval < 0 || interval > 1000) throw new NativeFailure("INVALID_CONFIG", "Invalid text event interval");
        return new(Positive("maxRequestBytes"), Positive("maxResponseBytes"), Positive("axTimeoutMs"), interval,
            Positive("screenshotTimeoutMs"), Positive("timeoutMs"), Positive("graceMs"), Positive("pollIntervalMs"),
            Positive("launchWaitMs"), Positive("maxClickHoldMs"), value.TryGetProperty("maxDiffNotifications", out _) ? Positive("maxDiffNotifications") : 50);
    }
}
