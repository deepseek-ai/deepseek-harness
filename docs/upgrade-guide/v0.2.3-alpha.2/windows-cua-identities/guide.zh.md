---
kind: upgrade-guide
description: "Windows 自动电脑操作将名单中的启动器和运行文件路径映射到同一应用 ID，匹配路径的授权键随之改变。"
---

# Windows 应用权限

[English](guide.md) | 中文

## 变更

Windows 自动电脑操作保留窗口 AUMID、打包应用的进程 AUMID 和可执行文件路径回退规则。[已知应用别名](../../../../packages/experimental/cua-windows/README.zh.md#known-application-aliases)将飞书与 GitHub Desktop 的特定启动器和运行文件路径映射到对应的开始菜单 ID。匹配的路径选择和没有 AUMID 的窗口在列出的版本及安装副本之间共用该 ID。其他可执行文件路径仍相互独立；显式路径选择不查找 AUMID。

`windows-aumid` 授权键算法保持不变。按匹配的可执行文件路径身份保存的授权，不会自动迁移到共享的应用 ID。Windows 应用审批支持“始终允许”；用户明确选择之前，已有会话授权仍只适用于当前会话。显示名称和图标不决定权限范围。macOS 身份规则不变。

## 迁移

1. 使用更新后的 Windows 辅助程序及其构建输出中的全部文件重启 DSH。重启使用同一 profile 的所有 Host。
2. 通过 `cua.listApps()` 或 `cua.findApps()` 发现应用，将返回的 ID 原样传给 `cua.getApp()`。如果路径现在匹配名单中的别名，请确认新的审批请求；只有需要跨会话访问时才选择“始终允许”。
3. 验证在新会话中选择同一应用时会复用保存的决定。在自动电脑操作插件页移除过时条目；撤销当前应用条目，会移除共享该 ID 的所有副本的访问权。
