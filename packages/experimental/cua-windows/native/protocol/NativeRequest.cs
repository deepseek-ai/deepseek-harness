// Strict JSONL admission shares the TypeScript operation schema with the macOS provider.
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Json.Schema;

namespace DeepSeek.Cua.Protocol;

/// <summary>A native refusal whose code remains visible through the shared CUA client.</summary>
public sealed class NativeFailure(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

/// <summary>Wire encoding preserves readable task text and always emits one JSON value per line.</summary>
public static class WireJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };
    public static readonly UTF8Encoding Utf8 = new(false, true);

    public static JsonElement Parse(string text)
    {
        using var document = JsonDocument.Parse(text);
        RejectDuplicates(document.RootElement);
        return document.RootElement.Clone();
    }

    private static void RejectDuplicates(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in value.EnumerateObject())
            {
                if (!names.Add(property.Name)) throw new NativeFailure("INVALID_REQUEST", "Repeated JSON property");
                RejectDuplicates(property.Value);
            }
        }
        else if (value.ValueKind == JsonValueKind.Array)
            foreach (var item in value.EnumerateArray()) RejectDuplicates(item);
    }
}

/// <summary>Validated operation parameters. Resource fields are supplied only by the Host.</summary>
public sealed record NativeRequest(string Id, string Method, JsonElement Params)
{
    private static readonly JsonSchema Schema = LoadSchema();

    private static JsonSchema LoadSchema()
    {
        using var stream = typeof(NativeRequest).Assembly.GetManifestResourceStream("DeepSeek.Cua.NativeRequestSchema.json")
            ?? throw new InvalidOperationException("The native request schema is missing");
        using var reader = new StreamReader(stream, WireJson.Utf8);
        return JsonSchema.FromText(reader.ReadToEnd());
    }

    public static NativeRequest Parse(JsonElement value)
    {
        if (!Schema.Evaluate(value, new EvaluationOptions { OutputFormat = OutputFormat.Flag }).IsValid)
            throw new NativeFailure("INVALID_ARGUMENT", "The request does not match the CUA operation schema");
        return new(value.GetProperty("id").GetString()!, value.GetProperty("method").GetString()!, value.GetProperty("params"));
    }
}

/// <summary>Reads bounded UTF-8 frames without allowing an unterminated line to grow without limit.</summary>
public sealed class FrameReader(Stream stream)
{
    private readonly byte[] buffer = new byte[4096];
    private int start;
    private int end;

    public async Task<string?> ReadAsync(int maximumBytes, CancellationToken cancellation)
    {
        using var line = new MemoryStream();
        while (true)
        {
            if (start == end)
            {
                end = await stream.ReadAsync(buffer, 0, buffer.Length, cancellation);
                start = 0;
                if (end == 0)
                {
                    if (line.Length != 0) throw new NativeFailure("INVALID_REQUEST", "Native input ended inside a frame");
                    return null;
                }
            }
            var newline = Array.IndexOf(buffer, (byte)'\n', start, end - start);
            var count = (newline < 0 ? end : newline + 1) - start;
            if (line.Length + count > maximumBytes) throw new NativeFailure("NATIVE_REQUEST_LIMIT", "Request exceeded its byte limit");
            line.Write(buffer, start, count);
            start += count;
            if (newline >= 0) return WireJson.Utf8.GetString(line.GetBuffer(), 0, checked((int)line.Length - 1));
        }
    }
}
