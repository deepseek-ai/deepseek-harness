---
description: "面向让进程外 SDK 客户端在 DeepSeek Harness 运行时中打开会话并驱动 agent 的部署的 stdio JSON-RPC 服务插件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-sdk-jsonrpc-server

[English](README.md) | 中文

## 概述

`dsh-sdk-jsonrpc-server` 通过 stdio 服务 SDK 协议格式，使进程外客户端能够驱动 harness agent（智能体）：它为每个 `sessionId` 打开一个会话、把用户提示词排入队列，并把每个会话事件与 agent 状态转换实时流回客户端。把它作为 `jsonrpc` 插件挂载到 Loader 组合中；外围插件树提供其余一切——agent、模型适配器、持久化与工具。Stdout 只承载 JSON-RPC 帧，因此部署不得组合 stdout logger。它通过 dispose（资源释放）根运行时并以 0 退出应答 `shutdown`；EOF 与信号退出归 app bin 负责。

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

当运行时必须服务 SDK 客户端时挂载本插件：把它加入组合了 agent 服务的 `cordis.yml`，启动运行时，客户端即可通过 stdio 连接。常用路径是显式的——插件需要 `agents` 服务；其余每个能力都来自外围插件树。

### 组装

插件在首次使用时为每个 `sessionId` 创建一个 agent。已注册的模型适配器赢得路由；尚无适配器负责的 `deepseek-official` 路由会挂载 DeepSeek 适配器，任何其他尚无适配器负责的提供方都会导致初始化失败。初始化成功前，所选适配器会解析确切模型与可选推理强度。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxTokensAsSuccess` | `false` | 把 max-token 轮次/subagent 终止报告为成功的 SDK 结果 |

profile 组合拥有每个根 agent 的工具。`input`、`output` 与 `exit` 是仅供测试的运行时传输钩子；生产环境使用进程 stdio 与 `process.exit`。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-sdk-jsonrpc-server)是每个受支持字段的穷尽式真源。

### stdout 即协议

Stdout 只承载 JSON-RPC 帧，客户端可以逐字节解析；诊断信息应写入 stderr。请勿在组合的插件树中加入 stdout logger。

### SDK 客户端可以做什么

`initialize` 是运行时就绪边界：服务器由 Loader 组合挂载时，会等待当前插件树完成所有加载任务后再响应，因此首次提示词能够看到 MCP 初始工具发现等异步同级能力。握手返回协议稳定标识 `deepseek-harness-sdk-runtime`。服务器会通过所选适配器校验提供方／模型路由与可选的非空 `reasoningEffort`，再保存这些值；省略时不会保存推理强度，因此模型保留自身默认值。可选的正整数 `maxTokens` 会成为每个 SDK 创建的 agent 及其进程内后代的请求输出上限，省略时则应用所选适配器或提供方路由的默认值。JSON-RPC 请求可能并发分派，因此在一次 `initialize` 成功完成之前，`session/prompt` 会拒绝；客户端必须等待握手完成后再发送提示词。已接受的提示词会把一条带标识的用户消息排入队列，并立即返回 `{ messageId }`；服务器随后把每个持久事实作为 `session.event`、把整个 agent 生命周期的每次状态转换作为 `session.status` 流式发出。它不会把某条助手消息或 `turn/end` 归属于某个提示词，同一会话上的独立请求可以继续排入更多工作。持久化根目录与 persona 来自外围组合。

### 关闭与退出

插件应答 `shutdown`，刷新响应并 dispose 根上下文，使 SDK 持有的 agent、订阅与持久化达到完全停稳，然后以 0 退出。EOF 与信号退出归 app bin 负责，后者也会 dispose 根上下文。仅卸载此插件会停止服务，但不会退出进程。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务插件背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本插件是薄薄的展示适配器：[`HarnessSdkJsonRpcServer`](src/server.ts) 负责协议方法与通知，传输与具名协议类型来自 `dsh-sdk-protocol`，与客户端 SDK 共享。它订阅会话、agent 与 subagent 生命周期事件，并把它们作为协议通知转发；只有当服务在生命周期建立快照时记录的 `local` 标志为 true 时才转发 subagent 完成事件——提供方名称、子级 id 与持久化谱系均不能证明本地性。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、stdio 接线、请求分发、共享关闭/退出任务 |
| [`src/server.ts`](src/server.ts) | `HarnessSdkJsonRpcServer`：协议方法、逐会话 agent 创建、生命周期订阅、清理 |
| — | 不发布运行时不变式伴生入口；边界与回放测试覆盖协议映射。 |

### 请求流程

每个协议方法在行动前都会校验输入并解析其拥有的状态——`initialize` 保存 SDK 路由，`session/prompt` 解析存活的 agent+会话对并排入消息，`shutdown` 在刷新响应并以 0 退出前把服务器持有的状态 dispose 到完全停稳——共享退出任务确保竞争的 shutdown 请求绝不会重复 dispose 或退出。分发逻辑位于 [src/index.ts](src/index.ts) 与 [src/server.ts](src/server.ts)。

### 清理

`server.shutdown()` 只 dispose 服务器自身持有的内容——仅卸载本插件时，外围上下文保持运行。协议 `shutdown` 则 dispose 根 fiber，使持久化与整个运行时在进程退出前达到完全停稳。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当插件约定不够用时阅读以下页面。它们从协议格式进入客户端与可运行应用。

- [SDK 协议格式](../protocol/README.zh.md) — 本插件服务的协议方法与载荷结构。
- [TypeScript SDK 客户端](../client/README.zh.md) — 驱动本插件的客户端。
- [SDK 应用组合包](../../bundle/sdk-app/README.zh.md) — 启动本插件的 `dsh --profile sdk` 应用。
- [Python SDK](../../../python/README.zh.md) — 驱动同一服务器的 Python 客户端。
- [SDK 运行时分发决策](../../../.agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.zh.md) — 打包运行时为何服务封闭插件树。

-----

<a id="model-experience"></a>
## 模型体验

### SDK 用户消息

#### 模型看到什么

对于每个已接受的 `session/prompt`，文本和持久内容引用会原样进入一条用户消息。内联 `SdkEncodedImageBlock` 会先通过组合中的附件存储完成校验与提交，因此会话日志保留内容寻址的图片引用而不是 base64 字节。此包不会添加系统提示词文本或工具 schema；这些内容来自组合中的其他插件。

#### Token 影响

依数据而定的用户消息 token 会进入保留的会话历史，并在后续轮次中重复发送，直至另一个包将其压缩（compaction）。JSON-RPC 帧、会话通知与服务器内部记录不会增加模型上下文 token。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本插件何时需要特别的运维注意。它们是当前包约束，不是与其他服务方式的对比或任务积压。

- **协议没有逐会话关闭或提示词取消方法**——SDK 创建的 agent 会一直存活到进程关闭。
- **没有逐提示词结果**——`MessageId` 只标识 inbox 准入；拥有自动化活动区间的客户端必须自行定义并观察该区间。
- **stdout 纯净性由部署保证**——外围配置仍可能加载 stdout logger 并破坏 JSON-RPC 通道；此插件不会检查或否决同级 logger。
- **自动挂载适配器仅支持 DeepSeek**——`initialize` 可以复用任何预先注册的模型适配器，但唯一的回退行为是挂载 DeepSeek 适配器。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性——已交付的行为与限制见上文各节与代码。单文件可执行运行时分发将本插件与打包的 `jsonrpc-demo` bin 配对；请让关闭/退出约定与负责 EOF 和信号退出的 app bin 保持一致。没有记录其他未解决的开放设计问题。

</details>
