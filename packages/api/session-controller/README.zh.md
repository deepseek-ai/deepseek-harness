---
description: "Host 与 Client 会话控制：创建、恢复、提示、跟随历史并投影实时会话状态。"
kind: "package-reference"
---
# Session Controller

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-api-session-controller` 拥有 Host 的 `ctx.sessionController` 服务，以及生成的 Client `session`、`skills` 和 `fileReferences` Remote namespace。它提供 Session 生命周期与历史、Host generation 模型目录、工作区路径打开、用户可调用 skill 发现，以及面向 Agent 的文件引用 adapter。当 Client 需要按 Session 寻址的操作时，请通过 API Gateway 使用它。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

历史页与 follow opening snapshot 携带带判别字段的 `SessionHistoryRecord`。两个分支都使用 `{ type, event }`：`type: 'event'` 携带一个原始 `SessionWireEvent`，`type: 'chunks'` 则携带一个由连续且属于同一 block 的 `assistant/chunk` delta 组成的无损 `ChunkRowEvent`。两种内部值都公开 `type`、`seq`、`time` 与 `data`，因此 Client 无需逐 record 转换，就能把每条已接受 record 保留为一个 `SessionEventLikeEntry`。packed event 的 `seq` 与 `time` 表示首成员，`data` 保留 fragment 与 timestamp-gap 数组。实时 follow frame 继续携带单个 `event` record。工具参数、结果内容、失败信息和 `tool/result.data.meta` 原样通过；controller 不解析 Tool definition、不运行 presenter，也不附加 UI 数据。

每个 endpoint 都声明自己的激活策略。列表、搜索、附件、历史页、日志跟随、skill 发现和工作区路径打开可以在不激活 Agent 的情况下检查 persistence；`canOpenWorkspacePath()` 无需指定 Session 即可报告原生打开能力。queue 变更与取消要求 live 状态；模型、重命名、prompt 和文件引用操作可以解析或恢复普通 Session。只有 create 与 fork 会直接创建新 Agent。skill 目录则优先使用已有 live Agent，否则使用所记录 preset 的常驻 scope，因此列表查询绝不会启动 Agent。

Client adapter 提供 `SessionEventStream`，即绑定到一个普通 Session 或 direct subagent address 的 Gateway `RemoteJournalStream`。它在读取首个 page 前打开 follow，只发布连续的 `replace`、`prepend` 和 `append` 变更，并通过 tail page 修复重连或 seq 缺口。向后分页有两个动词：`loadOlder()` 拉一页 50 条 message，而 `loadThrough(seq)`——轮次跳转加载器——按 200 条 message 一页循环拉取直到窗口覆盖目标 seq，重复调用会下调共享目标，遇到无进展的页即停止，忙碌状态复用同一个 `loadingOlder` 快照位。普通 record 覆盖 `[event.seq, event.seq]`，packed row 覆盖 `[event.seq, event.seq + memberCount - 1]`。业务、persistence 或无法恢复的连续性错误会终止 stream，只有物理载体断开才触发自动恢复。`SessionControlStream` 是 Gateway `RemoteSnapshotStream`；每代都以完整的进程本地 baseline 开始，因此重连会替换 queue、jobs 和 projection 状态，而不会把瞬态值当作 durable event。

Session 对象还承载本地提交回显：`session.beginSubmission` 在调用方序列化与 prompt 之前，同步把一条回显写入 `SessionSnapshot.pendingSubmissions`，会话 UI 因此能在点击提交的当帧显示消息。Session 根据当前运行状态与请求的投递模式推导每条回显的 `transcript`、`queued` 或 `steering` 位置，并在序列化期间保留该位置。prompt 的 `requestId` 是关联标识：Host 把它回显为 durable user source 的 `rpcId`，queue occurrence 也把它投影为 `SessionQueuedItem.rpcId`。回显在观察到其 durable event 或 queue occurrence 后延迟一个动画帧退休，该延迟保证替代内容就绪前回显仍可渲染；带标识的 prompt 失败或被放弃时立即退休，销毁时按 failed 退休；每次退休恰好触发一次注册的 `onRetire` 回调。回显只存在于 Client 内存；刷新与重连只从 durable event 重建会话。

-----

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `coldBlankProbeMaxEvents` | `16` | stat 报告的事件数不超过该值的冷 Session 才可进行空白状态验证；`0` 禁用事件数门槛 |
| `coldBlankProbeMaxBytes` | `1,024` | 后端不提供事件数时，stat 报告的工件字节数不超过该值的冷 Session 才可进行空白状态验证；`0` 禁用字节数门槛 |
| `nativeOpen` | 平台探测 | 是否能把 Session 工作区路径交给原生桌面打开器 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-api-session-controller)是所有受支持字段及其 JSDoc 的完整来源。

-----

<a id="model-experience"></a>
## 模型体验

无，因为被调用的 Agent 命令拥有任何模型可见效果。

#### KV Cache 影响

无直接影响；模型请求仍由 Agent 和 LLM 包拥有。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- Control baseline 表示进程本地状态，因此 Host 重启后无法重建 jobs。
- follow 恢复失败会对调用方可见，而不会无限重试。
- 文件引用补全使用共享 Agent lookup，因此可能恢复冷 Session；`skills/list` 目录是不激活 Agent 的 skill 元数据读取路径。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。每个分页与帧都会对照其指向的持久 Session 校验。
