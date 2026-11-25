// Versions and copies with the same AUMID share consent; unidentified programs use their canonical path.
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;

namespace DeepSeek.Cua.Windows;

internal sealed record ApplicationAuthorization(string Id, string Name,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ExecutablePath, string IconPath)
{
    public bool Persistable => true;

    internal static string? AsAumid(string? value)
        => string.IsNullOrWhiteSpace(value) || Path.IsPathFullyQualified(value) ? null : value;

    internal static ApplicationAuthorization Create(string appId, string name, string? executablePath, string iconPath)
        => new(Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("windows-aumid\0" + appId))),
            name, executablePath, iconPath);
}
