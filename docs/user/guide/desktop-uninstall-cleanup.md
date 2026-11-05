# Uninstall DSH Desktop

English | [中文](desktop-uninstall-cleanup.zh.md)

Use this guide to uninstall DeepSeek Harness Desktop on macOS or Windows. Local data cleanup is optional.

## 1. Uninstall the app

Finish any commands using Desktop's bundled CLI. If you installed the `dsh` command through Desktop, first select **Manage dsh Command… → Remove** in the application menu. This removes Desktop's command registration without uninstalling independent CLI programs.

Quit DeepSeek Harness, then uninstall it using your platform's procedure:

- **macOS:** Delete the app from Applications in Finder.
- **Windows:** Uninstall it through Settings → Apps → Installed apps on Windows 11, or Control Panel → Programs → Programs and Features.

## 2. Clean up local data

This step is optional. If you want to clean up local data, select the script for your platform below, then paste and run it in Terminal on macOS or PowerShell on Windows.

The scripts permanently delete the current user's default Harness home and the Desktop data paths listed below, including sessions, credentials, settings, plugins, caches, and shared CLI state. If you configured `DSH_HOME`, inspect that directory separately before deleting it; the scripts still delete the default `~/.dsh`. Isolated development and test data directories are outside this cleanup scope.

On Windows, the uninstaller normally removes the two application-data directories listed in the script but retains the Harness home. The script also handles those directories if uninstallation left files behind or retained app data.

::: code-group

```sh [macOS]
sh -c '
rm -rf -- \
  "$HOME/.dsh" \
  "$HOME/Library/Application Support/@deepseek-ai/dsh-desktop" \
  "$HOME/Library/Logs/DeepSeek Harness" \
  "$HOME/Library/Preferences/com.deepseek.dsh.plist" \
  "$HOME/Library/Preferences/ByHost"/com.deepseek.dsh.ShipIt.*.plist \
  "$HOME/Library/Caches/com.deepseek.dsh" \
  "$HOME/Library/Caches/com.deepseek.dsh.ShipIt" \
  "$HOME/Library/HTTPStorages/com.deepseek.dsh" \
  "$HOME/Library/Caches/@deepseek-aidsh-desktop-updater" \
  "$(getconf DARWIN_USER_CACHE_DIR)/com.deepseek.dsh" \
  "$(getconf DARWIN_USER_CACHE_DIR)/com.deepseek.dsh.helper"
'
```

```powershell [Windows]
$ErrorActionPreference = 'Stop'
@(
    (Join-Path $env:USERPROFILE '.dsh'),
    (Join-Path $env:APPDATA '@deepseek-ai\dsh-desktop'),
    (Join-Path $env:LOCALAPPDATA '@deepseek-aidsh-desktop-updater')
) | ForEach-Object {
    if (Test-Path -LiteralPath $_) {
        Remove-Item -LiteralPath $_ -Recurse -Force
    }
}
```

:::

## 3. Verify cleanup

If you ran a cleanup script, confirm before reinstalling that the paths listed in it no longer exist. If the script reports an error, resolve it, rerun the script, and check all listed paths again. The Windows script stops at the first error, so later paths may remain.
