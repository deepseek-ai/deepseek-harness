---
description: "workspace 组地图：持久工作区实体家族、用户目录的持久记录与基于会话头的成员资格记账，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# packages/workspace

[English](README.md) | 中文

## 概述

workspace 组提供宿主 UI 背后的持久项目列表：一个产品包 `workspace`，把用户目录命名为项目、保持稳定顺序，并把每个项目的会话归入其下。借助它，UI 可以显示带会话的项目侧边栏、把会话从分组中隐藏而不删除它，以及移除项目——移除绝不会删除文件夹或会话历史，它们只会变成 Ungrouped。本组只面向宿主侧：没有工具、提示词或会话事件，因此模型与 agent loop 永远不会看到它。当产品展示持久 workspace 或项目界面时使用它；它需要会话存储与持久化后端一并挂载。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`workspace`](workspace/README.zh.md) | 提供命名且有序的项目，并在每个目录下聚合其会话 | `ctx.workspaceRegistry` |

-----

<a id="related-documentation"></a>
## 相关文档

- [Workspace 子系统](../../docs/subsystems/workspace.zh.md)——项目及其会话的权威功能约定。
- [领域 KV 存储 Agent Note](../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)——项目记录背后的存储设计。
- [Workspace UI 产品流 Agent Note](../../.agents/notes/archived/feature/2026-07-25-workspace-ui-product-flow.md)——首次启动如何从会话历史构建项目，以及 GUI 如何排序。
- [删除 Workspace 注册记录决策](../../.agents/notes/implemented/feature/2026-07-27-workspace-registration-deletion.zh.md)——为什么移除项目绝不会删除其文件夹或会话。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
