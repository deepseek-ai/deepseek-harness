---
description: "面向以子进程方式启动 DeepSeek Harness 运行时、并通过 stdio JSON-RPC 驱动 agent 轮次的调用方的 TypeScript SDK 客户端：DeepSeekHarness 运行 API 与低层 HarnessClient。"
kind: "package-library"
---

# @deepseek-ai/dsh-sdk-client

[English](README.md) | 中文

## 概述

`dsh-sdk-client` 让 TypeScript 程序以子进程方式、通过 stdio JSON-RPC 驱动 DeepSeek Harness 运行时。使用 `DeepSeekHarness` 你可以启动运行时、打开会话、发送提示词，并收集最终响应以及事件与通知流；`HarnessClient` 提供对协议层的显式控制。它是 [Python SDK](../../../python/README.zh.md) 的设计孪生，共享同一个运行时对端与协议。启动说明是显式的——调用方可通过 `dshBin` 指定运行时可执行文件，省略时解析同版本 `@deepseek-ai/dsh` 包的 bin，参数由客户端构造——因此本客户端适合仓库近旁的 TypeScript 消费方，如 SDK subagent 后端和知道自己要启动哪个运行时的自动化。它是纯库：不在任何 Cordis 上下文注册，而且它启动的运行时是一个完整 harness，其组成由自己的 `cordis.yml` 决定。

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

当 TypeScript 代码需要从另一进程驱动完整 Harness 运行时、且你能显式指名运行时可执行文件时，使用本客户端。常用路径极简：用启动规格构造 `DeepSeekHarness`，运行提示词，然后关闭它，使子进程总能被回收。

### 用 DeepSeekHarness 运行 agent 轮次

```ts
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

await using harness = new DeepSeekHarness({
  profile: 'sdk',
  patches: ['./automation.cordis.yml'],
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: ReasoningEffortId('max'),
  maxTokens: 49_152,
})
const result = await harness.run('say hi')
console.log(result.finalResponse)
```

子进程在首次使用时惰性启动，并在多次 `run()` 调用之间持续归实例所有；请调用 `close()`（或使用 `await using`），子进程才总能被回收。`start()` 会记忆化有界的 `initialize` 握手，其中包含工作区 cwd、提供方／模型路由、可选且由适配器持有的 `reasoningEffort`，以及可选的正整数 `maxTokens` 输出上限。服务器会在接受提示词前校验该确切路由；省略推理强度时保留模型自身的默认值。`initializeTimeoutMs` 默认 10 秒，诊断会写明所选 profile 并附带保留的 stderr 尾部。`run(input, { sessionId?, onNotification? })` 接受文本或 `SdkPromptContentBlock[]`；内联栅格图像块携带规范 base64 与 `mimeType`，并在运行时内变成持久附件。该调用拥有一个活动区间：它将提示词排入队列，等待其消息 id 出现在持久入队回执中，然后持续收集到整个 agent 下一次进入 `idle`。它返回 `RunResult { sessionId, finalResponse, events, notifications }`，其中 `finalResponse` 是该区间内根会话最后提交的助手文本——并非因果上归属于该提示词的响应，因为 steering（中途引导）、注入的上下文和其他排队工作都可能在 idle 前参与其中。`session(id?)` 打开具名或全新的会话句柄。握手失败且清理成功时，实例会换入全新客户端，使后续调用用新进程重试，直到终结性的 `close()`；如果初始化和清理均失败，`start()` 会返回保留两个原因的有序 `AggregateError`，并继续保留失败的客户端，避免在原进程退出尚未得到证明时启动另一个进程。`maxTokens` 限制每个根 agent 请求的输出量，并由进程内后代继承；压缩（compaction）插件单独持有摘要上限。

### 用 HarnessClient 做低层控制

`HarnessClient` 是运行 API 之下的协议客户端：显式 `start()`、`initialize()`、`prompt()`、`request()` 与 `close()`，外加通知订阅。`prompt()` 在运行时接受排队消息后立即返回该消息的 id，绝不等待 agent 活动。`subscribe(filter?)` 返回 `NotificationSubscription`（可等待的 `next()`、非阻塞 `tryNext()`、异步迭代）；`subscribeSessionTree(id)` 把范围限定到一个会话及从 `subagent.started` 血缘边发现的后代——运行时对上下文内每个会话都发通知，范围限定在客户端完成，与 Python SDK 完全一致。

本客户端为每种失败模式导出类型化错误：`JsonRpcResponseError`（协议错误响应，保留 code 与 data）、`RequestTimeoutError`（配置的时限已到）、`SdkProtocolError`（响应超出文档化协议）、`TransportClosedError`（运行时已消失——消息携带退出码与有界 stderr 尾部）。`close()` 先请求协议 `shutdown`（受 `shutdownTimeoutMs` 约束，默认 1000 毫秒），然后走 stdin-EOF → SIGTERM → SIGKILL 阶梯直到进程退出；幂等，已关闭的客户端拒绝复用。`HarnessClientOptions.env` 给定时整体替换子进程环境（`undefined` 原样继承父进程环境）；凭据策略归调用方——`dsh-subprocess` 的 `scrubbedParentEnv` 是面向隔离启动的共享擦除基底。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释客户端背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

客户端是同一协议上的两层：`DeepSeekHarness`（自有运行）叠加在 `HarnessClient`（协议客户端）之上，与 Python SDK 的分层一致。它运行在任何 harness 上下文之外，因此直接 spawn 运行时而非经由 `dsh-subprocess` 服务——即该 seam 记录的 SDK 托管传输例外——其关闭阶梯也位于本包。运行时对上下文内每个会话都发通知；会话树范围限定是客户端对 `subagent.started` 血缘边的过滤。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/api.ts`](src/api.ts) | `DeepSeekHarness` + `HarnessSession`：自有运行、回收到 idle 的收集、`finalResponse` |
| [`src/client.ts`](src/client.ts) | `HarnessClient`：spawn、握手、请求、订阅扇出、类型化错误 |
| [`src/dispose.ts`](src/dispose.ts) | 私有关闭阶梯：stdin EOF → SIGTERM → SIGKILL 直到真正退出 |
| [`src/types.ts`](src/types.ts) | 启动与超时选项、通知结构、`RunResult` |
| [`src/index.ts`](src/index.ts) | 消费方接口：两层客户端与面向调用方的类型 |
| — | 不发布运行时不变式伴生入口；对端是独立运行时进程。 |

### 自有活动流程

一次运行会订阅会话树、把提示词排入队列，等待提示词的消息 id 出现在持久的 `agent/inbox/spliced` 回执中，然后持续收集通知，直到整个 agent 报告 `idle`。`finalResponse` 从收集到的事件中最后一条 `assistant/message` 派生。传输丢失、超时与协议违例会使本次运行被拒绝；模型结果仍可在事件流中观察，但不会归属于某一输入。

### 错误与关闭

每种失败模式都映射到一个导出的错误类——协议错误响应、请求时限已到、响应超出文档化协议、运行时死亡——调用方可以按失败类型分支处理；这四个类从 [src/index.ts](src/index.ts) 导出。关闭采用私有的幂等阶梯（stdin EOF → SIGTERM → SIGKILL），位于 [src/dispose.ts](src/dispose.ts)，只在进程真正退出时结束。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当客户端约定不够用时阅读以下页面。它们从协议格式进入服务插件与使用本客户端的应用。

- [SDK 协议格式](../protocol/README.zh.md) — 本客户端所说的 JSON-RPC 方法与载荷结构。
- [JSON-RPC 服务插件](../server/README.zh.md) — 服务本客户端的运行时插件。
- [Python SDK](../../../python/README.zh.md) — 共享同一运行时对端与协议的设计孪生。
- [SDK subagent 后端](../../subagent/subagent-dsh-sdk/README.zh.md) — harness 内部消费本客户端的例子。
- [SDK 应用组合包](../../bundle/sdk-app/README.zh.md) — 本客户端启动的 `dsh --profile sdk` 运行时应用。

-----

<a id="model-experience"></a>
## 模型体验

无，因为这是客户端进程库；模型可见行为存在于所 spawn 运行时组合的插件中。

#### KV Cache 影响

client 进程中无影响。子进程的 profile、patch、provider、model 与历史决定缓存复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本客户端何时不合适或需要特别注意。它们是当前包约束，不是与其他 SDK 客户端的对比或任务积压。

- **无捆绑运行时解析**——客户端解析同版本 `@deepseek-ai/dsh` 包（或调用方提供的 `dshBin`）；打包可执行文件的发现留在 Python 侧，直到出现 TypeScript 发行版消费方。
- **无轮次中取消**——协议层没有提示词取消方法；放弃轮次意味着关闭运行时（见[协议限制](../protocol/README.zh.md#known-limitations-and-deferred-work)）。
- **没有逐提示词结果**——低层 `prompt()` 只返回入队回执；高层 `run()` 负责从回收到 idle 的收集，放弃该过程意味着关闭运行时。
- **客户端→服务端通知与服务端→客户端请求**在协议两端都未实现；传输层为未来审批流程保留了承载能力。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性——已交付的行为与限制见上文各节与代码。启动规格有意保持完全显式：在出现 TypeScript 发行版消费方之前，不计划做捆绑运行时解析。请让关闭阶梯与错误词汇与驱动同一运行时的 Python 客户端保持同步。没有记录其他未解决的开放设计问题。

</details>
