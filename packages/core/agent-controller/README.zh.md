---
description: "把来自 Agent 外部的消息投递进其收件箱，面向 Web Session Remote 等入口的维护者和接纳监听器的作者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-controller

[English](README.md) | 中文

## 概述

发送方代表他人送来的消息，先由 `agent-controller/admission` 阶段做出决定，再投递进 Agent（智能体）的收件箱。监听器可以暂留消息直到 Agent 准备就绪，也可以带着发送方会报告的原因拒绝它；Agent 自身机制产生的消息不经过这个阶段。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

base 组合包把这个服务挂载为 `ctx.agentController`，它没有配置项。代表他人送来工作的发送方自己解析接收的 Agent，然后调用 `deliver(agent, request)`，不再直接调用 `followup()` 或 `steer()`。

### 投递一条消息

`deliver()` 先运行 `request.prepare(signal)`，把发送方的内容转成持久的消息内容，再用 `request.source` 构造消息，向接纳阶段要一个决定，调用 `request.beforeInsert?.(message)`，最后在 `mode: 'followup'` 时经 `followup()`、在 `mode: 'steer'` 时经 `steer()` 放入消息。消息进入收件箱后，它返回该消息的 id。

```text
const messageId = await ctx.agentController.deliver(agent, {
  mode: 'followup',
  source: { kind: 'user', rpcId },
  signal,
  prepare: () => ctx.attachments.admitPromptContent(parts),
  beforeInsert: (message) => { record(message.id) },
})
```

`prepare` 在发给同一 Agent 的更早消息结算之后才运行，因此内容准入按到达顺序进行；它的错误原样交给发送方。`beforeInsert` 在接纳之后同步运行，紧挨在消息进入收件箱之前，用于发送方在 Agent 被唤醒前必须完成的登记。它抛出异常时消息不会进入收件箱，`deliver()` 失败时由发送方撤销自己做过的改动。

以下情况 `deliver()` 抛出 `AgentAdmissionRejected`：监听器拒绝消息（带监听器给出的 `reason` 与 `presented`）；监听器抛出异常（reason 为 `agent-controller/admission-failed`，`cause` 为原异常）；消息进入收件箱之前 Agent 已离开注册表（reason 为 `agent-controller/agent-gone`）。这些错误都是 `HarnessError`，`code` 为 `AGENT_ADMISSION_REJECTED`（`ADMISSION_REJECTED_CODE`）；发送方按这个 code 与 `reason` 识别拒绝，而不是按类判断，因此错误来自本包的另一份副本时判断同样成立。发送方取消时立即得到其取消原因，消息排在被暂留的消息之后时也是如此；`prepare`、`beforeInsert`、`followup()` 与 `steer()` 的错误原样抛出。Web Session Remote 把这些失败映射为 `session/prompt-rejected` 及其他 Session 错误。

### 暂留或拒绝一条消息

`agent-controller/admission` waterfall 的监听器按注册顺序运行，返回 `AdmissionDecision`。监听器放行时返回 `next()` 的决定，链的最后一步是 `{ kind: 'admit' }`；在调用 `next()` 前 await 即暂留消息；不调用 `next()`、直接返回 `{ kind: 'reject', reason, message, presented }` 即拒绝它。`reason` 标明拒绝原因，`presented` 表示拒绝它的插件是否在自己的界面里给出说明。监听器只在自身的检查执行失败时抛出异常；消息来源无人值守时（例如定时任务或 webhook），监听器不得等待人来处理。载荷里的 `signal` 在发送方取消或控制器停止时中止；暂留消息的监听器必须在它中止后结束。

```text
ctx.on('agent-controller/admission', async ({ agent, message, signal }, next) => {
  if (!ready(agent)) return { kind: 'reject', reason: 'my-plugin/not-ready', message: 'Prepare the workspace first.', presented: false }
  return await next()
})
```

该事件按作用域过滤：注册在某个 Agent 作用域上下文里的监听器（例如 preset 挂载的监听器）只收到该 Agent 的消息。确切签名见 [core 子系统页](../../../docs/subsystems/core.zh.md#cordis-surface)的生成区块。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本节说明服务如何实现上面的行为；可观察的约定见[使用本包](#use-this-package)。

### 设计思路

控制器把每个 Agent 的投递串在同一个 promise 上，因此被暂留的消息会让同一 Agent 后续的消息等待，其他 Agent 不受影响。这条串行包住准备、决定和放入，所以消息按到达顺序进入收件箱。准备之前，以及接纳阶段返回之后，控制器都会检查是否已取消、注册表是否仍持有该 Agent；随后调用 `beforeInsert` 和 `followup()` 或 `steer()`，中间没有 await。因此监听器不会在消息进入收件箱之后运行；需要对已接纳消息作出反应的插件监听 `agent/inbox/inserted`。排队期间被发送方取消的消息保留它在串行中的位置，轮到它时被丢弃，其余消息的顺序不变。销毁控制器会中止所有待处理投递共同观察的信号，尚未进入收件箱的消息因此被拒绝；所有待处理投递（包括其准备和监听器）都结束之后，销毁才完成。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `AgentController`、拒绝 code 与固定的拒绝原因，以及 `AgentAdmissionRejected` |
| [`src/types.ts`](src/types.ts) | `DeliveryRequest`、`AdmissionDecision` 与 `agent-controller/admission` 事件 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

包级约定足以满足大多数发送方和监听器；需要了解周边领域时再阅读以下内容。

- [agent 包](../agent/README.zh.md)——`Agent` 句柄、它的收件箱方法与 `agent/*` 事件。
- [Session Controller](../../api/session-controller/README.zh.md)——经本包投递消息的 Web `session/prompt` Remote。
- [Agent Note：经 Agent 控制器投递外部消息](../../../.agents/notes/implemented/architecture/2026-10-17-agent-controller-message-delivery.zh.md)——为什么接纳阶段放在这里，而不是 Agent 核心。
- [Core 分组地图](../README.zh.md)——core 各包如何组合。

-----

<a id="model-experience"></a>
## 模型体验

通过控制器放入 Agent 收件箱的消息间接影响；这些消息如何进入模型请求由 Agent 循环负责。

#### KV Cache 影响

接纳不增加任何模型可见内容，也不改变请求前缀；被拒绝的消息不会进入任何请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **目前只有 Web Session Remote 经控制器投递消息**：SDK 服务端、ACP、headless 运行、定时任务、webhook 与子代理提示词仍直接调用 `followup()` 或 `steer()`，它们的消息不经过任何接纳监听器。
- **请求去重仍由发送方负责**：Web Session Remote 在调用 `deliver()` 之前同步读取 Session 历史，确认重试的 `requestId` 已被接收。把这项检查移进控制器需要一个记录已接收请求 id 的投影，因为仓库禁止新增同步历史读取。
- **被拒绝的提示词可能留下已存储的附件**：准备阶段在决定之前存储附件，因此被拒绝或取消的提示词可能留下无人引用的已存图片或文件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
