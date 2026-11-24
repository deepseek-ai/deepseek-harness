// Application identity shared by conversation and profile grants.
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;

namespace DeepSeek.Cua.Windows;

internal sealed record ApplicationAuthorization(string Id, string Name,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ExecutablePath)
{
    /// <summary>The exact AUMID or resolved executable path identifies the application across conversations.</summary>
    public bool Persistable => true;

    // Absolute selectors address executable files. Only the process image may supply that identity.
    internal static string? AsAumid(string? value)
        => string.IsNullOrWhiteSpace(value) || Path.IsPathFullyQualified(value) ? null : value;

    internal static ApplicationAuthorization Create(string appId, string name, string? executablePath)
        => new(Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("windows-aumid\0" + appId))), name, executablePath);
}
