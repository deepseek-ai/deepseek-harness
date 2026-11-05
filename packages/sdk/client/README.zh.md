---
description: "面向以子进程方式启动 DeepSeek Harness 运行时、并通过 stdio JSON-RPC 驱动 agent（智能体）轮次的调用方的 TypeScript SDK 客户端：DeepSeekHarness 运行 API 与低层 HarnessClient。"
kind: "package-library"
---

# @deepseek-ai/dsh-sdk-client

[English](README.md) | 中文

## 概述

`dsh-sdk-client` 让 TypeScript 程序通过 stdio JSON-RPC 驱动完整的 DeepSeek Harness 运行时。使用 `run()` 运行普通文本、支持的 slash 命令和图片内容块，通过 `onNotification` 观察其通知。`HarnessClient` 提供直接协议访问。调用方可以提供 `dshBin`；否则客户端解析同版本的 `@deepseek-ai/dsh` 可执行文件。客户端持有子进程，报告类型化错误，并在 `close()` 或 `await using` 时回收进程。

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

若由客户端处理审批，先调用 `harness.client.start()`，安装 `harness.client.onRequest(handler)`，再调用 `harness.start()`，并在 Harness 选项中设置 `approvalRequests: true`。处理器接收 `approval/request` 参数，返回 `{ outcome: "allowed-once" | "rejected" | "cancelled" }`；处理器拒绝时返回 JSON-RPC 错误，运行时拒绝放行该审批。替换客户端时需要为新实例安装处理器；已关闭的客户端不能重启。原生问答仍由 `onUserQuestion` 回调处理。启用审批但未安装附加请求处理器时，服务端请求收到未知请求错误，审批以 `unavailable` 拒绝放行。未启用时保留现有审批应答链。请求字段与取消规则见[协议](../protocol/README.zh.md)。

下面的终端接入示例会逐项询问一次性授权，不改变会话的权限模式。Node 部署的包操作需要可用的 pnpm；[Python 运行时](../../../python/sdk-runtime/README.zh.md) 可以提供显式下载的 Node/pnpm。

```ts
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

const terminal = createInterface({ input: stdin, output: stdout })
try {
  await using harness = new DeepSeekHarness({
    dshHome: '/absolute/path/to/isolated-dsh-home', approvalRequests: true,
  })
  harness.client.start()
  harness.client.onRequest(async (method, params) => {
    if (method !== 'approval/request') throw new Error(`Unsupported request: ${method}`)
    const answer = await terminal.question(`${JSON.stringify(params)}\nAllow once? [y/N] `)
    return { outcome: answer.trim().toLowerCase() === 'y' ? 'allowed-once' : 'rejected' }
  })
  console.log((await harness.run('List the installed plugins.')).finalResponse)
} finally {
  terminal.close()
}
```

`await harness.resumeSession(savedId)` 从配置的 `dshHome` 恢复持久化会话，并返回可调用 `run()` 的 `HarnessSession`。请保存原会话 id，并沿用其 home 和工作区。恢复会保留对话历史及其目录、修复最后一个被中断的轮次，且不发送新输入。会话缺失、不可读、不兼容或被占用时，请求失败且不创建替代会话。`session(id)` 仍是当前进程内会话的惰性句柄，不会请求持久化恢复。此 API 不恢复 shell、浏览器或其他外部进程。

`HarnessSession.getWorkingDirectory()` 读取有效目录；`setWorkingDirectory(path)` 修改目录并返回校验后的绝对路径。两个方法都可创建未知 Session，而不启动模型轮次。相对路径以 Session 当前目录解析。起始目录元数据、权限与已有进程保持不变。`HarnessClient` 提供同名方法，并以 `sessionId` 作为首个参数。

### 用 DeepSeekHarness 运行 agent 轮次

```ts
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

await using harness = new DeepSeekHarness({
  profile: 'sdk',
  dshHome: '/absolute/path/to/dsh-home',
  patches: ['./automation.cordis.yml'],
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: ReasoningEffortId('max'),
  maxTokens: 49_152,
})
const result = await harness.run('say hi')
console.log(result.finalResponse)
```

子进程在首次使用时惰性启动，并在多次 `run()` 调用之间持续归实例所有；请调用 `close()`（或使用 `await using`），子进程才总能被回收。`start()` 会记忆化有界的 `initialize` 握手，其中包含工作区 cwd、提供方／模型路由、可选且由适配器持有的 `reasoningEffort`，以及可选的正整数 `maxTokens` 输出上限。服务器会在接受提示词前校验该确切路由；省略推理强度时保留模型自身的默认值。`initializeTimeoutMs` 默认 10 秒，诊断会写明所选 profile 并附带保留的 stderr 尾部。`run(input, { sessionId?, onNotification? })` 接受文本或 `SdkPromptContentBlock[]`；内联栅格图像块携带规范 base64 与 `mimeType`，并在运行时内变成持久附件。对于普通输入，该调用拥有一个活动区间：它将提示词排入队列，等待其消息 id 出现在持久入队回执中，然后持续收集到整个 agent 下一次进入 `idle`。该路径返回 `RunResult { sessionId, finalResponse, finishReason, events, notifications }`，其中 `finalResponse` 是该区间内根会话最后提交的助手文本——并非因果上归属于该提示词的响应，因为 steering（中途引导）、注入的上下文和其他排队工作都可能在 idle 前参与其中。`session(id?)` 打开具名或全新的会话句柄。握手失败且清理成功时，实例会换入全新客户端，使后续调用用新进程重试，直到终结性的 `close()`；如果初始化和清理均失败，`start()` 会返回保留两个原因的有序 `AggregateError`，并继续保留失败的客户端，避免在原进程退出尚未得到证明时启动另一个进程。`maxTokens` 限制每个根 agent 请求的输出量，并由进程内后代继承；压缩（compaction）插件单独持有摘要上限。

### 运行文本与原生命令

`await session.run(input, { onNotification })` 接受字符串或 `SdkPromptContentBlock[]`，两者都交给运行时的[命令形式与 Desktop 别名](../server/README.zh.md#command-input)识别规则。未识别的输入保持普通提示词及原始内容块顺序。普通输入（包括图片）使用既有的提示词队列。命令保留原生接纳规则与执行时序。

先选择支持图片输入的模型。通过现有内容块数组同时提交命令和图片，例如 `session.run([{ type: 'text', text: '/plan Analyze this image.' }, { type: 'image', data: imageBase64, mimeType: 'image/png' }])`；`harness.run()` 接受相同输入。计划输入和目标创建、编辑接受图片；`/plan off`、目标控制、压缩和权限命令按[原生附件规则](../server/README.zh.md#command-input)拒绝图片。原生命令输入支持编码栅格图片，不支持一般文件上传或客户端提供的附件引用。

```ts
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

await using harness = new DeepSeekHarness({ profile: 'sdk', dshHome: '/absolute/path/to/dsh-home' })
const session = harness.session()
const result = await session.run('/compact')
console.log(result.finalResponse)
```

字符串和内容块输入始终返回 `RunResult`，包含 `sessionId`、`finalResponse`、`finishReason`、根会话事件和会话树通知。仅改变状态的命令返回原生结果文本；提交模型工作的命令等待对应活动并返回最终助手文本，未输出助手文本时返回空字符串。原生拒绝通过 `finishReason === "error"` 表达，路由、协议、传输和观察回调失败会拒绝 Promise。命令 id 和原生结果保留在 `command/run`、`command/done` 事件中。完成通知缺少匹配的命令生命周期事件时抛出 `SdkProtocolError`，不会返回不完整的结果。需要按原文排队时，使用底层 `client.prompt(sessionId, blocks)` 并管理后续活动；运行时技能识别仍然适用。

每次调用在发送前建立订阅，并在结束前释放。`onNotification` 按传输顺序接收本次输入的会话树活动；区间可以包含其他重叠工作。内部完成回执由 SDK 消费。并发调用保留各自结果，因此模型运行期间仍能取得另一条命令的忙碌错误。超时或观察回调失败不回滚运行时工作，也不授权自动重试。

启动选项提供初始值。权限命令只修改目标 Session；后续输入与恢复保留该状态，其他 Session 保留自己的状态，新 Session 使用配置默认值。命令不修改选项对象或已保存的用户默认值。运行中的审批策略变化可以注入通知并触发下一步骤。原生转换与恢复行为见[权限 preset](../../interaction/permission-presets/README.zh.md)。

`run('/plan')` 进入计划模式；`/plan off` 退出；`/plan <message>` 进入并通过 steer 提交正文。`run()` 等待提交的模型活动、原生审阅及获批后的执行，无需调用者另行订阅或等待。通过用户问题处理器回答计划审阅；`exit_plan_mode` 的计划正文位于问题的 `detail`。计划模式不改变权限。通过 `run()` 创建或恢复目标时，会跨越自动轮次等待，直到目标停止及最后回复结束；暂停或清除返回 `aborted`，目标阻塞或失去激活状态报告失败。

### 用 HarnessClient 做低层控制

`HarnessClient` 是运行 API 之下的协议客户端：显式 `start()`、`initialize()`、`prompt()`、`request()` 与 `close()`，外加通知订阅。`prompt()` 在运行时接受排队消息后立即返回该消息的 id，绝不等待 agent 活动。`subscribe(filter?)` 返回 `NotificationSubscription`（可等待的 `next()`、非阻塞 `tryNext()`、异步迭代）；`subscribeSessionTree(id)` 把范围限定到一个会话及从 `subagent.started` 血缘边发现的后代——运行时对上下文内每个会话都发通知，范围限定在客户端完成，与 Python SDK 完全一致。

拥有完整任务的消费者可以先订阅，再调用 `prompt()`，随后调用 `request('session/wait', { sessionId })`，并通过 `tryNext()` 取完已排队的通知。这会等待受管理后代及其触发的根 Agent 摘要轮次；`HarnessSession.run()` 对普通提示词仍以首次空闲作为活动区间终点。`validatedSessionEvent()` 在事件进入输出折叠前，校验事件封装及 SDK 读取方使用的 assistant／turn 字段。

本客户端为每种失败模式导出类型化错误：`JsonRpcResponseError`（协议错误响应，保留 code 与 data）、`RequestTimeoutError`（配置的时限已到）、`SdkProtocolError`（响应超出文档化协议）、`TransportClosedError`（运行时已消失——消息携带退出码与有界 stderr 尾部）。`close()` 先请求协议 `shutdown`（受 `shutdownTimeoutMs` 约束，默认 1000 毫秒），然后走 stdin-EOF → SIGTERM → SIGKILL 阶梯直到进程退出；幂等，已关闭的客户端拒绝复用。`HarnessClientOptions.env` 给定时整体替换子进程环境（`undefined` 原样继承父进程环境）；凭据策略归调用方——`dsh-subprocess` 的 `scrubbedParentEnv` 是面向隔离启动的共享擦除基底。

<a id="native-user-questions"></a>
### 原生用户问答

向 `DeepSeekHarness` 或 `HarnessClient` 传入 `onUserQuestion`，即可通过原生 SDK 协议回答内建的 `ask_user_question` 工具。回调接收 `{ requestId, sessionId, questions }` 与 `{ signal }`；返回 `{ answers: [{ id, selected, custom? }] }`，每个问题 id 对应一项。也可返回 `{ cancelled: true }` 表示用户关闭问题。关闭计划审查会结束原生轮次，并保持计划模式。应用自行提供 UI 或模拟用户策略。SDK 在初始化时自动声明此回调，也能在其他请求待决时接收答案。`HarnessClient.initialize()` 会在需要时启动进程，无需显式调用 `start()`。

运行时取消问题、断开连接或客户端关闭时，应响应 signal 释放宿主工作。SDK 停止等待已取消的回调，并忽略晚到答案。回调抛错会报告提供方错误；缺失或格式错误的答案均不构成批准。未提供回调时，原生进程内回答方仍可用，缺少回答方则报告 `NO_PROVIDER`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释客户端背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

客户端是同一协议上的两层：`DeepSeekHarness`（自有运行）叠加在 `HarnessClient`（协议客户端）之上，与 Python SDK 的分层一致。两种 SDK 都通过公开 `run()` 接收提示词或命令，请求构造与响应校验保留在内部辅助函数中。它运行在任何 harness 上下文之外，因此直接 spawn 运行时而非经由 `dsh-subprocess` 服务——即该 seam 记录的 SDK 托管传输例外——其关闭阶梯也位于本包。运行时对上下文内每个会话都发通知；会话树范围限定是客户端对 `subagent.started` 血缘边的过滤。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/api.ts`](src/api.ts) | `DeepSeekHarness` + `HarnessSession`：统一输入路由、自有活动区间与命令结果 |
| [`src/client.ts`](src/client.ts) | `HarnessClient`：spawn、握手、请求、订阅扇出、类型化错误 |
| [`src/dispose.ts`](src/dispose.ts) | 私有关闭阶梯：stdin EOF → SIGTERM → SIGKILL 直到真正退出 |
| [`src/types.ts`](src/types.ts) | 启动与超时选项、通知、`RunResult` |
| [`src/index.ts`](src/index.ts) | 消费方接口：两层客户端与面向调用方的类型 |

### 自有活动流程

一次运行会订阅会话树、把提示词排入队列，等待提示词的消息 id 出现在持久的 `agent/inbox/spliced` 回执中，然后持续收集通知，直到整个 agent 报告 `idle`。`finalResponse` 从收集到的事件中最后一条 `assistant/message` 派生。传输丢失、超时与协议违例会使本次运行被拒绝；模型结果仍可在事件流中观察，但不会归属于某一输入。

### 错误与关闭

每种失败模式都映射到一个导出的错误类——协议错误响应、请求时限已到、响应超出文档化协议、运行时死亡——调用方可以按失败类型分支处理；这四个类从 [src/index.ts](src/index.ts) 导出。关闭采用私有的幂等阶梯（stdin EOF → SIGTERM → SIGKILL），位于 [src/dispose.ts](src/dispose.ts)，只在进程真正退出时结束。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当客户端约定不够用时阅读以下页面。它们从协议格式进入服务插件与使用本客户端的应用。

- [SDK 协议格式](../protocol/README.zh.md)——本客户端使用的 JSON-RPC 方法与载荷结构。
- [JSON-RPC 服务插件](../server/README.zh.md)——服务本客户端的运行时插件。
- [Python SDK](../../../python/README.zh.md) — 共享同一运行时对端与协议的设计孪生。
- [SDK subagent 后端](../../subagent/subagent-dsh-sdk/README.zh.md) — harness 内部消费本客户端的例子。
- [SDK 应用组合包](../../bundle/sdk-app/README.zh.md) — 本客户端启动的 `dsh --profile sdk` 运行时应用。

-----

<a id="model-experience"></a>
## 模型体验

无，因为这是客户端进程库；模型可见行为存在于所 spawn 运行时组合的插件中。

#### KV Cache 影响

客户端进程中无影响。子进程的 profile、patch、提供方、模型与历史决定缓存复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本客户端何时不合适或需要特别注意。它们是当前包约束，不是与其他 SDK 客户端的对比或任务积压。

- **无捆绑运行时解析**——客户端解析同版本 `@deepseek-ai/dsh` 包（或调用方提供的 `dshBin`）；打包可执行文件的发现留在 Python 侧，直到出现 TypeScript 发行版消费方。
- **无运行时取消请求**——RPC 超时或观察回调失败会结束本地等待，不会停止运行时工作。停止运行时工作需要关闭 harness（见[协议限制](../protocol/README.zh.md#known-limitations-and-deferred-work)）。
- **无独占模型响应**——提示词结果涵盖从回执到 idle 的活动，可能包含 steering 或其他排队工作。并发调用观察 Session 的实际事件流；命令结果不独占后续 turn。
- **回调必须释放自己的资源**——SDK 通过 `AbortSignal` 发出取消；忽略它的应用工作可能在 SDK 停止等待答案后继续运行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性——已交付的行为与限制见上文各节与代码。启动规格有意保持完全显式：在出现 TypeScript 发行版消费方之前，不计划做捆绑运行时解析。请让关闭阶梯与错误词汇与驱动同一运行时的 Python 客户端保持同步。没有记录其他未解决的开放设计问题。

</details>
