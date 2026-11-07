// Shell namespace enumeration and activation run on the existing STA dispatcher.
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using DeepSeek.Cua.Protocol;

namespace DeepSeek.Cua.Windows;

internal sealed record LaunchEntry(string Id, string DisplayName, string Kind, string? Path);
internal sealed class PreparedLaunch(LaunchEntry entry, ApplicationIdentity authorization, string? digest)
{
    internal string Handle { get; } = Guid.NewGuid().ToString("N");
    internal ApplicationIdentity Authorization { get; } = authorization;
    private bool dispatched;

    internal void Dispatch()
    {
        if (dispatched) throw new NativeFailure("LAUNCH_ALREADY_DISPATCHED", "Discover windows before deciding whether another launch is needed");
        if (entry.Kind == "executable")
        {
            if (Applications.CanonicalPath(entry.Id) != entry.Id || Applications.Digest(entry.Id) != digest)
                throw new NativeFailure("STALE_APP", "The approved executable changed; select it again");
        }
        else if (!LaunchEntries.All().Any(current => current.Id == entry.Id))
            throw new NativeFailure("STALE_APP", "The Shell entry disappeared; discover launch entries again");
        // Dispatch may succeed even if Explorer subsequently reports a failure. Never replay this selection.
        dispatched = true;
        ShellBroker.Launch(entry.Id, show: 1);
    }
}

internal static class LaunchEntries
{
    internal static LaunchEntry[] All()
    {
        var owned = new List<object>();
        object Own(object value) { owned.Add(value); return value; }
        try
        {
            dynamic shell = Own(Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("13709620-C279-11CE-A49E-444553540000"), true)!)!);
            dynamic folder = Own((object)shell.NameSpace("shell:AppsFolder"));
            dynamic items = Own((object)folder.Items());
            var result = new List<LaunchEntry>();
            for (var index = 0; index < (int)items.Count; index++)
            {
                dynamic item = Own((object)items.Item(index));
                string parsingName = item.Path;
                string name = item.Name;
                if (string.IsNullOrWhiteSpace(parsingName) || string.IsNullOrWhiteSpace(name)) continue;
                var target = parsingName.StartsWith("::", StringComparison.Ordinal) ? parsingName : "shell:AppsFolder\\" + parsingName;
                result.Add(new(target, name, "shell", null));
            }
            return result.DistinctBy(entry => entry.Id, StringComparer.OrdinalIgnoreCase).ToArray();
        }
        catch (Exception error) when (error is COMException or Microsoft.CSharp.RuntimeBinder.RuntimeBinderException)
        {
            throw new NativeFailure("APP_DISCOVERY_FAILED", "Windows Shell could not enumerate AppsFolder; retry discovery after Explorer is available");
        }
        finally
        {
            foreach (var item in owned.AsEnumerable().Reverse())
                if (Marshal.IsComObject(item)) Marshal.ReleaseComObject(item);
        }
    }

    internal static LaunchEntry[] Find(string query, int maximum)
    {
        var matches = All().Where(entry => entry.DisplayName.Contains(query, StringComparison.OrdinalIgnoreCase)
            || entry.Id.Contains(query, StringComparison.OrdinalIgnoreCase)).OrderBy(entry => entry.DisplayName, StringComparer.OrdinalIgnoreCase).ToArray();
        if (matches.Length > maximum) throw new NativeFailure("TOO_MANY_APPS", "Use a more specific launch entry name");
        return matches;
    }

    internal static PreparedLaunch Prepare(string target)
    {
        if (Path.IsPathFullyQualified(target) && target.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
        {
            var path = Applications.CanonicalPath(target);
            var name = Path.GetFileNameWithoutExtension(path);
            var identity = Applications.Identify(path, "Launch: " + name, null);
            return new(new(path, name, "executable", path), identity.Identity with { Persistable = false }, identity.Digest);
        }
        var shell = All().SingleOrDefault(entry => string.Equals(entry.Id, target, StringComparison.OrdinalIgnoreCase))
            ?? throw new NativeFailure("APP_NOT_FOUND", "Use an ID from findApps or a user-specified absolute executable path");
        var id = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("launch\0" + shell.Id)));
        return new(shell, new(id, "Launch: " + shell.DisplayName, shell.Id, false), null);
    }
}
