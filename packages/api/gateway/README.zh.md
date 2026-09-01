---
description: "带类型的 Client 到 Host 调用与 stream：分派、校验、取消、重连与转发的 Host 事件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-gateway

[English](README.md) | 中文

## 概述

为 Host 与 Client 两侧的 Cordis 环境提供 Typert RPC endpoint。Host 入口提供 `ctx.typertGateway`，`@deepseek-ai/dsh-api-gateway/client` 则提供 `ctx.remote`；两者使用同一份生成的 `InvocationDescriptor` 约定，并将业务选择交给 API Remotes。Connection 承载一元调用的请求关联、信任和响应 envelope，Gateway 则拥有多路复用的 Remote 流。

## 目录

- [Host 服务：`TypertGatewayService`（ctx key：`typertGateway`）](#host-service-typertgatewayservice-ctx-key-typertgateway)
- [Client 服务：`ClientRemote`（ctx key：`remote`）](#client-service-clientremote-ctx-key-remote)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="host-service-typertgatewayservice-ctx-key-typertgateway"></a>
## Host 服务：`TypertGatewayService`（ctx key：`typertGateway`）

每次调用时，`ctx.typertGateway.invoke()` 都会解析当前的描述符和 Cordis 服务，校验具名参数是否完全匹配，解析已注册的对象或 Context 身份标识，调用公开的业务方法，并校验其结果。业务服务继承 [`dsh-typert-protocol`](../../typert/protocol/README.zh.md) 的 `TypertRemoteService`，并用 `@Remote` 或 `@RemoteScope` 标记方法；已有其他基类时仍可改用 `bindTypertRemote()`。

严格模式从 `ctx.typert.local` 读取生成的调用描述符。查找参数使用 `ctx.typert.lookups` 中当前有效的 resolver：业务包注册稳定声明与默认策略，Host 组合可用 effect-scoped `configure()` 覆盖解析行为；`@RemoteScope` 则通过已注册的 Host Context adapter 解析其接收者。SRC 模式是开发阶段的回退路径，适用于从未具备严格定义的端点；它解析简单参数名，并且只允许非查找参数使用可安全表示为 JSON 的值。已观测到的严格定义一旦撤回，系统会直接报错，而不会降低校验强度。

Connection 可用时，Host 入口会在 Connection 共享的 `/api` FetchHandler 上注册 trusted-host interceptor。Connection 把这个复合 handler 交给 HTTP bridge；handler 将已认领 endpoint 分发给 Gateway，未认领且没有精确 Fetch 路由负责的请求返回 404。直接调用 `invoke()` 会保留业务错误；`TypertGatewayError` 是 `RemoteError` 的子类，其 `gateway/*` 码命名了分发、绑定、提供方、查找、Context、参数和编解码器各自负责的故障。因策略而拒绝的 resolver——冷恢复失败或 ownership fence——抛出自己的 `RemoteError`，它选定的码原样到达调用方。

支持取消的 Remote 方法会把 `signal: AbortSignal` 声明为最后一个 Host 参数。signal 是 descriptor 元数据，而不是 wire 参数：Connection 将它提供给 Gateway，Gateway 则在已解码的业务参数之后注入它。SRC 识别这个保留的末位参数名，严格生成还要求它具有全局 `AbortSignal` 类型。

流式 Remote 使用 `@Remote({ mode: 'stream' })` 并返回 `Iterable` 或 `AsyncIterable`。`ctx.typertGateway.stream()` 执行与一元调用相同的 endpoint、参数、lookup 和取消校验，再用生成的 result codec 校验每个产出项。Client 插件激活时打开 Gateway 自有的 `/api/remote.mux` WebSocket，并让它在空闲时保持连接。Connection 拥有重试调度；每次 retry 前，它要求 mux 取消候选或活动 socket，并且只做一次全新的物理连接尝试。Host 按配置的 `websocketHeartbeatIntervalMs` 间隔（默认 2 秒）发送 Ping 控制帧，浏览器在 WebSocket 协议层自动回复 Pong，使空闲网络中间层持续看到流量，而不新增 Remote stream frame。若 socket 尚未回复上一次 Ping，Host 会在下一间隔终止它。可独立取消的逻辑流共享这条连接；进程内 Connection 载体直接提供等价的流，不打开该 WebSocket。

Host 组合可通过 `registerRemoteEvents()` 注册唯一的应用事件 source。Gateway 为它保留内部 `$events` logical endpoint，只接受空 `args`，并在 source 撤回时中止该注册打开的 stream。事件名单、参数校验、每 Client 队列及 opening `{ type: 'ready', clientId, host: { home } }` frame 中的 Host home 由 API Remotes 拥有。source factory 在返回 iterable 前同步挂好增量 listener，因此 Client 只在增量投递就绪后发布 generation 并开始 baseline 读取。

<a id="client-service-clientremote-ctx-key-remote"></a>
## Client 服务：`ClientRemote`（ctx key：`remote`）

`ctx.remote.$mount()` 会校验并注册生成的 Host-for-Client 贡献项，然后为发起调用的 Cordis fiber 安装具体的直接方法和作用域方法。每个 namespace 都是可追踪的 `remote.<namespace>` 子 Service，并在最后一个方法撤回后卸载。重复端点、命名空间冲突，以及缺少生成的严格编解码器的描述符，都会在方法可调用前报错。

每次一元调用都会校验位置参数，构造与描述符完全匹配的具名 `args`，再通过 `ctx.connection.rpc.call('/api', endpoint, ...)` 发送。生成的流方法返回 `AsyncIterable`，并在进程内 Connection 载体可用时通过它打开逻辑流，否则通过共享的 Gateway WebSocket 打开。生成的支持取消的方法接受最后一个可选 `AbortSignal`；Client 会在调用载体前将它与贡献项的挂载生命周期合并。一元结果和每个流项都经过校验后才会交给应用代码。撤回贡献项会同时移除其描述符和方法、中止正在进行的调用与流，并使外部仍持有的方法句柄在调用时返回拒绝。

每次一元调用都解析为 `RemoteResult<T>`——`{ ok: true, value }` 或 `{ ok: false, error }`——且绝不因载体问题 reject：本面把断线载体折入错误分支，调用方 signal 中止时答以 `gateway/cancelled`，因此没有消费方需要包一层来兜载体失败。只有装配故障仍会 reject：参数个数不符、方法未挂载、贡献已撤下、缺少 Context adapter。`error` 是活的 `RemoteError` 实例，所以 `throw result.error` 保持 throw 语义；而 `isRemoteFailure(value)` 是消费方唯一需要的谓词——它认下的捕获值带着 Host 码，它拒绝的一律是本地故障，调用方应当让其崩掉。

`ctx.remote.$host` 以普通值读取固定的 Host 事实：`home`（首个 ready 帧之前为 undefined）与 `isLoopback`。它不是 store——没有订阅、没有代次计数——所以需要响应重连的消费方去监听 `connection/reset`，而不是轮询它。

`ctx.remote.$stream()` 返回跨越多个物理载体代次的单消费方 `RemoteStream`。Host 仍在线时，它允许一次立即重试；Host 离线时，它等待下一代连接，并为每个流项标注物理代次。领域消费方校验并接受各代次的 opening value；业务与协议错误仍然终止流。一切终态失败离开本面时都是 `RemoteError`，包括重试耗尽和在 opening value 之前就结束的代次，因此流消费方与一元调用方用同一种方式判别。`RemoteStreamCarrierError` 命名的是可重试的物理丢失，它只作为 `carrierFailed` 回调参数到达领域，绝不作为终态结果。`RemoteSnapshotStream` 在此之上规定每代由一个 opening snapshot 和后续 delta 组成。`RemoteJournalStream` 基于领域提供的 entry 闭区间提供 follow-before-page、分页、重连追赶与缺口修复；它丢弃完整重复项，并拒绝缺口、倒置区间和部分重叠。dispose 任一种 stream 都会取消其请求，并在活动 iterator 完全停止后完成。

`ctx.remote.$on()` 订阅一条被转发的 Host 事件。它的合法键恰好等于 Host 装配声明的转发选择，listener 类型就是事件所属包自己的 Cordis `Events` 声明，因此不存在会与之漂移的第二份签名。每个订阅归属调用方 fiber，并随该 fiber 一起消失。Client Remote 服务激活时就把 `$events` pump 注册为 Connection generation source，因此即使当前无 `$on` 订阅，它也会在 Connection 循环启动时打开。浏览器使用 Remote mux，进程内组合使用 `connection.rpc.open`；opening `ready` 项建立 Connection generation 并提供 Host 信息。物理 carrier 失败、Remote stream error、意外正常结束、非 ready 首项或畸形事件项都会终止该 generation，由 Connection 按有界且带抖动的指数退避重开。普通通知按注册顺序运行并隔离 listener 失败；Agent-scoped waterfall 允许 listener 返回结果、调用 `next()` 或拒绝，Gateway 再通过现有 HTTP 一元载体回送该结果。

`ctx.remote` 不暴露 Connection 生命周期控制。只有职责包含恢复的消费方才直接读取 `ctx.connection.state` 并调用 `ctx.connection.reconnect()`；普通 Remote 消费方仍只使用生成的 namespace 与 `$stream()`。[连接恢复决策](../../../.agents/notes/implemented/feature/2026-08-28-web-connection-recovery-control.zh.md)规定这项例外。

生成的声明合并通过共享的 `TypertClientRemote` 约定提供 TypeScript API。Client 入口不包含 Host 服务或 Host Cordis 接口合并；方法查找和调用使用普通对象与函数，而不使用 JavaScript Proxy。

<a id="model-experience"></a>
## 模型体验

无，因为该包分发应用调用，不注册任何提示词、工具或会话事件。

#### KV Cache 影响

无直接影响；被调用的业务服务负责产生任何模型可见结果。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- Connection 适配器对分发故障与未归类异常答以 `gateway/internal`，且不附带详细信息；拥有方或 Gateway 自己抛出的 `RemoteError` 带着自有码、message 与 details 过线。其 `cause` 链与 `TypertGatewayError` 子类身份只对同进程调用方留存。
- SRC 模式仅支持名称唯一的标识符参数，不支持解构、默认值或剩余参数。它只校验值能否安全表示为 JSON，不校验生成的业务类型，也绝不会推断可选字段。
- Client 侧只能挂载严格模式生成的贡献项。SRC 标记不具备 Client 编解码器或类型投影。
- `$stream()` 监督载体替换，但不推断回放语义；各领域自行拥有恢复 cursor 或替换 baseline 的校验，以及正常结束的分类。Connection generation 会重开内部 `$events`；单向通知不会重放，仍处于 pending 的 scoped waterfall 则沿用同一个 event id 重放。
- lookup resolver 按 key 配置；当前无法让单个 Remote 参数或 endpoint 在同一 `agent`/`session` key 下选择 live-only 策略。
- 被转发的事件到达 `$on` 时不做业务载荷投影或脱敏。普通通知在重连后不重放；Agent-scoped waterfall 只投影选择 Client Context 所需的顶层 Agent 身份，并自行携带 pending 生命周期。
- `websocketHeartbeatIntervalMs` 同时是 Ping 周期和 Pong 截止时间。对端未在下一周期前回复时，Host 会终止连接；如果部署的事件循环或网络可能停顿超过该间隔，必须调大此配置。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。Host 调用会重新读取权威的 Cordis 与 Typert 状态，Client 方法、描述与 `$on` 订阅则在同一个 effect 中完成变更。
