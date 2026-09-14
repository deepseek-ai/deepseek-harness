---
description: "dsh Web 客户端的已归档会话设置页：把注册表全局归档集合呈现为可搜索列表，每行提供一个取消归档操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-unarchive-sessions

[English](README.md) | 中文

## 概述

**已归档会话**设置页是从 Workspace 导航中隐藏的会话的恢复入口。它按归档时间由新到旧列出每个已归档会话，并显示其所属 Workspace 与最近活动时间，每行提供一个取消归档操作。搜索框按会话标题或 Workspace 名称过滤列表。行由归档集合与已加载的 Session 摘要合并而来，因此会话记录已不存在的归档条目既没有行也没有操作。每次恢复都经由共享的 Workspace 命令。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

打开设置并选择**已归档会话**，即可看到当前从所有分组视图中隐藏的会话。在已提供设置外壳、Workspace 服务与 Session 列表的 Web 组合中挂载 `@deepseek-ai/dsh-client-ui-settings-unarchive-sessions`；该页面注册自己的导航条目，无需配置。

### 阅读一行

每行显示会话的显示标题、为其记账的 Workspace 标题或未分组标签，以及以紧凑相对时间表示的最近活动。页面把最近归档的会话排在前面，与持久归档顺序相反。页面会先等待 Session 列表再渲染行；列表加载期间显示读取状态，而不是空归档。空归档、归档条目均无已加载 Session 可恢复、以及查询无匹配分别给出三种提示，因此搜索和不可寻址的条目都不会被误认为归档为空。

### 恢复会话

取消归档会把会话恢复到其 Workspace 下记录的位置；会话不属于任何 Workspace 时则恢复到未分组会话中，该行随即从页面消失。该操作调用 `ctx.uiWorkspace.unarchiveSession`，其回传的完整归档集合会更新所有依据它过滤的界面，因此会话也会重新出现在侧边栏与搜索中。调用被拒绝时会记录一条 console 诊断，并保留该行以便再次尝试。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

页面是 id 为 `archived-sessions` 的一个本地化 `settings.section` 贡献；导航条目、模态框与挂载的分区都归设置外壳所有，不在此包内。

### 注册与数据来源

`apply()` 注册并绑定 locale namespace，再用 `ctx.slots.inject()` 贡献该分区，因此延迟声明或恢复声明的 slot 依然能触达它。页面从 `useWorkspaces` 读取 `state.archivedSessionIds` 与 `state.items`，从 `useSessions` 读取 Session 摘要；它不持有 store 也不持有 transport，唯一的写入是注册处以 `ctx.uiWorkspace.unarchiveSession` 闭包注入的 `unarchive` 回调。

### 行的派生

行由归档集合与已加载摘要合并派生：没有摘要的成员不产生行，因此在 Workspace 注册表之外被删除的会话不会留下取消归档操作。Workspace 归属从各 Workspace 的 `sessionIds` 读取；不属于任何 Workspace 的成员以未分组标签渲染。搜索只规范化一次查询，并与行标题和 Workspace 标签匹配。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 宿主 loader 入口：该页面仅供浏览器使用，因此插件体为空 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器插件：locale namespace、分区注册、注入的取消归档操作 |
| [`src/client/ArchivedSessionsSection.tsx`](src/client/ArchivedSessionsSection.tsx) | 页面组件：行的派生、搜索、每行的取消归档 |
| [`src/client/locales.ts`](src/client/locales.ts) | 全部可见与无障碍字符串的中英文字典 |
| [`src/client/ArchivedSessionsSection.module.css`](src/client/ArchivedSessionsSection.module.css) | 页面样式 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖承载该页面的设置界面、其背后的归档写入，以及它所渲染的状态。

- [ui-settings](../ui-settings/README.zh.md)——声明 `settings.section` 与 namespace scope 服务的领域底座。
- [ui-settings-general](../ui-settings-general/README.zh.md)——渲染导航并挂载该分区的设置外壳。
- [ui-workspace](../ui-workspace/README.zh.md)——其 Session 行负责归档的侧边栏浏览器，以及本页面借以恢复的 `ctx.uiWorkspace` 服务。
- [Workspace Controller](../../api/workspace-controller/README.zh.md)——`workspace.unarchiveSession` Remote 与持有归档集合的 Client model。
- [Workspace 子系统](../../../docs/subsystems/workspace.zh.md)——持久归档集合、其领域字段，以及恢复背后的注册表操作。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端 UI 插件层，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定本页面能够恢复哪些已归档会话；它们是当前包约束。

- **已加载摘要缺失的已归档会话无法寻址**：页面通过与 Session 列表合并来派生行，因此列表未携带的成员没有行也没有取消归档操作，尽管归档集合仍持有它；当集合中的成员全部处于该状态时，页面报告无法恢复，而不是报告归档为空。
- **页面只列出会话，不提供会话删除**：归档可通过本页面恢复，而删除会话记录仍是彼此独立的能力。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。本包是浏览器端设置页，只注册一个本地化 `settings.section` 贡献及其 locale namespace；它不发出 Cordis 事件，也不持有跨插件可变关系。
