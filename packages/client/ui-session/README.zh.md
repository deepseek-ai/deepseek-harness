---
description: "面向 Session Controller 列表、交互状态与逐会话上下文的 React 与 Slot 适配器。"
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-session

[English](README.md) | 中文

## 概述

使用本包可通过标准 Slot 钩子公开 Session catalog、retain 信息与统一 UI 状态。它按 `SessionBinding` 物化钩子和 prop，而 `SessionProvider` 可以继承外围 binding 或绑定显式 `SessionReference`。它拥有进程本地的 pending-interaction 与完成提醒策略，但不拥有 Controller transport、历史或 reference。

运行状态来自 Host 列表基线或状态事件。Subagent 目录行和已保留子会话的 fallback 行不会建立运行状态；主视图引用仍会确认完成提醒。

## 目录

- [访问 Hook](#access-hooks)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="access-hooks"></a>
## 访问 Hook

本包注入 Client `remoteAccess` 服务，并在其 `source()` 之上发布会话访问 Hook：根作用域的 `useSessionAccess(sessionId, action)` 回答某一个 Session 资源上的访问，Session 作用域的 `useAccess(action)` 回答所绑定 Session 资源上的访问；`global` 资源上的答案是另一个 Hook `useRemoteAccess(action)`，两者互不遮蔽。SessionMaybe 作用域的 `useAccess(action)` 在未绑定 Session 时返回 `undefined`，调用方将其视为不允许；需要 `global` 资源上的判断时读 `useRemoteAccess`。快照语义归 [`dsh-api-remote-access`](../../api/remote-access/README.zh.md#client-face)。

<a id="model-experience"></a>
## 模型体验

无，因为本包适配浏览器侧 Session 状态，不注册任何面向模型的内容。

#### KV Cache 影响

无；Session selector 与 Slot scope 不会组装模型请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **Pending interaction 是进程本地投影**——浏览器重连后，所属 Remote waterfall（瀑布式事件）必须重放仍未完成的请求。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
