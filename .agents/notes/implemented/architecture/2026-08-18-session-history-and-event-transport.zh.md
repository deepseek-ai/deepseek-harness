# Agent Note: 会话历史、控制状态与 Remote 事件传输

Status: implemented

[English](2026-08-18-session-history-and-event-transport.md) | 中文

## 问题

浏览器同时消费三类生命周期不同的数据：可持久化并分页的 Session 日志、需要 opening baseline 才能在重连后收敛的进程内状态，以及无需重放的即时通知。

这三类数据不能共用一种恢复规则。Session 日志有稳定 seq 和 persistence，可以按 cursor 补齐缺口；queue、jobs、Workspace 列表等状态需要以完整 snapshot 替换旧镜像；普通通知只保证当前 Connection generation 内投递。

观察 Session 历史、列表和投影必须允许冷读取。若 transport 因参数中出现 Session 或 Agent 就触发通用 Typert lookup，打开页面、切换标签或网络重连都会隐式恢复 Agent，观察操作因此产生执行副作用。

prompt、create、fork、模型选择等命令又确实需要按各自语义创建或恢复 Agent。激活权限必须属于具体 Remote 方法，而不能由 carrier、参数类型或共享 lookup 暗中决定。

旧 API Proxy 的全 Session mux、`HostFrame` 与 Workspace 通知把领域数据、baseline、错误和连接生命周期编码进同一手写协议。每增加一种状态都要复制帧定义、Client bridge、重连和清理逻辑，API Proxy 也无法退回只承接尚未迁移的业务方法。

Host 向 Client 的 Cordis 事件还有两种调用语义。普通通知只需要广播；Approval 与 Question 一类 Agent-scoped waterfall 必须允许 Client claim、调用 `next()` 委托、返回结果或拒绝，并在多 Client、断线和取消下保持一次 Host 调用的身份。

这些需求需要一个通用 transport 生命周期，但不能让 Gateway 理解 Session、Workspace、Approval 或 Question 的业务数据。

## 决定

API Gateway 拥有 Remote transport、stream 生命周期和 Remote Event 协调；Session Controller 与 Workspace Controller 拥有各自的 Host API、wire 类型和 Client 领域 adapter；Client Runtime 只装配并消费这些对象，不再实现另一套 carrier 状态机。

当前所有权如下：

```text
[client/connection]
|-- Host description
|-- Connection generation
`-- unary RPC transport

[api/gateway/client]
|-- RemoteStream
|-- RemoteSnapshotStream
|-- RemoteJournalStream
`-- ctx.remote.$on + $events pump

[api/session-controller]
|-- ctx.remote.session unary commands
|-- session.control snapshot stream
|-- session.page + session.follow journal
`-- Session Client adapters

[api/workspace-controller]
|-- ctx.remote.workspace unary commands
|-- workspace.follow snapshot stream
`-- Workspace Client model and adapter

[api/remotes]
`-- application Remote Event allowlist and Host Cordis source

[client/runtime]
`-- compose Session and Workspace domain state for consumers
```

API Proxy 不拥有 Session 或 Workspace Remote namespace，也不拥有 Host 下行事件 carrier。`/api/events.host`、`HostFrame`、`stream/error`、`ServerRequest` 及其 WebSocket／SSE 分支不参与这条数据链路。

### Connection generation 与物理连接

浏览器的 Client Remote 插件激活时幂等启动 `RemoteStreamMuxClient`，并立即连接 `/api/remote.mux`。没有业务 logical stream 时物理 WebSocket 仍保持常驻，但 mux 不运行独立的 retry 调度。

Host 按配置的 `websocketHeartbeatIntervalMs` 间隔（默认 2 秒）向每条已打开的 mux socket 发送一个 RFC 6455 Ping 控制帧；浏览器在协议层回复 Pong。两种控制帧都不进入 Remote stream JSON union，也不改变 Connection generation 状态。每次 Ping 前，Host 把 socket 标记为等待 Pong；若到下一间隔仍未收到 Pong，Host 会终止该 socket。

首次建连失败或已连接 socket 丢失后，已打开的 logical stream 会以 `RemoteStreamCarrierError` 结束当前物理 generation。`ConnectionController` 拥有持续且间隔封顶的指数 retry 调度；每次尝试都要求 mux 恰好一次替换候选或活动 socket，再重开 `$events`。用户要求的重连通过同一路径重置 attempt 序列并跳过等待（见[决策](../feature/2026-08-28-web-connection-recovery-control.zh.md)）。

浏览器网络状态事件是同一 Controller 的输入。`offline` 会撤回 Connection generation 并暂停自动 retry；下一次 `online` 转换会从基础退避档重新开始。这些事件不会建立连接；只有新的 `$events` ready 帧才会发布 Connection generation。

进程内 `connection.rpc.open` 使用同一 logical endpoint 语义，但绕过浏览器 WebSocket mux。

Gateway 内部 `$events` logical stream 是 `ConnectionHandle` 唯一的 generation source。它不依赖是否已有业务 `$on` 订阅，因此连接健康状态不会随 UI listener 数量变化。

Host event source 在返回首帧前同步安装增量 listener。Gateway 随后发送 `{ type: 'ready', clientId, host: { home } }`；该 frame 证明当前 generation 已经能够接收增量，并携带稳定的 Host 路径显示信息。

`ConnectionController` 只有在 `$events` ready 后才发布 `connected`，所以 Session 或 Workspace baseline 不会在 Host 增量 listener 就绪前开始读取。

`$events` 正常意外结束、Host 错误、畸形首帧或 carrier 失败都会结束当前 Connection generation。Connection 撤回该 generation，随后按有界退避重新建立 `$events`；浏览器离线时暂停，用户要求立即重试时则跳过等待。

Gateway stream、Connection generation 与 Session 业务 open epoch 是三个独立计数：前者表示某条 logical stream 的物理替换，第二个表示 Host 可用性握手，最后一个防止已淘汰的 Session open 写回当前状态。

Host 插件销毁会停止心跳定时器、终止 mux socket，并等待活跃 iterator 完成。Client 插件销毁会停止重试等待，取消候选与活动 socket，终止 logical stream，并等待后台循环和 consumer 完全停稳。

### 通用 Remote stream 模型

Gateway Client 提供三个不依赖 React、只允许一个 consumer 的生命周期对象：

```text
RemoteStream<Item>
|-- RemoteSnapshotStream<Snapshot, Delta>
`-- RemoteJournalStream<Page, Entry, Cursor>
```

领域 Controller 通过组合或薄 adapter 使用它们；Session 与 Workspace 不继承一个知道领域帧的共同 Controller 基类。

#### `RemoteStream`

`ctx.remote.$stream(options)` 返回 `RemoteStream<Item>`，负责一个 logical stream 跨物理 generation 的重开、取消和 dispose。

每个 item 携带单调 generation、该 generation 的 `AbortSignal` 与 `accept()`。领域 consumer 只有在验证 opening cursor 或 baseline 后才调用 `accept()`。

只有 `RemoteStreamCarrierError` 可触发重试。Host 仍可用时允许一次独立重开；否则等待新的 Connection generation。业务错误、协议错误和 opening 失败直接终止。

`restart()` 只淘汰当前物理 generation，保留 logical stream；`dispose()` 永久结束 logical stream、pending retry 与 iterator，并等待 quiescence。

`RemoteStream` 不理解 baseline、delta、page、cursor、seq 或任何领域 frame。

#### `RemoteSnapshotStream`

`RemoteSnapshotStream<Snapshot, Delta>` 要求每个 generation 恰好以一份完整 snapshot 开始，之后只能出现 delta。

update 早于 snapshot 或同 generation 出现第二份 snapshot 都是 terminal protocol error。

snapshot 成功应用后才接受该 generation。carrier 重连期间保留上一份已发布状态，新 generation 的 snapshot 一次性替换旧镜像。

领域 adapter 提供 frame 判别、snapshot replacement、delta reducer、carrier 状态和 terminal failure sink；通用层不解析 Session 或 Workspace 字段。

Session control 与 Workspace state 各使用一个独立的 `RemoteSnapshotStream`。

#### `RemoteJournalStream`

`RemoteJournalStream<Page, Entry, Cursor>` 组合一个 live follow 与同 namespace 的 page 方法，适用于有稳定顺序、可分页历史和 live tail 的 append-only journal。

首次打开先建立 follow 并取得 opening cursor，再读取 initial page。page 请求期间产生的 live entries 已进入 follow 队列，因此不会落在“先读历史、后订阅”的竞态窗口中。

通用层按 cursor 去除 page 与 queued entries 的重叠，验证连续性，并在 page 覆盖 opening cursor 后发布一份完整 window。

连续 live entry 发布 `append`，更早的历史页发布 `prepend`。重连、cursor 跳跃或无法证明连续性时触发 tail page repair。

repair 期间旧 window 保持可读；page 与期间积累的 live entries 拼成连续窗口后只发布一次 `replace`，不会把半修复状态暴露给消费者。

若 page 请求随物理 carrier generation 一起取消，journal 等待下一 generation 的 opening cursor，再以新 cursor 重读 page；该取消不会作为 terminal page failure 泄漏给领域对象。

`RemoteJournalStream` 拥有 opening cursor、resume cursor、分页、重连 catch-up、重叠去重和 gap repair。领域 Session 对象不复制这些状态机。

### Session Controller

`packages/api/session-controller` 提供 Host `ctx.sessionController` 与生成的 `ctx.remote.session` namespace。

它拥有 Session list、search、create、selectModel、rename、fork、prompt、attachment、updateQueue、cancel、page、follow 与 control。Host generation 的 model catalog 通过独立的 `session/modelCatalog` 公开，因为它不属于特定 Session。

包内的 agent、commands、control、history 与 list controller 分开实现，但 Session 身份解析、激活策略、subagent ownership 和 Remote 错误投影只有一个公开 owner。

其他 Host Remote namespace 通过 `ctx.sessionController.inspect()` 或 `resolveAgent()` 复用同一身份规则，不保留第二份 Session resolver。

#### 激活策略

Session Remote 方法传递 `SessionId` 或 `SessionAddress`，不靠参数类型触发通用 Typert Session lookup。

每个方法显式选择冷检查、live-only 查找或允许 resume 的解析方式：

| 操作 | 无 live Agent 时的数据来源或结果 | 激活规则 |
|---|---|---|
| `session.list`、`search` | header 与投影缓存；可通过有界的小日志读取判断不确定的 blank 状态 | 永不恢复 Agent |
| `session.page(address)` | attached Session 或 persistence 日志 | 永不恢复 Agent |
| `session.follow(address)` | 一份携带 opening page 与 projection 的 live 或 prepared observation | 先发布 snapshot，再在后台把普通冷 Session 提升一次 |
| `session.control()` | 当前 attached Agent、pending registry 与进程内 registry | baseline 与重连不恢复 Agent |
| `session.attachment`、fork 源读取 | 已授权的持久 Session 数据 | 读取不恢复 Agent |
| `session.updateQueue`、`cancel` | 仅命中当前 live Agent | 不为已消失状态恢复 Agent |
| `models`、`selectModel`、`rename`、`prompt` | 命令解析目标 Session | 仅按方法约定显式恢复 |
| `create` 与 fork 目标 | 新 Session／Agent | 用户命令提供创建授权 |

读取 title、列表和投影不要求 Agent。观察操作不能因为另一个 Remote endpoint 使用了 Agent lookup 而继承其恢复权限。

`SessionQuery.observeSession()` 选择 attached Session，或从读取方自己的 prepared cache——经由持久化读句柄填充——提供冷 Session。该 cache 共享并发冷读取，并在所有 observation lease 释放前固定同一条目。一次 observation 要么计算所有已注册 projection，要么完全不计算；调用方可以只公开其中一部分，但不会建立只计算部分 projection 的中间状态。

`session.list` 不会无界扫描冷日志。它优先使用缓存的 projection hint，仅在独立存储 artifact 不超过配置的小日志字节上限时，才可能完整观察日志以判断不确定的 blank 状态。hint 缺失或不可读时，列表仍保留该行，并把 metadata 视为未知。

`model/selection` 是 required-on-read 的持久 event，因为它改变下一次请求使用的 model route。对应 projection 同时记录最近一次 request selection 与之后的 pending selection；prompt assembly 在提交匹配的 `request/header` 时消费 pending value。

#### Session 日志

`session.page` 返回一段按消息边界裁剪、内部 seq 连续的历史窗口。每个请求必须显式携带 `throughSeq`；该值来自对应 `session.follow` generation 的 opening cursor，并把本次读取固定在同一个日志切点。无 `beforeSeq` 的 tail page 必须精确结束于 `throughSeq`，其中 `-1` 表示空日志；`beforeSeq` 只选择该切点之前的更早页面，不能替代同步 cursor。`maxMessages` 限制 user／assistant 消息数，不丢弃这些消息之间的 chunk、tool 或状态事件。

tail page 同时携带不晚于 `throughSeq` 的 projection baseline；旧页只携带历史 entries。Client 以 projection watermark 合并 page 与后续 live control 更新。

普通 Session 与 direct subagent 使用同一个 `SessionAddress` 协议。direct subagent 地址同时携带父 Session、子 Session 与 mode，Host 冷读时验证持久 ownership 和 descriptor，不能只凭 child id 越权读取。

`session.follow` 在观察 attached 或 prepared Session 前先安装 `session/event` 与 `session/created` listener。

首次 follow 返回完整的 `{ type: 'snapshot', header, cursor, events, hasMore, projections }` frame。每次重连都发送另一份完整 snapshot replacement；协议不含 `afterSeq`。观察期间提交的 event 会保留在缓冲区，并在 snapshot 之后按 seq 发出。

普通冷 Session 可以立即发布 prepared snapshot。首帧之后，Controller 把 retained observation 交给一次后台 promotion；follow 不等待激活。Direct-subagent 地址不会进入该 promotion 路径。

Client 的 `SessionEventStream` 继承 `RemoteJournalStream`，只提供 `session.follow`、`session.page`、Session seq 算法与 repair request。通用层直接校验并发布 opening snapshot；仅在读取更早历史或后续 event 暴露 seq gap 时调用 `session.page({ throughSeq })`。

```text
ctx.remote.session.follow(address, pageArgs) ----------------|
  snapshot(header, cursor, page, projections), event*        |[]> SessionEventStream
ctx.remote.session.page(address, throughSeq, pageArgs) -------|    |-- replace(window)
                                                                  |-- prepend(history)
                                                                  `-- append(live entry)
```

每个 Client Session 只持有一个当前 `events: SessionEventStream | undefined`。只读 `SessionEventSource` 把已物化 event window 交给 Conversation consumer。

Session 的 `openGeneration` 只阻止被 resync、地址替换或 dispose 淘汰的异步结果写回；它不参与 transport retry。

initial page、repair page 或 follow 的 terminal failure 进入当前 Session 的 `openError`。旧业务 epoch 或旧 stream 的失败不能覆盖新状态。

#### Session live control

`session.control()` 是 Host 范围的 snapshot stream，一个浏览器可观察所有当前 live Session 的瞬态状态，而不必为每个 transcript 打开 journal。

每个 generation 先发完整 baseline，再发 queue、jobs 与 projection 增量帧。baseline 读取 attached Agent 和进程内 registry，不恢复冷 Agent。

queue 与 jobs 使用完整 replacement 值并按 last-wins 应用。Agent attach、detach、Session disposal 与 owner disposal 都能用空值或新 baseline 清除陈旧镜像。

原始 `approval/request` 与 `user-questions/request` 是可转发 waterfall。若某个 Agent-scoped Client listener claim，请求直接返回；若所有已投递 Client 都调用 `next()`，原 Cordis waterfall 继续到后续 Host listener。Session control 不保存或重放这些请求。

projection baseline 与 tail page 的日志切点独立产生，Client 总是保留较高 seq 的值。订阅 live projection 不会为取得值而启动 Agent。

Session added、removed、activity、running status 与无 turn 位置的 Agent error 不进入 stateful control stream；它们是可由列表 baseline 修复或无需重放的 `ctx.remote.$on` 通知。

Session 列表的 `updatedAt` 取 `max(header.createdAt, sessionListMetadata.lastPromptAt)`。`lastPromptAt` 只由用户来源的 `user/message` 更新，可从冷 projection 恢复，不依赖浏览器是否正在跟随该 Session。

### Workspace Controller

`packages/api/workspace-controller` 提供 Host `ctx.workspaceController` 与生成的 `ctx.remote.workspace` namespace。

它拥有 create、rename、delete、insertBefore、insertSessionBefore、archiveSession 与 `follow`。Workspace registry 仍是持久事实来源，Controller 负责 Remote 命令、投影和错误映射。

`WorkspaceFeed` 同步观察 storage `domain/changed`，并为每个 follow generation 先发送完整 baseline，再发送 `upsert`、`remove`、`order` 与 `archived` 增量。

完整 `order` frame 是 Workspace 排序的权威值。它避免 Client 根据 upsert 到达顺序猜测展示顺序，也能在重连 baseline 后收敛。

`createWorkspaceStateStream()` 把 `workspace.follow` 装配为 `RemoteSnapshotStream`。Client Runtime 只负责启动和持有该 stream。

`ClientWorkspaceModel` 位于 Workspace Controller 的 Client 面，拥有 baseline／increment 解析、已物化列表、归档集合、命令结果回显及 unary 与 stream 到达竞态的合并规则。

成功的 unary 命令可以立即更新本地模型；后到的 stream commit 仍以 Host projection 与完整 order 校正状态。已删除 Workspace 的 id 被记录，延迟结果不能把它重新插回列表。

```text
ctx.remote.workspace.follow() -|[]> RemoteSnapshotStream
                                      |-- replace(baseline)
                                      |-- upsert/remove(view)
                                      |-- replace(order)
                                      `-- replace(archived ids)
```

Workspace Remote 方法、状态 feed 和 Client 数据模型均不经过 API Proxy，也不依赖 `host/workspace-*` 通知。

### Remote Event

Remote Event 复用 owner 包的 Cordis `Events` 声明。Host 原事件是唯一业务签名，Client `ctx.remote.$on(event, listener)` 从同一声明推导参数、waterfall 结果与 `next()`。

`packages/api/remotes` 的 allowlist 是应用选择的唯一来源。每项显式标注 `emit` 或 `waterfall`，该 mode 同时决定 Host 监听方式、Client 合法键集和 wire frame 类型。

系统不声明 `RemoteInvocationMap`，不要求 Client 再写一份 `@Remote`，也不以最后一个运行时参数是否为函数来猜测调用模式。

Remote Event 下行帧是显式 discriminated union：

```text
ready     { type, clientId }
emit      { type, event, args }
waterfall { type, event, eventId, agentId, request }
cancel    { type, eventId }
```

WebSocket JSON 与进程内 carrier 的入口都从 `unknown` 开始按 `type` 和精确字段验证；验证完成后的分发只接收 typed union。TypeScript 静态类型不替代 wire 校验。

普通 `emit` 参数必须是无损 JSON。Client 在每个 Remote 实例私有的 Cordis key 上调用 `parallel()`，保留注册顺序、调用方 fiber 所有权和 listener 错误隔离。

私有 key 防止 Host 事件与 Client 本地同名 Cordis 事件互相触发。Client Remote 不维护自己的 subscription registry 或手写 listener chain。

可返回的 waterfall 当前只支持 Agent scope。事件签名必须是一个含直接 `agent` 字段的 request，加一个返回同类型结果的 `next()`，整体返回 Promise。

Host 只投影 request 一级的 `agent` 与 `signal`：`agent` 变为 frame 的一级 `agentId`，`signal` 成为 delivery lifetime，其余字段必须整体为无损 JSON。

Client 用 `agentId` 同步解析或物化 Agent Context，把当前 delivery signal 放回 request 的直接 `signal` 字段，再在目标 Context 的私有 key 上调用 Cordis `waterfall()`。Session-backed adapter 在首个成功 Session 列表 baseline 到达前允许 transport 先物化 scope；baseline 到达后由列表生命周期接管 scope 存活判断。

系统不扫描任意深度对象，不传 path array 或 placeholder，不 deep clone／restore Context 和 AbortSignal，也不等待未来出现的 Agent Context。

Client adapter 未注册、resolver 未返回 Context 或解析抛错时，本 Client 立即返回 `next`。它不订阅 registry、不做 resolve 后竞态复查，也不为一次 delivery 创建临时 Fiber。

Gateway Host 为每个未完成 waterfall 保存 `eventId`、Host continuation 与已投递 Client generation。新 Client generation 会收到同一 pending event 的重放。

每个 generation 的队列保证一次投递，因此 Client 不保存 `seen` 集合。`clientId + eventId` 绑定结果与当前 generation，旧连接的回包不能完成新连接上的 delivery。

多 Client 同时接收 waterfall 时，第一个 result 或 rejection 完成 Host 调用，并向其余 Client 发送 `cancel`。只有所有已投递 Client 都返回 `next` 时，Gateway 才继续原 Cordis chain。

Host caller signal 取消、Agent Context 释放、Client generation 结束和 losing-client cancellation 都会终止对应的等待。

Client 通过现有 HTTP unary RPC `$events/result` 回送 `next`、result 或 rejection；下行事件仍复用 Remote WebSocket mux，不为应答建立 duplex WebSocket。

Gateway 只验证 waterfall 返回值能无损表示为 JSON，不解释业务字段。Question 回答的 option 归属等语义由请求方或 UI 领域承担，transport 不重复校验。

`UserQuestionService` 在请求期间观察到调用方 `AbortSignal` 已取消、且 provider 抛出普通错误时，将其归一为 `UserQuestionError` 的 `ASK_ABORTED`，并把原错误保留为 `cause`；provider 已给出的领域错误保持不变。

`$events/result` 失败会令当前 Connection generation 失败。Host 随 generation 撤销该 Client 的 delivery，pending event 在下一 generation 重放，Client 不维护第二套结果重试队列。

普通 `$on` 通知在断线后不重放。凡正确性依赖恢复的数据必须有 query、cursor 或 opening baseline，不能依赖 Remote Event 恰好送达。

Client listener 晚于事件到达才注册时不补送；HMR 也没有专用补投语义。

### API Proxy 的剩余边界

Session Controller 与 Workspace Controller 直接提供生成 Remote namespace；API Remotes 与 API Gateway 直接提供 Host-to-Client 事件。

Client Connection 只维护 Host generation、description 与通用 RPC，不解析领域 frame。

Client Runtime 只接收 Controller adapter 产出的领域变更，不识别 `HostFrame`、`session/subscribed`、`session/event` mux frame 或 `host/workspace-*` frame。

API Proxy 只承接自身拥有的独立业务 API，不是 Session、Workspace、Remote Event 或 Connection generation 的依赖。

## 备选方案

**建立任意 Session stream 时自动恢复 Agent。** 这会让查看历史、读取 title、重连标签页或观察后台状态产生执行副作用，也会让多个浏览器触发重复恢复；冷日志和投影已有 persistence 来源。

**只允许 live Agent 使用 `session.follow`。** 这会迫使 transcript 首屏恢复 Agent，或重新引入 unary history 与 live subscription 之间的竞态；按 identity 先 follow 再冷读能同时覆盖历史和未来的显式激活。

**把 Session transport 与 Session commands 拆成两个公开包。** 两者共同依赖 Session address、Agent 激活策略、subagent ownership、错误映射和 Client 挂载顺序；一个公开 Controller 保持统一所有权，内部 class 仍可独立演化。

**把 queue、jobs、projection、Workspace 与日志都改成普通 `$on`。** 普通事件没有 reconnect baseline、cursor 或 gap repair，漏掉一次推送就会留下永久陈旧状态；只有无需恢复、可由独立查询修复，或以 waterfall 本身持有请求生命周期的通知适合 `$on`。

**让每个领域 Controller 继承一个 page／follow／retry 基类。** Session journal 与 Workspace snapshot 的 opening、恢复和排序规则不同；Gateway 的三个组合式 stream 对象复用 transport 生命周期，同时让领域 adapter 只声明自己的 frame 语义。

**给 Remote Event 新建一份 Client invocation 声明。** 第二张 map 或 Client `@Remote` 会复制 owner Cordis 事件签名并形成漂移点；从同一 `Events` 声明推导 `$on` listener 和结果类型可以构造性地保持一致。

**把 Agent scope 做成任意深度对象投影。** 递归扫描 Context 与 AbortSignal 需要 path、placeholder、clone 和 restore 协议，并把偶然对象结构升级成 wire 约定；一级 `agent` 与 `signal` 足以覆盖当前 waterfall。

**等待 Client Agent Context 或 adapter 后再分发。** registry waiter、竞态复查和临时 delivery Fiber 会为一个可同步解析或物化目标的 Client 增加额外生命周期；resolver 当下不能提供目标时立即 `next` 保持 Cordis waterfall 语义。

**给 Remote Event 使用独立物理 WebSocket 或 duplex stream。** Gateway mux 已提供认证升级、复用、取消、错误映射和重连；下行 `$events` 加上 HTTP `$events/result` 足以表达 request／response，不需要第三条连接。

**发送应用层 JSON 心跳帧。** 这会扩展严格的 Remote stream message union，并要求浏览器处理没有业务含义的流量。WebSocket Ping/Pong 无需改变 logical stream 语义即可保持 carrier 活跃。

**继续保留 API Proxy 的 Host mux。** 这会保留手写 union、schema、响应 envelope 和第二套 stream 生命周期，并使 Session 与 Workspace Controller 不能独立拥有自己的数据协议。

**从聚合 `session/event` 更新 Session 列表时间。** 列表正确性会依赖浏览器正在消费哪些 Session，并把任意插件事件误判为用户活跃；持久 `lastPromptAt` 投影直接表达排序事实。

## 验证

Gateway mux 测试固定无 logical stream 时建连、空闲常驻、每次请求只做一次物理尝试、可配置且不产生应用消息的 Ping/Pong、活动 stream carrier failure、取消和 dispose 后不再重连。

Connection 测试固定 generation source 缺失、重复注册、撤回、ready 超时，以及 generation 失败后的撤回和重建。

`RemoteStream` 测试固定单 consumer、opening acceptance 后清零 retry、`restart()` 只替换 generation、terminal error 不重试和 dispose quiescence。

`RemoteSnapshotStream` 测试固定每 generation 恰好一份 opening snapshot、update-before-snapshot 拒绝、重复 snapshot 拒绝和重连 replacement。

`RemoteJournalStream` 测试固定 snapshot-first opening、连续 append、历史 prepend、重连 replacement、gap repair 与一次性 replacement。

Session Host 测试固定 cold page／follow 不增加 attached Agent、显式 prompt 后 cold follow 收到连续事件、direct subagent ownership、message-aligned pagination 和终止错误投影。

Session control 测试固定 baseline-first、冷 Session 不恢复、attach／detach 清理、queue 与 jobs replacement，以及 projection watermark。

Session Client 测试固定每 Session 单一 journal owner、旧 open epoch 不写回、control 与 journal 独立取消，以及 carrier retry 期间保留已发布窗口。

Workspace Host 测试固定 baseline-first、upsert／remove、权威 order、archived set 和 follower disposal。

Workspace Client 测试固定 snapshot replacement、unary／stream 竞态、删除不复活、稳定排序和 terminal failure。

Remote Event 类型测试拒绝未选择事件、非 void 的 unscoped 事件、非 Agent-scoped waterfall 和签名不匹配的 mode。

Remote Event Host 测试固定 listener-before-ready、payload 校验、pending replay、多 Client first-result、all-next delegation、rejection、Host cancellation、Context release 和 losing-client cancel。

Remote Event Client 测试固定实例私有 key、Cordis 注册顺序、Agent Context 解析、`next`、result、rejection、cancel、旧 generation 回包拒绝和 `$events/result` 失败导致 generation 结束；User Question 测试固定进行中 signal 取消的错误归一化及 cause 保留。

缺失 source、重复 source、撤回 source、非 ready 首项、未知 discriminant、额外字段与非 JSON 值都在各自 wire 入口响亮失败。

静态检查固定 API Proxy 不再导出 Session／Workspace Host frame carrier，Client Runtime 不再包含对应 bridge。

## 后果

浏览器可以在 Agent 停止时读取持久 Session。打开普通 Session 时先发布 prepared snapshot，再开始一次后台 promotion；list、search、page 及其他只读 observation 不会激活 Agent。

持久日志用 seq 与 page 修复缺失后缀；Session control 和 Workspace state 用 opening snapshot 收敛；普通 Remote Event 不承诺重放。恢复语义由数据类型决定，不再互相模拟。

Gateway 只拥有 transport、generation、pending waterfall 和严格 wire 校验，不拥有 Session 或 Workspace 业务字段。领域 Controller 只提供 opener、cursor 规则、baseline reducer 和错误呈现。

每条常驻浏览器连接会按配置间隔增加一次空载荷 Ping/Pong 交换。面对更严格的空闲超时，部署方可缩短间隔，而无需改变 Remote stream 协议或浏览器代码。

Session 与 Workspace 的 Host API、stream adapter 和 Client 数据模型各有明确 owner；API Proxy 不再是它们之间的中介。

通用 stream 对象增加了三个明确层级，但删除了每个 Controller 各自复制的 retry、cancel、generation、baseline 和 gap-repair 外壳。

Remote waterfall 保留多 Client 首个 claim、全体 `next` 后继续 Host chain、断线重放 pending 和端到端取消；代价是当前协议只支持一级 Agent scope 与无损 JSON 请求／结果。

本决定扩展[Remote 事件投递](2026-08-10-remote-event-delivery.zh.md)的 allowlist 与单一 Cordis 签名设计：普通通知继续使用 `emit`，Agent-scoped async waterfall 使用同一 `ctx.remote.$on` 面和显式 `waterfall` mode；不建立第二套 invocation map。

本决定接管[简单一元 API Proxy 迁移](2026-08-10-unary-apiproxy-remote-migration.zh.md)中保留的 Session、Workspace 与 Host event carrier，并保留[后台任务展示](../feature/2026-08-08-web-background-job-display.zh.md)所要求的完整 jobs snapshot、进程内生命周期和“观察不恢复 Agent”语义。
