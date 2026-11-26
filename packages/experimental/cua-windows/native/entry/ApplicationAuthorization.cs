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
        var isPath = Path.IsPathFullyQualified(appId);
        var ids = (aumids ?? []).Append(isPath ? null : appId)
            .Where(value => !string.IsNullOrWhiteSpace(value)).Select(value => value!).Distinct(StringComparer.Ordinal).ToArray();
        var paths = (executablePaths ?? []).Append(isPath ? appId : null)
            .Where(value => !string.IsNullOrWhiteSpace(value)).Select(value => value!.ToUpperInvariant()).Distinct(StringComparer.Ordinal).ToArray();
        var attributes = new Dictionary<string, string[]>();
        if (ids.Length != 0) attributes.Add("windows.aumid", ids);
        if (paths.Length != 0) attributes.Add("windows.executablePath", paths);
        return new(Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("windows-aumid\0" + appId))),
            name, iconPath, attributes);
    }
}
