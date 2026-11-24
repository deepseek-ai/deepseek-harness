// Shell labels locate applications; only package identity or an exact image path grants access.
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;

namespace DeepSeek.Cua.Windows;

internal sealed record ApplicationIdentity(string? PackageAppId, string? ExecutablePath, string? DesktopAppId)
{
    internal string Id => Digest(PackageAppId is { } packaged
        ? "windows-package-v2\0" + packaged
        : "windows-executable-v2\0" + ExecutablePath + "\0" + DesktopAppId);

    internal static string Digest(string value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    // Paths are resolved through a file handle. Preserve case-sensitive Windows directories.
    internal static ApplicationIdentity Desktop(string path, string? appId) => new(null, path, appId);
    internal static ApplicationIdentity Package(string appId, string? path) => new(appId, path, null);
    internal bool Matches(ApplicationIdentity other) => Id == other.Id;
}

internal sealed record ApplicationAuthorization(string Id, string Name,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ExecutablePath,
    string IconPath, string[] Supersedes)
{
    public bool Persistable => true;

    // A declared AUMID cannot be an executable identity; the selected file path and process image supply it.
    internal static string? AsAumid(string? value)
        => string.IsNullOrWhiteSpace(value) || Path.IsPathFullyQualified(value) ? null : value;

    internal static ApplicationAuthorization Create(ApplicationIdentity identity, string appId, string name, string iconPath)
        => new(identity.Id, name, identity.ExecutablePath, iconPath,
            new[] { appId, identity.ExecutablePath }.OfType<string>().Distinct(StringComparer.Ordinal)
                .Select(value => ApplicationIdentity.Digest("windows-aumid\0" + value)).ToArray());
}
