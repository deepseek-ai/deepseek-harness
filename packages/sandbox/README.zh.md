---
description: "进程沙箱包组：隔离 seam、各平台后端、共享策略解析器与 Windows 写入限制档。"
kind: "package-group"
---

# packages/sandbox

[English](README.md) | 中文

## 概述

`sandbox/` 组将子进程执行限制在文件效果策略之下：命令以 `read-only` 运行、只能写入会话工作区（`workspace-write`）或不受限制地运行（`danger-full-access`）。四个包交付该能力：隔离服务（`sandbox/`）、面向 Linux、macOS 与 Windows 的各平台后端（`sandbox-local/`）、共享策略解析器（`sandbox-policy/`）与 Windows 写入限制后端（`sandbox-windows-acl/`）。被策略拒绝的受限调用可以通过用户批准的一次性升权重试。隔离仅适用于与宿主共享文件系统和内核的子进程；容器、microVM 与远程执行器会替换整个能力，而不是在此注册。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

四个包承担隔离角色；完整约定和逐调用策略语义以子系统参考文档为准。

| 包 | 职责 | ctx key |
|---|---|---|
| [`sandbox/`](sandbox/README.zh.md) | 隔离服务约定：模式、强制执行、逐调用策略与升权词汇 | `ctx.sandbox` |
| [`sandbox-local/`](sandbox-local/README.zh.md) | 各平台隔离后端：Linux 先使用 bwrap，再使用 Landlock；macOS 使用 Seatbelt；Windows 使用受限令牌 | 注册到 `ctx.sandbox` |
| [`sandbox-policy/`](sandbox-policy/README.zh.md) | 共享策略归属：供所有实施隔离的家族使用的部署默认值与逐会话模式覆盖 | `ctx.sandboxPolicy` |
| [`sandbox-windows-acl/`](sandbox-windows-acl/README.zh.md) | Windows 写入限制：受限子进程只能写入工作区与私有临时目录 | —（由 `sandbox-local` 挂载为 win32 后端） |

-----

<a id="related-documentation"></a>
## 相关文档

先从子系统参考文档了解共享词汇，再看隔离决策及其跨家族扩展。

- [进程沙箱子系统](../../docs/subsystems/sandbox.zh.md)——模式、逐调用策略、包装 argv 方言与故障关闭错误。
- [子进程沙箱决策](../../.agents/notes/implemented/feature/2026-07-06-sandbox.zh.md)——能力边界、升权编排与延期阶段。
- [跨家族文件沙箱决策](../../.agents/notes/implemented/feature/2026-07-14-cross-family-fs-sandbox.zh.md)——统一的共享策略归属与沙箱化文件系统提供方。
- [Windows ACL 受限令牌沙箱决策](../../.agents/notes/implemented/feature/2026-08-08-windows-acl-restricted-token-sandbox.zh.md)——为何选择原始 ACL 受限令牌而非 mxc 与 AppContainer。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
