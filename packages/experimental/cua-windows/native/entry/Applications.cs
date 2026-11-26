// Executable metadata, helper verification, and the selected application's window state.
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal sealed class AppState(string handle, string appId, string name, ApplicationAuthorization authorization,
    bool isRunning, string launchTarget) : IDisposable
{
    internal string Handle { get; } = handle;
    internal string AppId { get; } = appId;
    internal string LaunchTarget { get; } = launchTarget;
    internal string Name { get; } = name;
    internal bool IsRunning { get; } = isRunning;
    internal ApplicationAuthorization Authorization { get; } = authorization;
    internal Dictionary<nint, WindowState> Windows { get; } = [];
    internal Dictionary<nint, Snapshot> Snapshots { get; } = [];

    public void Dispose()
    {
        Snapshots.Clear();
        Windows.Clear();
    }
}

internal static class Applications
{
    internal static int SessionId { get; } = CurrentSession();
    private static int CurrentSession() { using var process = System.Diagnostics.Process.GetCurrentProcess(); return process.SessionId; }

    internal static object Icons(JsonElement parameters, RequestContext context)
    {
        var paths = parameters.GetProperty("paths");
        if (paths.ValueKind != JsonValueKind.Array)
            throw new NativeFailure("INVALID_ARGUMENT", "paths must be an array");
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var element in paths.EnumerateArray())
        {
            context.Check();
            if (element.ValueKind != JsonValueKind.String || string.IsNullOrEmpty(element.GetString()))
                throw new NativeFailure("INVALID_ARGUMENT", "paths must contain nonempty strings");
            var path = element.GetString()!;
            if (ApplicationIcons.Read(path) is { } icon) result[path] = icon;
        }
        return result;
    }

    internal static string CanonicalPath(string path)
    {
        using var handle = File.OpenHandle(path, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
        var capacity = Win32.GetFinalPathNameByHandle(handle, new StringBuilder(), 0, 0);
        if (capacity == 0) throw new NativeFailure("APP_IDENTITY_UNAVAILABLE", "The executable path could not be resolved");
        var text = new StringBuilder(checked((int)capacity + 1));
        if (Win32.GetFinalPathNameByHandle(handle, text, (uint)text.Capacity, 0) == 0)
            throw new NativeFailure("APP_IDENTITY_UNAVAILABLE", "The executable path changed during selection");
        var resolved = text.ToString();
        return resolved.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)
            ? @"\\" + resolved[8..] : resolved.StartsWith(@"\\?\", StringComparison.Ordinal) ? resolved[4..] : resolved;
    }

    internal static string ResolveExecutable(string path)
    {
        try
        {
            if (!Path.IsPathFullyQualified(path) || path.StartsWith(@"\\.\", StringComparison.Ordinal)
                || path.StartsWith(@"\\?\", StringComparison.Ordinal)
                || !string.Equals(Path.GetExtension(path), ".exe", StringComparison.OrdinalIgnoreCase))
                throw new NativeFailure("INVALID_ARGUMENT", "Use an absolute .exe file path, not a command line or device path");
            if ((File.GetAttributes(path) & FileAttributes.Directory) != 0)
                throw new NativeFailure("INVALID_ARGUMENT", "The selected executable path is a directory");
            var resolved = CanonicalPath(path);
            if (!string.Equals(Path.GetExtension(resolved), ".exe", StringComparison.OrdinalIgnoreCase))
                throw new NativeFailure("INVALID_ARGUMENT", "The selected path must resolve to an .exe file");
            return resolved;
        }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        {
            throw new NativeFailure("APP_NOT_FOUND", "The selected executable does not exist; provide an existing absolute .exe path");
        }
        catch (UnauthorizedAccessException)
        {
            throw new NativeFailure("PERMISSION_DENIED", "Windows refused access to the selected executable");
        }
        catch (Exception error) when (error is ArgumentException or NotSupportedException)
        {
            throw new NativeFailure("INVALID_ARGUMENT", "The executable path is invalid; provide an absolute .exe file path");
        }
        catch (IOException)
        {
            throw new NativeFailure("APP_IDENTITY_UNAVAILABLE", "The selected executable could not be read; check the file before selecting it again");
        }
    }

    internal static string DisplayName(string path)
    {
        try
        {
            var product = FileVersionInfo.GetVersionInfo(path).ProductName;
            if (!string.IsNullOrWhiteSpace(product)) return product;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception)
        {
            // File metadata is optional; the file name still labels the selected executable.
        }
        return Path.GetFileNameWithoutExtension(path);
    }

    internal static string Digest(string path)
    {
        using var file = File.OpenRead(path);
        return Convert.ToHexStringLower(SHA256.HashData(file));
    }

    internal static string RunningExecutable(int pid)
    {
        try
        {
            using var process = System.Diagnostics.Process.GetProcessById(pid);
            if (process.SessionId != SessionId)
                throw new NativeFailure("UNSUPPORTED_SESSION", "Select an application in this interactive desktop session");
            var path = process.MainModule?.FileName
                ?? throw new NativeFailure("APP_IDENTITY_UNAVAILABLE", "The application executable is unavailable");
            return CanonicalPath(path);
        }
        catch (System.ComponentModel.Win32Exception)
        {
            throw new NativeFailure("PERMISSION_DENIED", "Windows refused the application identity; its privilege level may exceed the helper's");
        }
        catch (ArgumentException) { throw new NativeFailure("STALE_APP", "The selected process has exited"); }
    }
}
