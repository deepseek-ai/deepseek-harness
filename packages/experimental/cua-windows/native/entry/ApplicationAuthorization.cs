// Consent follows the selected application ID; presentation metadata does not distinguish grants.
using System.Security.Cryptography;
using System.Text;

namespace DeepSeek.Cua.Windows;

internal sealed record ApplicationAuthorization(string Id, string Name, string IconPath)
{
    public bool Persistable => true;

    internal static ApplicationAuthorization Create(string appId, string name, string iconPath)
        => new(Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("windows-aumid\0" + appId))),
            name, iconPath);
}
