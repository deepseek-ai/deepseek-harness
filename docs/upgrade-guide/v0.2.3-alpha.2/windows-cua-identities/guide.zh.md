---
kind: upgrade-guide
description: "Windows 自动电脑操作会解析更多桌面应用的 AUMID，原先保存的可执行文件路径选择标识现在可能对应多个副本共享的应用。"
---

# Windows 应用权限

[English](guide.md) | 中文

## 变更

Windows 自动电脑操作在显式窗口 AUMID 和打包应用 AUMID 之外，补充使用 Windows Shell 解析应用。原先按可执行文件路径识别的桌面窗口，现在可能与开始菜单应用共用 AUMID，包括通过启动器运行的应用。相同 AUMID 的不同版本和副本共享授权，不区分位置或签名，与 macOS 相同 bundle identifier 的应用一致。没有 AUMID 的应用仍使用规范化的可执行文件路径。

已有 AUMID 授权键保持不变。按可执行文件路径身份保存的授权，不会自动授权新解析出的 AUMID。会话授权仍只适用于当前会话。显示名称和图标不决定权限范围。

## 迁移

1. 使用更新后的 Windows 辅助程序及其构建输出中的全部文件重启 DSH。重启使用同一 profile 的所有 Host。
2. 通过 `cua.listApps()` 或 `cua.findApps()` 发现应用，将返回的 ID 原样传给 `cua.getApp()`。如果应用现在解析为 AUMID，请确认其审批请求；只有需要跨会话访问时才选择“始终允许”。
3. 验证在新会话中选择同一应用时会复用保存的决定。在自动电脑操作插件页移除过时条目；撤销当前应用条目，会移除共享该 ID 的所有副本的访问权。
