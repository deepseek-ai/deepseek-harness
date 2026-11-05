# Agent Note: Windows 额外目录授权仅用于文件工具

Status: implemented

[English](2026-10-29-windows-file-tool-directory-grants.md) | 中文

## 问题

记忆插件需要针对会话向 `~/.dsh/memory` 等目录写入。通过 ACL 扩展 Windows 进程访问权限，需要为不断变化的目录组合管理持久文件系统授权与令牌身份，从而加深对已有执行限制的后端的依赖。

## 决策

在 Windows 上，[会话目录 effect](2026-10-26-session-writable-directory-effects.zh.md) 仅通过 `write` 与 `edit` 使用的 Harness 文件系统检查授权额外目录。进程提供方忽略额外根目录，保留工作区与私有临时目录权限。ACL 包、runner 参数与工作区 SID 保持不变。POSIX 进程后端继续执行额外根目录授权。

Windows 进程的额外根目录支持推迟到更好的沙箱后端能够实现该功能、无需扩展 ACL 定制时。模型上下文明示文件工具授权与 Windows 进程权限的区别。

## 考虑过的替代方案

**为每个目录或目录集合分配 SID。** 这些设计可以逐次执行选择进程权限，但需要更多 ACL 修改、身份管理与生命周期处理。该能力不足以证明扩展此机制的必要性。

**存在额外授权时拒绝进程。** 当记忆插件注册目录时，这会阻止无关的 PowerShell 和工作区操作运行，即使命令从不访问该目录。

## 影响

Windows 记忆插件可以通过 `write` 与 `edit` 访问注册的目录，同时普通工作区命令继续运行。shell 命令或 PTC 程序无法使用该额外授权。这明确接受文件工具与进程工具的能力差异；注册和清理仍限定于会话，已有进程保留启动时的权限。
