// The alias list joins specified launchers and versions without absorbing adjacent programs.
using System.IO;
using DeepSeek.Cua.Windows;

internal static class KnownApplicationChecks
{
    internal static void Run(Action<bool, string> check)
    {
        foreach (var root in new[] { Path.GetFullPath("installed"), Path.GetFullPath("another-copy") })
        {
            foreach (var member in new[] { "Feishu.exe", "app/Feishu.exe", "8.7.16/Feishu.exe", "8.7.16.1/Feishu.exe" })
                Matches(root, "Feishu", member, "com.electron.Feishu");
            foreach (var member in new[] { "GitHubDesktop.exe", "app-3.4.12/GitHubDesktop.exe", "app-3.4.13/GitHubDesktop.exe" })
                Matches(root, "GitHubDesktop", member, "com.squirrel.GitHubDesktop.GitHubDesktop");
            Matches(root, "feishu", "APP/FEISHU.EXE", "com.electron.Feishu");
        }
        foreach (var relative in new[]
        {
            "Feishu/Update.exe", "Feishu/app/helper.exe", "Feishu/app/uninstall.exe",
            "Feishu/plugins/app/Feishu.exe", "Feishu/app-8.7.16/Feishu.exe", "Feishu/documents/Feishu.exe",
            "Feishu/8.7/Feishu.exe", "Feishu/8.7.16-extra/Feishu.exe", "Feishu/+8.7.16/Feishu.exe",
            "Feishu/ 8.7.16/Feishu.exe", "FeishuCopy/app/Feishu.exe",
            "GitHubDesktop/Update.exe", "GitHubDesktop/app/GitHubDesktop.exe", "GitHubDesktop/app-data/GitHubDesktop.exe",
            "GitHubDesktop/app-3.4.12/helper.exe", "GitHubDesktop/app-3.4.12/tools/GitHubDesktop.exe",
            "Slack/app-4.0.0/Slack.exe", "Other/Feishu.exe", "Feishu.exe",
        })
        {
            var path = Path.GetFullPath(relative.Replace('/', Path.DirectorySeparatorChar));
            check(KnownApplications.ResolvePath(path) == path, "Unlisted executable retains its path: " + relative);
        }

        void Matches(string root, string directory, string relative, string appId)
        {
            var path = Path.Combine(root, directory, relative.Replace('/', Path.DirectorySeparatorChar));
            check(KnownApplications.ResolvePath(path) == appId, "Known application alias: " + relative);
            check(ApplicationAuthorization.Create(KnownApplications.ResolvePath(path), "Executable", path).Id
                == ApplicationAuthorization.Create(appId, "Catalog entry", "shell:AppsFolder\\" + appId).Id,
                "Catalog and executable selectors share consent: " + relative);
        }
    }
}
