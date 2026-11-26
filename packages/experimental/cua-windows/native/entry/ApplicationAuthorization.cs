// Additional attributes are used only by Host consent matching, never by native window association.
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace DeepSeek.Cua.Windows;

internal sealed record ApplicationAuthorization(string Id, string Name, string IconPath, Dictionary<string, string[]> Attributes)
{
    public bool Persistable => true;

    internal static ApplicationAuthorization Create(string appId, string name, string iconPath,
        IEnumerable<string?>? aumids = null, IEnumerable<string?>? executablePaths = null)
    {
        var ids = new List<string>();
        var paths = new List<string>();
        if (Path.IsPathFullyQualified(appId)) AddPath(paths, appId);
        else AddId(ids, appId);
        if (aumids is not null) foreach (var aumid in aumids) AddId(ids, aumid);
        if (executablePaths is not null) foreach (var path in executablePaths) AddPath(paths, path);
        var attributes = new Dictionary<string, string[]>();
        if (ids.Count != 0) attributes.Add("windows.aumid", ids.ToArray());
        if (paths.Count != 0) attributes.Add("windows.executablePath", paths.ToArray());
        return new(Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("windows-aumid\0" + appId))),
            name, iconPath, attributes);
    }

    // List<string>.Contains uses ordinal equality: AUMIDs stay case-sensitive; paths compare by their upper-case form.
    private static void AddId(List<string> ids, string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        if (ids.Contains(value)) return;
        ids.Add(value);
    }

    private static void AddPath(List<string> paths, string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        var normalized = value.ToUpperInvariant();
        if (paths.Contains(normalized)) return;
        paths.Add(normalized);
    }
}
