---
description: "Client 会话状态表与 useSessionStatus hook：按会话提供运行状态、生效的待交互请求和完成提醒。"
kind: "package-reference"
---
# @deepseek-ai/dsh-api-session-status

[English](README.md) | 中文

## 概述

使用本包可从同一张 Client 状态表读取每个 Session 的运行状态、优先级最高的待交互请求和完成提醒。组件通过根 hook `useSessionStatus` 读取该表；Client 插件以 `ctx.uiSession.sessionStatus` 读取。本包没有配置字段、Host 行为或持久化存储。

## 目录

- [状态表](#status-table)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="status-table"></a>
## 状态表

Web bundle 在 [`dsh-client-ui-session`](../../client/ui-session/README.zh.md) 之后加载本包的 Client 部分；只加载 ui-session、不加载本包的组合没有状态表，也没有 `useSessionStatus` hook。读取 `ctx.uiSession.sessionStatus` 的插件需要在 `inject` 列表中加入 `'uiSession.sessionStatus'`；否则 Cordis 会拒绝该属性读取。该成员声明在 ui-session 的 `UiSessionService`（`ctx.uiSession` 的类型）上；标注为 `UiSession` class 的值看不到它。

| 成员 | 用途 |
|---|---|
| `getSnapshot()` | 按 Session 身份索引的状态；状态事实变化前快照保持同一引用 |
| `subscribe(listener)` | 观察已发布的变化；抛错的 listener 会被报告，不会阻止后续 listener |

每个 `SessionStatus` 有三个相互独立的字段：

| 字段 | 来源 |
|---|---|
| `running` | Host 会话列表基线和 `api-session/status` 事件；两者都未建立之前为缺省。Subagent 目录行和已保留子会话的 fallback 行不会建立它。 |
| `pendingInteraction` | `ctx.uiSession.pendingInteractions` 为该 Session 发布的同一个对象。领域插件仍通过 `ctx.uiSession.registerPendingInteraction(precedence)` 登记请求。 |
| `completionUnread` | 本 Client 在主视图未保留该 Session 时观察到的一次停止，包括首个列表基线之前到达的空闲事件。主视图保留该 Session、该 Session 再次运行，或就绪列表不再包含它时，提醒清除。 |

<a id="model-experience"></a>
## 模型体验

无，因为状态表不添加工具、提示词或 Session 事件。

#### KV Cache 影响

无；状态表不会组装模型请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **完成提醒只属于一个 Client**——另一个浏览器标签页或刷新后的页面不会带上本 Client 记录的提醒。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
