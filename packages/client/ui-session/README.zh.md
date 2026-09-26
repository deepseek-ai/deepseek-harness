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

- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

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

**运行时不变式：** 不发布伴生入口。适配器 materialization 路径已经强制 Session 绑定一致。
