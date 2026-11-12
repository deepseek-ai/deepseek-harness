// Process identity, executable metadata, and the authorized application's own window state.
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal sealed record RunningApplication(int Pid, long Started, string Path, string Name);

internal sealed record ApplicationAuthorization(string Id, string Name,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ExecutablePath)
{
    /// <summary>Not eligible for a permanent grant; the Host still persists conversation grants and denials.</summary>
    public bool Persistable => false;

    internal static ApplicationAuthorization Create(string appId, string name, string? executablePath)
        => new(Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("windows-aumid\0" + appId))), name, executablePath);
}

internal sealed class AppState(string handle, string appId, string name, ApplicationAuthorization authorization,
    bool isRunning) : IDisposable
{
    internal string Handle { get; } = handle;
    internal string AppId { get; } = appId;
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
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var element in paths.EnumerateArray())
        {
            context.Check();
            if (element.ValueKind != JsonValueKind.String || string.IsNullOrEmpty(element.GetString()))
                throw new NativeFailure("INVALID_ARGUMENT", "paths must contain nonempty strings");
            var path = element.GetString()!;
            try
            {
                using var icon = System.Drawing.Icon.ExtractAssociatedIcon(path);
                if (icon is null) continue;
                using var original = icon.ToBitmap();
                using var bitmap = new System.Drawing.Bitmap(original, new System.Drawing.Size(64, 64));
                using var stream = new MemoryStream();
                bitmap.Save(stream, System.Drawing.Imaging.ImageFormat.Png);
                result[path] = "data:image/png;base64," + Convert.ToBase64String(stream.ToArray());
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException
                or System.ComponentModel.Win32Exception)
            {
                // Missing or unreadable executable metadata has no icon; application access is unchanged.
            }
        }
        return result;
    }

    internal static long Started(System.Diagnostics.Process process)
    {
        if (!Win32.GetProcessTimes(process.SafeHandle, out var created, out _, out _, out _))
            throw new NativeFailure("STALE_APP", "The process lifetime is unavailable; select the application again");
        return created;
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

    internal static string Digest(string path)
    {
        using var file = File.OpenRead(path);
        return Convert.ToHexStringLower(SHA256.HashData(file));
    }

    internal static RunningApplication Running(int pid)
    {
        try
        {
            using var process = System.Diagnostics.Process.GetProcessById(pid);
            if (process.SessionId != SessionId)
                throw new NativeFailure("UNSUPPORTED_SESSION", "Select an application in this interactive desktop session");
            var path = process.MainModule?.FileName
                ?? throw new NativeFailure("APP_IDENTITY_UNAVAILABLE", "The application executable is unavailable");
            return new(pid, Started(process), CanonicalPath(path), process.ProcessName);
        }
        catch (System.ComponentModel.Win32Exception)
        {
            throw new NativeFailure("PERMISSION_DENIED", "Windows refused the application identity; its privilege level may exceed the helper's");
        }
        catch (ArgumentException) { throw new NativeFailure("STALE_APP", "The selected process has exited"); }
    }
}
