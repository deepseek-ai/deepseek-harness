// AppsFolder AUMID enumeration, exact-ordinal merge, and exact window identity resolution.
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using DeepSeek.Cua.Protocol;
using Microsoft.Win32.SafeHandles;

namespace DeepSeek.Cua.Windows;

internal sealed record ShellApplication(string AppId, string DisplayName, bool HasShellName);
internal sealed record ShellCatalog(ShellApplication[] Applications, int Omitted);
internal sealed record ResolvedWindow(nint Handle, string AppId, string? ExecutablePath, string ProcessName,
    int ProcessId, long ProcessStarted);
internal sealed record WindowObservation(ResolvedWindow[] Windows, int Denied, int Gone);
internal sealed record CatalogApplication(string AppId, string DisplayName, string? ExecutablePath, bool IsRunning);

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
        var applications = await Discover(context);
        var result = applications.Select(application => new
        {
            pid = 4, id = application.AppId, name = application.DisplayName, isRunning = application.IsRunning,
        }).ToArray();
        context.Check();
        return result;
    }

    internal static async Task<AppState> Select(string selector, RequestContext context)
    {
        var applications = await Discover(context);
        var application = SelectApplication(applications, selector);
        context.Check();
        return new AppState(Guid.NewGuid().ToString("N"), application.AppId, application.DisplayName,
            ApplicationAuthorization.Create(application.AppId, application.DisplayName, application.ExecutablePath),
            application.IsRunning);
    }

    private static async Task<CatalogApplication[]> Discover(RequestContext context)
    {
        var catalog = await context.Sta.Invoke(_ => ReadAppsFolder(context), context.Cancellation);
        var observation = Observe(context);
        if (catalog.Omitted > 0)
            Console.Error.WriteLine($"NATIVE_DISCOVERY: omitted {catalog.Omitted} AppsFolder items without an application identity");
        if (observation.Denied > 0)
            Console.Error.WriteLine($"NATIVE_DISCOVERY: omitted {observation.Denied} windows whose process or window access was denied");
        if (observation.Gone > 0)
            Console.Error.WriteLine($"NATIVE_DISCOVERY: omitted {observation.Gone} disappeared or identity-less windows");
        var applications = Merge(catalog.Applications, observation.Windows);
        context.Check();
        return applications;
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
                var hasName = !string.IsNullOrWhiteSpace(name);
                applications.Add(new(aumid, hasName ? name! : aumid, hasName));
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
            throw new NativeFailure("INVALID_ARGUMENT", "An exact application id from listApps is required");
        foreach (var application in applications)
            if (string.Equals(application.AppId, selector, StringComparison.Ordinal)) return application;
        throw new NativeFailure("APP_NOT_FOUND", "Use an exact application id from listApps");
    }

    private static CatalogApplication[] Merge(ShellApplication[] shellApplications, ResolvedWindow[] windows)
    {
        var applications = new Dictionary<string, Builder>(StringComparer.Ordinal);
        foreach (var shell in shellApplications)
        {
            if (string.IsNullOrEmpty(shell.AppId)) continue;
            if (!applications.TryGetValue(shell.AppId, out var existing))
                applications.Add(shell.AppId, new(shell.AppId, shell.DisplayName, shell.HasShellName, shellNamed: true));
            else existing.PreferShellName(shell.DisplayName, shell.HasShellName);
        }
        foreach (var window in windows.OrderBy(window => window.AppId, StringComparer.Ordinal)
                     .ThenBy(window => (long)window.Handle))
        {
            if (string.IsNullOrEmpty(window.AppId) || string.IsNullOrEmpty(window.ProcessName)) continue;
            if (!applications.TryGetValue(window.AppId, out var builder))
            {
                builder = new(window.AppId, window.ProcessName, hasShellName: false, shellNamed: false);
                applications.Add(window.AppId, builder);
            }
            builder.Add(window);
        }
        return applications.Values.Select(builder => builder.Build())
            .OrderBy(application => application.AppId, StringComparer.Ordinal).ToArray();
    }

    private sealed class Builder(string appId, string displayName, bool hasShellName, bool shellNamed)
    {
        private readonly HashSet<string> executablePaths = new(StringComparer.Ordinal);
        private readonly HashSet<string> processNames = new(StringComparer.Ordinal);
        private string shellDisplayName = displayName;
        private bool shellNameProvided = hasShellName;

        internal void PreferShellName(string candidate, bool provided)
        {
            if (provided && !shellNameProvided) { shellDisplayName = candidate; shellNameProvided = true; }
            else if (provided == shellNameProvided && string.CompareOrdinal(candidate, shellDisplayName) < 0)
                shellDisplayName = candidate;
        }

        internal void Add(ResolvedWindow window)
        {
            if (!string.IsNullOrEmpty(window.ExecutablePath)) executablePaths.Add(window.ExecutablePath);
            processNames.Add(window.ProcessName);
        }

        internal CatalogApplication Build()
        {
            var name = shellNamed ? shellDisplayName
                : processNames.Count == 0 ? shellDisplayName : processNames.Min(StringComparer.Ordinal)!;
            var executablePath = executablePaths.Count == 1 ? executablePaths.First() : null;
            return new(appId, name, executablePath, processNames.Count != 0);
        }
    }

    internal static WindowObservation Observe(RequestContext context)
    {
        var windows = new List<ResolvedWindow>();
        var denied = 0;
        var gone = 0;
        foreach (var handle in EnumerateHandles(context))
        {
            context.Check();
            try
            {
                var window = ResolveWindow(handle, context);
                if (window is null) gone++;
                else windows.Add(window);
            }
            catch (NativeFailure error) when (error.Code == "PERMISSION_DENIED") { denied++; }
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

    private static IReadOnlyList<nint> EnumerateHandles(RequestContext context)
    {
        var handles = new List<nint>();
        var enumerated = Win32.EnumWindows((window, _) =>
        {
            // Cancellation cannot throw across the unmanaged callback; stop, then rethrow outside it.
            if (context.Cancellation.IsCancellationRequested) return false;
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
            using var native = new SafeProcessHandle(process, ownsHandle: false);
            if (!Win32.GetProcessTimes(native, out var started, out _, out _, out _)) return null;
            var processName = ReadProcessName(processId);
            if (string.IsNullOrEmpty(processName)) return null;
            context.Check();
            var windowAumid = ReadWindowAumid(handle, context);
            string? executablePath = null;
            string? appId = null;
            if (!string.IsNullOrEmpty(windowAumid)) appId = windowAumid;
            else
            {
                appId = ReadProcessAumid(process, context);
                if (string.IsNullOrEmpty(appId)) executablePath = ReadExecutablePath(process, context);
                appId ??= executablePath;
            }
            if (appId is null) return null;
            // A recycled handle must not inherit the identity resolved for its former process.
            Win32.GetWindowThreadProcessId(handle, out var currentProcessId);
            if (currentProcessId != rawProcessId) return null;
            using var current = new SafeProcessHandle(process, ownsHandle: false);
            if (!Win32.GetProcessTimes(current, out var currentStarted, out _, out _, out _) || currentStarted != started) return null;
            context.Check();
            return new(handle, appId, executablePath, processName, processId, started);
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
