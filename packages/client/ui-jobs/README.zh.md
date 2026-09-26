---
description: "会话头部后台任务列表：可展开的流式输出面板、进行中/已结束分组，以及无保留输出的已结束任务的静态行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-jobs

[English](README.md) | 中文

## 概述

`dsh-client-ui-jobs` 在一个头部控件中展示本会话的后台任务，包括生命周期、耗时、进度与终态详情。进行中的任务和保留了输出的已结束任务提供可展开的输出面板；收起即停流。进行中的行以持续更新的时长为主行，随后展示类型与状态。已结束的行折叠在分组标题下；没有保留输出的任务保持静态，包括回答已交给模型的 subagent。

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

通过 web-app 清单加载本插件；在会话看得到至少一个 job 之前它不渲染任何东西，因此普通对话不会为未使用的能力长出控件。

### 一 job 一行

`ctx.jobs` 镜像的 `job.list` 流是唯一名册：每个 `JobView` 行携带生命周期、时长、实时 `progress` 行或终态 `detail`，以及其保留字节数——进行中的 job，或留有保留输出的已结束 job，就是行可展开的依据。不存在需要 join 的第二份名册。

运行中的 job 行还带一个两击式停止控件：首击武装，三秒内的确认击调用 `ctx.jobs.kill`，行状态经名册流收敛（先 `stopping`，再入已结束分组，其 detail 携带 `cancelled by the user`）。该 kill 不在模型的播报台账里认领任何东西，任务的 owner agent 因此照常收到标准完成通知——模型被明确告知用户停止了它的任务，而不是留给它去猜（[决策](../../../.agents/notes/implemented/feature/2026-08-26-human-job-kill.zh.md)）。已结束分组在有进行中工作时折叠在其计数之后，并可在客户端清空。

### 展开的面板

展开可观察的行会从 `ctx.jobs`（由 `dsh-api-job-controller` 安装）打开该 job 的输出观测流，注入内嵌终端面板。面板复制的是命令（不是输出），命令与输出行完整换行，输出在固定高度内滚动而非折叠，且不绘制自己的运行状态点——上方的行承载状态。保留缺口与流中断在面板上方渲染为提示。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

头部操作带里的一个 slot 条目（preset 标签之后）渲染触发器与弹出层；弹出层通过测量锚点把自己收进视口。所有数据经 `ctx.jobs` 到达——组件不持有任何传输状态。名册跟随挂载：一个 `useEffect` 在控件存活期间保持会话的 `job.list` 流打开。观测跟随可见性：另一个 `useEffect` 为展开行的 job 打开流，并在收起、卸载或弹出层关闭时关闭它。

| 文件 | 角色 |
|---|---|
| [`src/client/JobListAction.tsx`](src/client/JobListAction.tsx) | 任务列表：分组、时长、面板 |
| [`src/client/index.ts`](src/client/index.ts) | slot 注册与词典 |
| [`src/client/locales.ts`](src/client/locales.ts) | `job` 命名空间文案（zh 为事实源） |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-api-job-controller`](../../api/job-controller/README.zh.md) —— 行、面板与停止控件背后的 `job.list`、`job.follow` 流、`job.kill` Remote 与 `ctx.jobs` 服务。
- [`dsh-jobs`](../../jobs/jobs/README.zh.md) —— 拥有环与投影语义的注册表契约。
- [`dsh-client-ui-primitives`](../ui-primitives/README.zh.md) —— 面板所配置的 `TerminalBlock` 表面。

-----

<a id="model-experience"></a>
## 模型体验

无。本包为人类渲染宿主观测到的状态与实时输出，不触碰任何提示词、消息、schema、流或工具结果。模型对同一工作的视图仍在 [`dsh-tool-jobs`](../../jobs/tool-jobs/README.zh.md)。

#### KV 缓存影响

无；本包从不组装或发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定当前包约束，不是任务清单。

- **不渲染 channel 标签**——stdout 与 stderr 块拼接为一条流；按 channel 着色是展示层的后续工作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作语境——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。本包只把 `ctx.jobs` 的名册与视图只读投影到一个 header slot，不发出 Cordis 事件，也不持有跨插件可变状态；其唯一的 slot 注册通过 HMR（热模块替换）安全性规范验证了资源释放行为。
