---
description: "deliverables 组导览：记录轮次交给用户的内容的 Host 插件，即显式文件交付与观察到的工作区改动，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# packages/deliverables

[English](README.md) | 中文

## 概述

deliverables 系列把一轮交给用户的内容记录为只有客户端读取的持久 Session 事件：`present` 工具声明模型交付的最终文件，workspace-changes 记录器用 git 快照和整文件捕获记录一轮改动的文件及其行数，并提供每个文件的对比。Web 的[交付插件](../client/ui-deliverables/README.zh.md)在轮次末尾渲染两者。需要展示交付文件和每轮改动的产品选择本系列；`present` 需要 `ctx.tools` 与 `ctx.fs`，记录器需要 `ctx.subprocess` 和 git 可执行文件。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 角色 | ctx key |
|---|---|---|
| [`tool-present`](tool-present/README.zh.md) | 通过 `present` 工具把已有文件声明为最终交付物 | 注册到 `ctx.tools` |
| [`workspace-changes`](workspace-changes/README.zh.md) | 用 git 工作树快照和整文件捕获汇总每个顶层轮次改动的文件，并提供其对比 | 提供 `ctx.workspaceChanges`；监听 `session/event`，追加 `workspace/changes` |

-----

<a id="related-documentation"></a>
## 相关文档

- [产出物子系统](../../docs/subsystems/deliverables.zh.md)——`PresentedFile` 与 `WorkspaceChangesSummary` 的词汇、两个持久事件和摘要服务。
- [Web 产出物](../client/ui-deliverables/README.zh.md)——渲染这些事件的轮尾卡片与文件提及。
- [present 声明工作区源文件](../../.agents/notes/implemented/feature/2026-09-08-present-workspace-source-files.zh.md)——交付决策。
- [本轮改动文件卡片](../../.agents/notes/implemented/feature/2026-09-11-turn-changed-files-card.zh.md)——快照设计与覆盖规则。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
