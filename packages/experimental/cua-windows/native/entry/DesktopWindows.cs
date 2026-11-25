// Shell and window AUMIDs identify applications across versions and copies.
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal sealed record ShellApplication(string AppId, string DisplayName, string? ExecutablePath);
internal sealed record ShellCatalog(ShellApplication[] Applications, int Omitted);
internal sealed record ResolvedWindow(nint Handle, string AppId, string ExecutablePath, string ProcessName,
    uint ProcessId, long Started);
internal sealed record WindowObservation(ResolvedWindow[] Windows, int Denied, int Gone);
internal sealed record CatalogApplication(string AppId, string DisplayName, string[] ExecutablePaths, bool IsRunning,
    string IconPath, string LaunchTarget);

internal static class DesktopWindows
{
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const int ErrorAccessDenied = 5;
    private const int ErrorInvalidParameter = 87;
    private const int ErrorInsufficientBuffer = 122;
    private const int AppModelErrorNoApplication = 15703;
    private const int EAccessDenied = unchecked((int)0x80070005);
    private const int EHandle = unchecked((int)0x80070006);
    private const int EInvalidArgument = unchecked((int)0x80070057);
    private const int EInvalidWindowHandle = unchecked((int)0x80070578);
    private const int MaximumIdentityBuffer = 1_048_576;
    private static readonly Guid AppUserModelIdFormat = new("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");

    internal static async Task<object[]> ListApps(RequestContext context)
    {
        context.Check();
        var applications = await Discover(context, includeWindowOnly: true);
        var result = applications.Where(application => application.IsRunning).Select(application => new
        {
            id = application.AppId, identity = (string?)null, name = application.DisplayName, isRunning = application.IsRunning,
        }).ToArray();
        context.Check();
        return result;
    }

    internal static async Task<object[]> FindApps(string? query, int maxAppMatches, RequestContext context)
    {
        context.Check();
        if (!string.IsNullOrEmpty(query) && string.IsNullOrWhiteSpace(query))
            throw new NativeFailure("INVALID_ARGUMENT", "Application query must contain non-whitespace characters");
        CatalogApplication[] matches;
        if (string.IsNullOrEmpty(query)) matches = await Discover(context, includeWindowOnly: false);
        else if (Path.IsPathFullyQualified(query))
        {
            var application = FindExecutable(query, await Discover(context, includeWindowOnly: true));
            matches = application is null ? [] : [application];
        }
        else matches = FindMatches(await Discover(context, includeWindowOnly: false), query, maxAppMatches, context.Cancellation);
        context.Check();
        return matches.Select(application => new
        {
            id = application.AppId, displayName = application.DisplayName, identity = (string?)null, isRunning = application.IsRunning,
        }).ToArray();
    }

    internal static CatalogApplication[] FindMatches(IEnumerable<CatalogApplication> applications, string query,
        int maxAppMatches, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        var matches = new List<CatalogApplication>();
        foreach (var application in applications)
        {
            cancellation.ThrowIfCancellationRequested();
            if (!application.DisplayName.Contains(query, StringComparison.OrdinalIgnoreCase)
                && !application.AppId.Contains(query, StringComparison.OrdinalIgnoreCase)
                && !application.ExecutablePaths.Any(path => path.Contains(query, StringComparison.OrdinalIgnoreCase))) continue;
            matches.Add(application);
            if (matches.Count > maxAppMatches)
                throw new NativeFailure("AMBIGUOUS_APP", "Too many matching applications; use a more specific name or path");
        }
        cancellation.ThrowIfCancellationRequested();
        return matches.ToArray();
    }

    internal static CatalogApplication? FindExecutable(string query, IReadOnlyList<CatalogApplication> applications)
    {
        string path;
        try { path = Applications.ResolveExecutable(query); }
        catch (NativeFailure error) when (error.Code is "APP_NOT_FOUND" or "INVALID_ARGUMENT") { return null; }
        var matches = applications.Where(app => app.ExecutablePaths.Contains(path, StringComparer.OrdinalIgnoreCase)).DistinctBy(app => app.AppId).ToArray();
        if (matches.Length > 1)
            throw new NativeFailure("AMBIGUOUS_APP", "This executable hosts multiple applications; use an exact id from listApps or findApps");
        return matches.SingleOrDefault() is { } match ? match with { LaunchTarget = path }
            : new(path, Applications.DisplayName(path), [path], false, path, path);
    }

    internal static async Task<AppState> Select(string selector, RequestContext context)
    {
        context.Check();
        var applications = await Discover(context, includeWindowOnly: true);
        var application = Path.IsPathFullyQualified(selector)
            ? FindExecutable(selector, applications) ?? throw new NativeFailure("APP_NOT_FOUND", "The selected executable does not exist")
            : SelectApplication(applications, selector);
        context.Check();
        return new AppState(Guid.NewGuid().ToString("N"), application.AppId, application.DisplayName,
            ApplicationAuthorization.Create(application.AppId, application.DisplayName, application.ExecutablePaths.FirstOrDefault(), application.IconPath),
            application.IsRunning, application.LaunchTarget);
    }

    private static async Task<CatalogApplication[]> Discover(RequestContext context, bool includeWindowOnly)
    {
        var catalog = await context.Sta.Invoke(_ => ReadAppsFolder(context), context.Cancellation);
        var observation = Observe(context);
        if (catalog.Omitted > 0)
            Console.Error.WriteLine($"NATIVE_DISCOVERY: omitted {catalog.Omitted} AppsFolder items without an application identity");
        ReportWindowOmissions(observation);
        var applications = Merge(catalog.Applications, observation.Windows, includeWindowOnly);
        context.Check();
        return applications;
    }

    private static void ReportWindowOmissions(WindowObservation observation)
    {
        if (observation.Denied > 0)
            Console.Error.WriteLine($"NATIVE_DISCOVERY: omitted {observation.Denied} windows whose process or window access was denied");
        if (observation.Gone > 0)
            Console.Error.WriteLine($"NATIVE_DISCOVERY: omitted {observation.Gone} disappeared or identity-less windows");
    }

    private static ShellCatalog ReadAppsFolder(RequestContext context)
    {
        var owned = new List<object>();
        object Own(object value) { owned.Add(value); return value; }
        try
        {
            dynamic shell = Own(Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("13709620-C279-11CE-A49E-444553540000"), true)!)!);
            dynamic folder = Own((object)shell.NameSpace("shell:AppsFolder"));
            if (folder is null) throw new COMException("AppsFolder is unavailable");
            dynamic items = Own((object)folder.Items());
            var applications = new List<ShellApplication>();
            var omitted = 0;
            for (var index = 0; index < (int)items.Count; index++)
            {
                context.Check();
                dynamic item = Own((object)items.Item(index));
                // A failed property read is a catalog failure; only an absent or non-string property is missing.
                object? property = item.ExtendedProperty("System.AppUserModel.ID");
                object? displayName = item.Name;
                string? aumid = property as string;
                string? name = displayName as string;
                if (string.IsNullOrWhiteSpace(aumid)) { omitted++; continue; }
                string? target = item.ExtendedProperty("System.Link.TargetParsingPath") as string;
                string? executable = null;
                if (!string.IsNullOrWhiteSpace(target) && Path.IsPathFullyQualified(target)
                    && string.Equals(Path.GetExtension(target), ".exe", StringComparison.OrdinalIgnoreCase))
                {
                    try { executable = Applications.ResolveExecutable(target); }
                    catch (NativeFailure error) when (error.Code is "APP_NOT_FOUND" or "PERMISSION_DENIED" or "APP_IDENTITY_UNAVAILABLE")
                    {
                        // The Shell AUMID still identifies entries without readable executable metadata.
                    }
                }
                applications.Add(new(aumid, string.IsNullOrWhiteSpace(name) ? aumid : name, executable));
            }
            return new(applications.ToArray(), omitted);
        }
        catch (Exception error) when (error is COMException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException)
        {
            throw new NativeFailure("APP_DISCOVERY_FAILED", "Windows Shell could not enumerate AppsFolder; retry discovery after Explorer is available");
        }
        finally
        {
            var released = new HashSet<object>(ReferenceEqualityComparer.Instance);
            foreach (var value in owned.AsEnumerable().Reverse())
                if (released.Add(value) && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value);
        }
    }

    private static CatalogApplication SelectApplication(IReadOnlyList<CatalogApplication> applications, string selector)
    {
        if (string.IsNullOrEmpty(selector))
            throw new NativeFailure("INVALID_ARGUMENT", "An exact application id from listApps or an absolute .exe file path is required");
        var exact = applications.FirstOrDefault(application => application.AppId == selector);
        if (exact is not null) return exact;
        throw new NativeFailure("APP_NOT_FOUND", "Use an exact application id from listApps or an existing absolute .exe file path");
    }

    private static CatalogApplication[] Merge(ShellApplication[] shellApplications, ResolvedWindow[] windows, bool includeWindowOnly)
    {
        var applications = new Dictionary<string, CatalogApplication>(StringComparer.Ordinal);
        foreach (var shell in shellApplications)
        {
            var matches = windows.Where(window => window.AppId == shell.AppId).ToArray();
            applications.TryAdd(shell.AppId, new(shell.AppId, shell.DisplayName,
                matches.Select(window => window.ExecutablePath).Concat(shell.ExecutablePath is { } path ? [path] : [])
                    .Distinct(StringComparer.OrdinalIgnoreCase).ToArray(), matches.Length != 0,
                @"shell:AppsFolder\" + shell.AppId, @"shell:AppsFolder\" + shell.AppId));
        }
        if (includeWindowOnly) foreach (var group in windows.GroupBy(window => window.AppId, StringComparer.Ordinal))
        {
            var window = group.First();
            applications.TryAdd(window.AppId, new(window.AppId, Applications.DisplayName(window.ExecutablePath),
                group.Select(item => item.ExecutablePath).Distinct(StringComparer.OrdinalIgnoreCase).ToArray(), true, window.ExecutablePath, window.ExecutablePath));
        }
        return applications.Values.OrderBy(application => application.AppId, StringComparer.Ordinal).ToArray();
    }

    // Supplied HWNDs already belong to the caller's application and need no process metadata lookup.
    internal static WindowObservation Observe(RequestContext context, IReadOnlySet<nint>? knownWindows = null)
    {
        var windows = new List<ResolvedWindow>();
        var denied = 0;
        var gone = 0;
        foreach (var handle in EnumerateHandles(context, knownWindows))
        {
            context.Check();
            try
            {
                var window = ResolveWindow(handle, context);
                if (window is null) gone++;
                else windows.Add(window);
            }
            catch (NativeFailure error) when (error.Code == "PERMISSION_DENIED") { denied++; }
            catch (NativeFailure error) when (error.Code is "APP_NOT_FOUND" or "STALE_APP") { gone++; }
        }
        return new(windows.ToArray(), denied, gone);
    }

    internal static bool Eligible(nint window)
    {
        // EnumWindows yields top-level windows; the explicit Resolve path also checks the root ancestor.
        if (Win32.GetAncestor(window, 2) != window) return false;
        var extended = Win32.GetWindowLongPtr(window, -20).ToInt64();
        if ((extended & 0x80) != 0) return false;
        if (!Win32.IsWindowVisible(window)) return false;
        if (!Win32.GetWindowRect(window, out var bounds) || bounds.Width <= 0 || bounds.Height <= 0) return false;
        Win32.GetWindowThreadProcessId(window, out var processId);
        if (processId == 0 || processId > int.MaxValue) return false;
        return Win32.ProcessIdToSessionId(processId, out var session) && session == Applications.SessionId;
    }

    private static IReadOnlyList<nint> EnumerateHandles(RequestContext context, IReadOnlySet<nint>? knownWindows)
    {
        var handles = new List<nint>();
        var enumerated = Win32.EnumWindows((window, _) =>
        {
            // Cancellation cannot throw across the unmanaged callback; stop, then rethrow outside it.
            if (context.Cancellation.IsCancellationRequested) return false;
            if (knownWindows?.Contains(window) == true) return true;
            if (Eligible(window)) handles.Add(window);
            return true;
        }, 0);
        context.Check();
        if (!enumerated) throw new NativeFailure("APP_DISCOVERY_FAILED", "Windows could not enumerate top-level windows; retry discovery after the desktop is available");
        return handles;
    }

    internal static ResolvedWindow? ResolveWindow(nint handle, RequestContext context)
    {
        context.Check();
        Win32.GetWindowThreadProcessId(handle, out var rawProcessId);
        if (rawProcessId == 0 || rawProcessId > int.MaxValue) return null;
        var processId = (int)rawProcessId;
        if (!Win32.ProcessIdToSessionId(rawProcessId, out var session) || session != Applications.SessionId) return null;
        var process = Win32.OpenProcess(ProcessQueryLimitedInformation, false, rawProcessId);
        if (process == 0) return OpenFailure();
        try
        {
            var processName = ReadProcessName(processId);
            if (string.IsNullOrEmpty(processName)) return null;
            context.Check();
            var appId = ApplicationAuthorization.AsAumid(ReadWindowAumid(handle, context))
                ?? ApplicationAuthorization.AsAumid(ReadProcessAumid(process, context))
                ?? ApplicationAuthorization.AsAumid(context.Sta.InvokeSync(_ => ApplicationResolver.ForWindow(handle), context.Cancellation));
            var image = ReadExecutablePath(process, context);
            if (image is null) return null;
            var executablePath = Applications.CanonicalPath(image);
            if (!Win32.GetProcessTimes(process, out var started, out _, out _, out _)) throw Unavailable();
            Win32.GetWindowThreadProcessId(handle, out var currentOwner);
            if (currentOwner != rawProcessId) return null;
            context.Check();
            return new(handle, appId ?? executablePath, executablePath, processName, rawProcessId, started);
        }
        finally { Win32.CloseHandle(process); }
    }

    private static ResolvedWindow? OpenFailure() => Marshal.GetLastPInvokeError() switch
    {
        ErrorAccessDenied => throw PermissionDenied(),
        ErrorInvalidParameter => null,
        _ => throw Unavailable(),
    };

    private static string? ReadProcessName(int processId)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            return process.ProcessName;
        }
        catch (ArgumentException) { return null; }
        catch (InvalidOperationException) { return null; }
        catch (Win32Exception error) when (error.NativeErrorCode == ErrorAccessDenied) { throw PermissionDenied(); }
        catch (Win32Exception) { throw Unavailable(); }
    }

    private static string? ReadWindowAumid(nint handle, RequestContext context)
    {
        context.Check();
        var read = context.Sta.InvokeSync(_ => ReadWindowAumidCore(handle, context), context.Cancellation);
        context.Check();
        return read;
    }

    private static string? ReadWindowAumidCore(nint handle, RequestContext context)
    {
        var id = typeof(Win32.IPropertyStore).GUID;
        var status = Win32.SHGetPropertyStoreForWindow(handle, ref id, out var store);
        if (status != 0)
        {
            if (status == EAccessDenied) throw PermissionDenied();
            if (status is EHandle or EInvalidArgument or EInvalidWindowHandle) return null;
            throw Unavailable();
        }
        if (store is null) throw Unavailable();
        try
        {
            var key = new Win32.PropertyKey { FormatId = AppUserModelIdFormat, PropertyId = 5 };
            var value = default(Win32.PropVariant);
            var result = store.GetValue(ref key, out value);
            try
            {
                if (result != 0)
                {
                    if (result == EAccessDenied) throw PermissionDenied();
                    throw Unavailable();
                }
                context.Check();
                if (value.ValueType == 0) return null;
                if (value.ValueType == 31) return value.Pointer == 0 ? null : Marshal.PtrToStringUni(value.Pointer);
                if (value.ValueType == 8) return value.Pointer == 0 ? null : Marshal.PtrToStringBSTR(value.Pointer);
                throw Unavailable();
            }
            finally { Win32.PropVariantClear(ref value); }
        }
        finally { Marshal.FinalReleaseComObject(store); }
    }

    private static string? ReadProcessAumid(nint process, RequestContext context)
    {
        context.Check();
        uint length = 0;
        var status = Win32.GetApplicationUserModelId(process, ref length, null);
        if (status == 0) throw Unavailable();
        if (status != ErrorInsufficientBuffer) return ClassifyAumidStatus(status);
        for (var attempt = 0; attempt < 4; attempt++)
        {
            context.Check();
            if (length == 0 || length > MaximumIdentityBuffer) throw Unavailable();
            var buffer = new StringBuilder(checked((int)length));
            uint size = length;
            status = Win32.GetApplicationUserModelId(process, ref size, buffer);
            if (status == 0)
            {
                var value = buffer.ToString();
                if (string.IsNullOrEmpty(value)) throw Unavailable();
                return value;
            }
            if (status != ErrorInsufficientBuffer) return ClassifyAumidStatus(status);
            length = size;
        }
        throw Unavailable();
    }

    private static string? ClassifyAumidStatus(int status)
    {
        if (status == AppModelErrorNoApplication) return null;
        if (status == ErrorAccessDenied) throw PermissionDenied();
        throw Unavailable();
    }

    private static string? ReadExecutablePath(nint process, RequestContext context)
    {
        for (var capacity = 1024; capacity <= 65536; capacity *= 2)
        {
            context.Check();
            var buffer = new StringBuilder(capacity);
            uint size = (uint)capacity;
            if (Win32.QueryFullProcessImageName(process, 0, buffer, ref size))
            {
                context.Check();
                var path = buffer.ToString(0, (int)Math.Min(size, (uint)buffer.Length));
                if (path.Length == 0) throw Unavailable();
                return path;
            }
            var error = Marshal.GetLastPInvokeError();
            if (error == ErrorInsufficientBuffer) continue;
            if (error == ErrorAccessDenied) throw PermissionDenied();
            if (error == ErrorInvalidParameter) return null;
            throw Unavailable();
        }
        throw Unavailable();
    }

    private static NativeFailure PermissionDenied()
        => new("PERMISSION_DENIED", "Windows refused the window application identity; its privilege level may exceed the helper's");

    private static NativeFailure Unavailable()
        => new("APP_IDENTITY_UNAVAILABLE", "The window application identity could not be resolved; retry after its owner is available");
}
