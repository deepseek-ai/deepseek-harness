// Application consent identifies the executable before any launch or UI observation.
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal sealed record ApplicationIdentity(string Id, string Name, string ExecutablePath, bool Persistable);
internal sealed record RunningApplication(int Pid, long Started, string Path, string Name);
internal sealed record InstalledApplication(string Name, string Path);

internal sealed class AppState(string handle, ApplicationIdentity authorization, string digest, RunningApplication? process) : IDisposable
{
    internal string Handle { get; } = handle;
    internal WindowState? SelectedWindow { get; set; }
    internal ApplicationIdentity Authorization { get; } = authorization;
    internal string Digest { get; } = digest;
    internal RunningApplication? Process { get; set; } = process;
    internal Dictionary<nint, WindowState> Windows { get; } = [];
    internal Dictionary<nint, Snapshot> Snapshots { get; } = [];
    private System.Diagnostics.Process? owner;
    internal RunningApplication RequireProcess()
    {
        var selected = Process ?? throw new NativeFailure("APP_ACCESS_REQUIRED", "Application launch requires Host authorization");
        try
        {
            owner ??= System.Diagnostics.Process.GetProcessById(selected.Pid);
            if (owner.HasExited || Applications.Started(owner) != selected.Started)
                throw new NativeFailure("STALE_APP", "Select the application again after its process changes");
        }
        catch (ArgumentException) { throw new NativeFailure("STALE_APP", "Select the application again after it exits"); }
        return selected;
    }
    public void Dispose() { owner?.Dispose(); Snapshots.Clear(); Windows.Clear(); }
}

internal static class Applications
{
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

    private static readonly int SessionId = CurrentSession();
    private static int CurrentSession() { using var process = System.Diagnostics.Process.GetCurrentProcess(); return process.SessionId; }
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

    internal static string Digest(string path)
    {
        using var file = File.OpenRead(path);
        return Convert.ToHexStringLower(SHA256.HashData(file));
    }

    private static string? VerifiedSigner(string path)
    {
        var file = new Win32.TrustFile { Size = (uint)Marshal.SizeOf<Win32.TrustFile>(), Path = path };
        var memory = Marshal.AllocHGlobal(Marshal.SizeOf<Win32.TrustFile>());
        Marshal.StructureToPtr(file, memory, false);
        var data = new Win32.TrustData
        {
            Size = (uint)Marshal.SizeOf<Win32.TrustData>(), UiChoice = 2, UnionChoice = 1,
            File = memory, StateAction = 1, ProviderFlags = 0x1000 | 0x80,
        };
        var action = new Guid("00AAC56B-CD44-11D0-8CC2-00C04FC295EE");
        try
        {
            if (Win32.WinVerifyTrust(0, ref action, ref data) != 0) return null;
            var provider = Win32.WTHelperProvDataFromStateData(data.StateData);
            var signerPointer = provider == 0 ? 0 : Win32.WTHelperGetProvSignerFromChain(provider, 0, false, 0);
            if (signerPointer == 0) return null;
            var signer = Marshal.PtrToStructure<Win32.ProviderSigner>(signerPointer);
            if (signer.CertificateCount == 0 || signer.Certificates == 0) return null;
            var certificate = Marshal.PtrToStructure<Win32.ProviderCertificate>(signer.Certificates);
            if (certificate.Certificate == 0) return null;
            var context = Marshal.PtrToStructure<Win32.CertificateContext>(certificate.Certificate);
            if (context.Encoded == 0 || context.EncodedSize == 0 || context.EncodedSize > int.MaxValue) return null;
            var bytes = new byte[(int)context.EncodedSize];
            Marshal.Copy(context.Encoded, bytes, 0, bytes.Length);
            return Convert.ToHexStringLower(SHA256.HashData(bytes));
        }
        catch (CryptographicException) { return null; }
        finally
        {
            data.StateAction = 2;
            Win32.WinVerifyTrust(0, ref action, ref data);
            Marshal.DestroyStructure<Win32.TrustFile>(memory);
            Marshal.FreeHGlobal(memory);
        }
    }

    internal static (ApplicationIdentity Identity, string Digest) Identify(string path, string name, RunningApplication? process)
    {
        var canonical = CanonicalPath(path);
        var digest = Digest(canonical);
        var signer = VerifiedSigner(canonical);
        var requirement = signer is not null ? "signed:" + signer
            : process is null ? "pending:" + digest : $"process:{process.Pid}:{process.Started}:{digest}";
        var id = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("win32\0" + canonical + "\0" + requirement)));
        return (new(id, name, canonical, signer is not null), digest);
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

    internal static IReadOnlyList<RunningApplication> List()
    {
        var ids = new HashSet<int>();
        Win32.EnumWindows((window, _) =>
        {
            if (Win32.IsWindowVisible(window))
            {
                Win32.GetWindowThreadProcessId(window, out var pid);
                if (pid != 0 && pid <= int.MaxValue) ids.Add((int)pid);
            }
            return true;
        }, 0);
        var result = new List<RunningApplication>();
        foreach (var pid in ids.Order())
        {
            try { result.Add(Running(pid)); }
            catch (NativeFailure) { /* Processes can exit or deny metadata while the desktop is enumerated. */ }
            catch (IOException) { /* A disappearing executable is not a selectable application. */ }
        }
        return result;
    }

    internal static IReadOnlyList<InstalledApplication> Find(string query, int maximum, bool exact = false)
    {
        var found = new Dictionary<string, InstalledApplication>(StringComparer.Ordinal);
        void Add(string name, string path)
        {
            if (exact ? !string.Equals(name, query, StringComparison.OrdinalIgnoreCase) && !string.Equals(Path.GetFileName(path), query, StringComparison.OrdinalIgnoreCase)
                : !name.Contains(query, StringComparison.OrdinalIgnoreCase) && !Path.GetFileName(path).Contains(query, StringComparison.OrdinalIgnoreCase)) return;
            if (!Path.IsPathFullyQualified(path) || !path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || !File.Exists(path)) return;
            found.TryAdd(CanonicalPath(path), new(name, CanonicalPath(path)));
            if (found.Count > maximum) throw new NativeFailure("TOO_MANY_APPS", "Use a more specific application name or executable path");
        }
        foreach (var app in List()) Add(app.Name, app.Path);
        foreach (var hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            using var registry = RegistryKey.OpenBaseKey(hive, view);
            using var paths = registry.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths");
            if (paths is null) continue;
            foreach (var key in paths.GetSubKeyNames())
            {
                using var app = paths.OpenSubKey(key);
                if (app?.GetValue(null) is string path) Add(Path.GetFileNameWithoutExtension(key), Environment.ExpandEnvironmentVariables(path.Trim('"')));
            }
        }
        foreach (var directory in new[] { Environment.SpecialFolder.Programs, Environment.SpecialFolder.CommonPrograms })
        {
            var root = Environment.GetFolderPath(directory);
            if (!Directory.Exists(root)) continue;
            foreach (var link in Directory.EnumerateFiles(root, "*.lnk", new EnumerationOptions
                     { RecurseSubdirectories = true, IgnoreInaccessible = true, AttributesToSkip = FileAttributes.ReparsePoint }))
            {
                var name = Path.GetFileNameWithoutExtension(link);
                if (!name.Contains(query, StringComparison.OrdinalIgnoreCase)) continue;
                var target = ShellBroker.ShortcutTarget(link);
                if (target is not null) Add(name, target);
            }
        }
        return found.Values.OrderBy(app => app.Name, StringComparer.OrdinalIgnoreCase).ToArray();
    }

    internal static AppState Select(string selector, IEnumerable<AppState> retained)
    {
        RunningApplication? running = null;
        string path, name;
        if (int.TryParse(selector, out var pid))
        {
            running = Running(pid); path = running.Path; name = running.Name;
        }
        else
        {
            var absolute = Path.IsPathFullyQualified(selector) ? CanonicalPath(selector) : null;
            var matches = List().Where(app => absolute is not null ? string.Equals(app.Path, absolute, StringComparison.Ordinal) : string.Equals(app.Name, selector, StringComparison.OrdinalIgnoreCase)
                || string.Equals(Path.GetFileName(app.Path), selector, StringComparison.OrdinalIgnoreCase)
                ).ToArray();
            if (matches.Length > 1) throw new NativeFailure("AMBIGUOUS_APP", "Select one of the observed process IDs");
            if (matches.Length == 1) { running = matches[0]; path = running.Path; name = running.Name; }
            else if (absolute is not null) { path = absolute; name = Path.GetFileNameWithoutExtension(path); }
            else
            {
                var installed = Find(selector, 1, true).Where(app => string.Equals(app.Name, selector, StringComparison.OrdinalIgnoreCase)
                    || string.Equals(Path.GetFileName(app.Path), selector, StringComparison.OrdinalIgnoreCase)).ToArray();
                if (installed.Length != 1) throw new NativeFailure(installed.Length == 0 ? "APP_NOT_FOUND" : "AMBIGUOUS_APP", "Use findApps, an executable path, or an observed PID");
                path = installed[0].Path; name = installed[0].Name;
            }
        }
        if (!path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) throw new NativeFailure("UNSUPPORTED", "Select a Windows application executable");
        if (running is not null)
        {
            var previous = retained.FirstOrDefault(app => app.Process?.Pid == running.Pid && app.Process.Started == running.Started);
            if (previous is not null) return previous;
        }
        var identity = Identify(path, name, running);
        return new(Guid.NewGuid().ToString("N"), identity.Identity, identity.Digest, running);
    }

    internal static async Task Launch(AppState app, RequestContext context)
    {
        if (app.Process is not null) { app.RequireProcess(); return; }
        var identity = app.Authorization;
        if (Digest(identity.ExecutablePath) != app.Digest) throw new NativeFailure("STALE_APP", "The selected executable changed before launch; select it again");
        context.Check();
        await context.Sta.Invoke(() => ShellBroker.Launch(identity.ExecutablePath), context.Cancellation);
        while (true)
        {
            context.Check();
            var matches = List().Where(candidate => string.Equals(candidate.Path, identity.ExecutablePath, StringComparison.Ordinal)).ToArray();
            if (matches.Length > 1) throw new NativeFailure("AMBIGUOUS_APP", "Several matching processes started; select an observed PID");
            if (matches.Length == 1)
            {
                if (Digest(matches[0].Path) != app.Digest) throw new NativeFailure("STALE_APP", "The launched executable differs from the approved file");
                app.Process = matches[0];
                return;
            }
            await Task.Delay(context.Config.PollIntervalMs, context.Cancellation);
        }
    }
}
