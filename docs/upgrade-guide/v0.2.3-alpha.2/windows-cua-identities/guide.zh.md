---
kind: upgrade-guide
description: "Windows 自动电脑操作在报告共同 AUMID 或可执行文件路径的选择之间共享应用授权，不改变应用 ID。"
---

# Windows 应用权限

[English](guide.md) | 中文

## 变更

Windows 自动电脑操作保留 `cua.listApps()`、`cua.findApps()` 和 `cua.getApp()` ID 所用的窗口 AUMID、打包应用的进程 AUMID 和可执行文件路径规则，`windows-aumid` 授权键算法保持不变。`getApp` 另外报告[权限属性](../../../../packages/experimental/cua-windows/README.zh.md#permission-attributes)：AUMID（包括 Shell 解析的 AUMID）和可执行文件路径。已保存的决定适用于共享任一属性值的选择，因此飞书的开始菜单条目、启动器和运行程序通过 `com.electron.Feishu` 共用一项授权。

已保存的应用记录新增可选的 `attributes` 字段。此前分别保存、现在拥有共同属性的应用授权，在某次选择将其关联后显示为一项；撤销该项会移除全部关联应用的访问权。Windows 应用审批支持“始终允许”；用户明确选择之前，已有会话授权仍只适用于当前会话。共享授权不改变启动目标或窗口关联。macOS 身份规则不变。

## 迁移

1. 使用更新后的 Windows 辅助程序及其构建输出中的全部文件重启 DSH。重启使用同一 profile 的所有 Host。
2. 通过 `cua.listApps()` 或 `cua.findApps()` 发现应用，将返回的 ID 原样传给 `cua.getApp()`。只有需要跨会话访问时才选择“始终允许”。
3. 验证在新会话中选择同一应用或其启动器时会复用保存的决定。在自动电脑操作插件页检查条目，撤销不再需要的关联条目。
