// Connection controls never enter the model operation schema.
using System.Text.Json;

namespace DeepSeek.Cua.Protocol;

public enum NativeControl { Close, Cancel, CompletedCancel }

/// <summary>Cancellation matches the latest request; a late cancellation after its completion is a no-op.</summary>
public static class NativeControlFrame
{
    public static NativeControl Parse(JsonElement value, string? requestId, bool completed = false)
    {
        if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("type", out var type)
            || type.ValueKind != JsonValueKind.String)
            throw new NativeFailure("INVALID_REQUEST", "Expected a native connection control");
        if (type.GetString() == "close" && value.EnumerateObject().Count() == 1) return NativeControl.Close;
        if (type.GetString() == "cancel" && value.EnumerateObject().Count() == 2
            && value.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String
            && !string.IsNullOrEmpty(requestId) && id.GetString() == requestId)
            return completed ? NativeControl.CompletedCancel : NativeControl.Cancel;
        throw new NativeFailure("INVALID_REQUEST", "Cancellation requires a matching request; close accepts no fields");
    }
}
