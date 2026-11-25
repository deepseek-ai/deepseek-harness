// Explicit executable aliases for documented launcher layouts; other paths keep their own identity.
using System.IO;

namespace DeepSeek.Cua.Windows;

internal static class KnownApplications
{
    private sealed record Application(string Directory, string AppId, string VersionPrefix, string? CurrentDirectory = null);

    private static readonly Application[] Applications =
    [
        new("Feishu", "com.electron.Feishu", "", "app"),
        new("GitHubDesktop", "com.squirrel.GitHubDesktop.GitHubDesktop", "app-"),
    ];

    internal static string ResolvePath(string path)
    {
        var directory = Path.GetDirectoryName(path);
        if (directory is null) return path;
        foreach (var application in Applications)
        {
            if (!string.Equals(Path.GetFileName(path), application.Directory + ".exe", StringComparison.OrdinalIgnoreCase)) continue;
            var child = Path.GetFileName(directory);
            if (string.Equals(child, application.Directory, StringComparison.OrdinalIgnoreCase)) return application.AppId;
            if (!string.Equals(Path.GetFileName(Path.GetDirectoryName(directory)), application.Directory, StringComparison.OrdinalIgnoreCase)) continue;
            if (application.CurrentDirectory is { } current && string.Equals(child, current, StringComparison.OrdinalIgnoreCase))
                return application.AppId;
            if (!child.StartsWith(application.VersionPrefix, StringComparison.OrdinalIgnoreCase)) continue;
            var versionText = child[application.VersionPrefix.Length..];
            if (versionText.All(character => char.IsAsciiDigit(character) || character == '.')
                && Version.TryParse(versionText, out var version) && version.Build >= 0)
                return application.AppId;
        }
        return path;
    }
}
