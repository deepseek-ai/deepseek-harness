# 卸载 DSH 桌面端

[English](desktop-uninstall-cleanup.md) | 中文

本指南介绍如何在 macOS 或 Windows 上卸载 DeepSeek Harness 桌面端。清理本地数据是可选操作。

## 1. 卸载应用

先结束使用桌面端内置 CLI（命令行界面）的命令。如果曾通过 Desktop 安装 `dsh` 命令，请先在应用菜单中选择 **管理 dsh 命令… → 移除**。此操作移除桌面端的命令注册，不卸载独立安装的 CLI 程序。

退出 DeepSeek Harness，然后按所在平台的方式卸载：

- **macOS：** 在 Finder 的“应用程序”中删除应用。
- **Windows：** 在 Windows 11 的“设置 → 应用 → 已安装的应用”，或“控制面板 → 程序 → 程序和功能”中卸载。

## 2. 清理本地数据

此步骤为可选操作。如果需要清理本地数据，请选择下方对应平台的脚本，在 macOS 的终端或 Windows 的 PowerShell 中粘贴运行。

脚本会永久删除当前用户默认的 Harness 主目录及下方列出的 Desktop 数据路径，包括会话、凭据、设置、插件、缓存和与 CLI 共用的状态。如果配置了 `DSH_HOME`，删除前请单独检查该目录；脚本仍会删除默认的 `~/.dsh`。隔离的开发和测试数据目录不在此清理范围内。

Windows 卸载程序通常会删除脚本中列出的两个应用数据目录，但保留 Harness 主目录。若卸载时有文件残留或保留了应用数据，脚本也会清理这些目录。

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

## 3. 验证清理结果

如果运行了清理脚本，请在重新安装前确认脚本中列出的路径已不存在。如果脚本报错，请解决错误后重跑脚本，再次检查所有列出的路径。Windows 脚本会在首次报错时停止，后续路径可能仍未清理。
