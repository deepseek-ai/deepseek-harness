---
description: "面向客户端与服务端实现者的 SDK 协议格式说明：Harness 运行时与其 SDK 客户端之间使用的按换行分帧 JSON-RPC 传输，以及具名的请求、结果与通知类型。"
kind: "package-library"
---

# @deepseek-ai/dsh-sdk-protocol

[English](README.md) | 中文

## 概述

`dsh-sdk-protocol` 让 DeepSeek Harness 运行时与其 SDK 客户端通过按换行分帧的字节流交换 JSON-RPC 2.0 消息：一个传输类，加上协议两端共同使用的具名请求、结果与通知类型。服务端是 [`dsh-sdk-jsonrpc-server`](../server/README.zh.md) 插件；客户端是 TypeScript 的 [`dsh-sdk-client`](../client/README.zh.md) 与 [Python SDK](../../../python/README.zh.md)（后者复现这些结构但不导入它们）。当你实现或调试协议某一端时使用本包：分帧规则、方法名、载荷类型与错误语义都在这里。它是纯库——无插件、无配置、无注册。

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

当你构建或调试 SDK 协议端——服务插件、客户端库或说该协议的自定义工具——时使用本包。它为你提供一个在调用方持有的字节流上承载 JSON-RPC 2.0 的传输，以及每个 SDK 方法与通知的类型化结构。

### 分帧与传输

在你拥有的字节流上，每个 `\n` 结尾的行承载一条 JSON-RPC 2.0 消息。同时带 `id` 与 `method` 的帧是请求，仅 `id` 是响应，仅 `method` 是通知；格式错误的行会被忽略。没有注册处理器的请求应答 `-32601`，处理器失败应答 `-32603`，错误响应会以 `JsonRpcResponseError` 拒绝挂起的请求，并保留协议中的 `code` 与可选 `data`。`start()` 挂接流监听器，`close()` 移除监听器并拒绝挂起请求，但不销毁流。

### SDK 方法

两个协议端共享同一套方法：三个客户端到服务端请求与四个服务端到客户端通知。

| 方向 | 方法 | 载荷类型 |
|---|---|---|
| client→server | `initialize` | `InitializeParams` → `InitializeResult` |
| client→server | `session/prompt` | `SessionPromptParams` → `SessionPromptResult`（持久入队回执） |
| client→server | `shutdown` | 无参数 → `{}` |
| server→client | `session.event` | `SessionEventNotification`（运行时内每个会话，不过滤） |
| server→client | `session.status` | `SessionStatusNotification`（整个 agent 的 `running`/`idle` 转换） |
| server→client | `subagent.started` | `SubagentStartedNotification` |
| server→client | `subagent.finished` | `SubagentFinishedNotification`（仅进程内运行） |

`HarnessSdkRequestMap` 与 `HarnessSdkNotificationMap` 按方法名索引这些结构；包根与传输一起导出它们。

### 载荷语义

`SessionPromptResult.messageId` 标识已排队的用户消息；它不标识后续的助手消息、轮次结束或提示词结果。`SdkPromptContentBlock` 接受普通持久内容以及 `SdkEncodedImageBlock { type: "image", data, mimeType }`；服务器在入队前把编码图像转换为持久引用。`InitializeParams.reasoningEffort` 是所选提供方／模型路由可选的非空适配器自有标识符；省略时保留该模型的默认值。`InitializeParams.maxTokens` 是可选的正安全整数，用于限制 SDK 创建的 agent 及其进程内后代的每次对话模型输出；省略时应用所选适配器的确切模型默认值。服务器会在初始化期间解析确切路由，并在握手成功前拒绝 `session/prompt`，因此缺少适配器、模型不可用或推理强度不受支持时，不会回退到构造期默认值。`SubagentFinishedNotification.lastAssistantMessage` 携带子 agent 最后一条非空 assistant 消息；若不存在这类消息，则携带其累积的 assistant 文本；子 agent 两种输出均未产生时，该字段缺省。`serverInfo.name` 的协议值固定为 `deepseek-harness-sdk-runtime`。通知载荷依赖 `SessionEvent`（`dsh-session`）、`ContentBlock`（`dsh-llm`）与 `SubagentStopReason`（`dsh-subagent`），因此会话词汇是协议格式约定的一部分。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释协议库背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本包建立在一个分离之上：两个协议端共用一个按换行分帧的传输类，以及按方法索引协议类型的具名类型。包根是唯一的导入面——源模块不支持深层导入。它是没有插件、配置或注册的纯库；服务插件与客户端负责其周围的一切行为。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/transport.ts`](src/transport.ts) | `JsonRpcLineTransport`：行分帧、请求/响应/通知分发、错误映射、挂起请求记账 |
| [`src/types.ts`](src/types.ts) | 具名请求/结果与通知载荷类型，按方法索引 |
| [`src/index.ts`](src/index.ts) | 消费方接口：传输与具名协议类型 |
| — | 不发布运行时不变式伴生入口；纯协议库不持有事件流。 |

### 帧分发

入站行逐条解析：带 `id` 与 `method` 的帧通过请求处理器应答（或应答 `-32601`），仅 `id` 的帧结算匹配的挂起请求（错误帧以 `JsonRpcResponseError` 拒绝它），仅 `method` 的帧交给通知处理器。`start()` 挂接输入监听器；`close()` 移除它们并在不销毁流的情况下失败所有挂起请求。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当协议约定不够用时阅读以下页面。它们从服务插件进入客户端与可运行应用。

- [JSON-RPC 服务插件](../server/README.zh.md) — 通过 stdio 服务该协议的运行时插件。
- [TypeScript SDK 客户端](../client/README.zh.md) — 驱动该协议的客户端。
- [Python SDK](../../../python/README.zh.md) — 复现这些结构的 Python 对侧实现。
- [SDK 应用组合包](../../bundle/sdk-app/README.zh.md) — 启动服务器的 `dsh --profile sdk` 应用。

-----

<a id="model-experience"></a>
## 模型体验

无，因为这是面向客户端的协议库；模型可见行为归对外服务入口后方的运行时插件所有。

#### KV Cache 影响

无；此包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明协议未覆盖或未承诺的内容。它们是当前包约束，不是与其他协议格式的对比或任务积压。

- **无协议版本协商**——握手只携带 `serverInfo.version`（`0.0.1`，客户端不校验）；处于预发布阶段，无兼容承诺。
- **无取消与会话关闭方法**——客户端放弃轮次的方式是关闭运行时进程；见 [JSON-RPC 服务插件](../server/README.zh.md)。
- **server→client 请求是未使用的功能**——传输层支持，但服务器从不发送；Python SDK 的应答接口为未来审批流程预留。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性——已交付的行为与限制见上文各节与代码。本协议的各个结构由 Python SDK 复现（而非导入），因此在这里更改方法、载荷或协议稳定值 `serverInfo.name` 时，必须在同一次变更中更新 Python 对侧与 TypeScript 客户端。没有记录其他未解决的开放设计问题。

</details>
