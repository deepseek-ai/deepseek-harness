# Agent Note: Cordis 运行时树检查

Status: implemented
Archived: 2026-09-04

[English](2026-08-24-cordis-runtime-tree-inspection.md) | 中文

## Problem

Inspector 需要在 Chrome DevTools Elements 中把每个 Host 和 Client Cordis 运行时呈现为一棵树。在 Elements 中选中的 Cordis Context 或 Fiber 也必须表现为实时 Runtime 对象，而 Console 中打印出的 Cordis 对象必须能定位回同一个语义节点。CDP id 不能成为源模型：`NodeId`、`BackendNodeId` 与 `RemoteObjectId` 的 owner 和生命周期不同，并且未来面向模型的运行时查询必须使用同一份 Cordis 数据，而不是再反向解析 CDP。

Host 与 Client 在不同 JavaScript realm 中运行相同的 Cordis 抽象。因此，树发现与分类必须只有一份浏览器安全实现；对象解析仍留在各自 realm 内，跨 MessagePort 或 WebSocket 只传递不透明引用。

## Decision

Inspector 使用一套序列化 Cordis 树模型，并把 CDP 作为它的一个适配器。包内分离实时对象发现、不可变快照、Worker 存储与消费方：

现有的[跨 realm Inspector 决策](../../implemented/architecture/2026-08-23-cross-realm-cdp-inspector.zh.md)负责 Worker、source carrier、Runtime 路由与安全模型；本 Note 只负责 Cordis 语义数据及其消费方。

```text
Host Context/Fiber ─┐
                    ├─ CordisTreeCollector ─ CordisTreeSnapshot ─ source transport ─ CordisTreeStore ─┬─ CDP DOM adapter
Client Context/Fiber┘                                                                                 └─ future model adapter
```

`CordisTreeCollector` 及其身份注册表是浏览器安全模块，同时编入包的两个运行面。Host 与 Client 针对各自的 `ctx.root` 实例化同一份代码；任何一侧都不维护第二套分类实现。

## Cordis tree model

`CordisTreeSnapshot` 是与 CDP 无关的无损 JSON 值，包含 schema 版本、单调递增 revision、对象注册表 id、截断标志和一棵以 Context 为根的嵌套树。Context 节点包含不透明 object handle 与有序的 Context/Fiber children。Fiber 节点包含 Cordis `uid`、不透明 object handle，以及唯一一个表示 `fiber.ctx` 的 Context child。Host 与 Client 发布同一种 realm-tree 类型。生成的 Context id、插件 metadata、服务数据、任意属性值与对象 preview 都不进入树。

inspection tree 从 root Context 开始，不包含 Cordis root Fiber。对其他每个插件，其 parent Context 包含 Fiber，该 Fiber 再包含它拥有的 Context。通过 `extend()`、`isolate()` 或 `intercept()` 创建且未创建新 Fiber 的 Context 仍是直接 Context 子节点。嵌套结构无需生成 node id 即可表达 parent，并保留两类对象身份，同时避免把 `Fiber.ctx` / `Context.fiber` 环写入序列化树。

collector 从 root、注册表中的每个 live Fiber，以及每个 event hook 的 owner Context 开始。它沿 Context prototype 链回溯到被检查的 root，解开 Cordis shadow Context，按对象身份去重，并排除已 dispose 的 Fiber。`internal/plugin` 与 `internal/status` 事件调度一次 microtask 合并后的 replacement snapshot。节点数和编码字节数限制会移除完整的尾部 branch，因此每个保留节点仍有 parent，每个保留 Fiber 仍有其 owned Context。

## Identity and lifetime

各类身份刻意保持独立：

- Fiber `uid` 来自 Cordis。Context 当前没有 Cordis 自有 id，Inspector 不会暴露一个生成值来替代。
- `InspectorObjectReference` 是 realm 本地的不透明 handle，用于把树节点解析成实时 Context 或 Fiber。snapshot 携带该 handle 只为完成路由，不把它当成语义 id 或 DOM attribute。
- `BackendNodeId` 由 Worker 为一条保留的 `(source id, source generation, object reference)` 分配，并在该 generation 的 snapshot 被保留期间由所有 DevTools 连接共享。
- `NodeId` 在节点进入某个 frontend document 时按 DevTools 连接分配；对应 backend node 被保留期间保持稳定，并在节点离开树、少见的整 document fallback 或连接关闭时丢弃。
- `RemoteObjectId` 在 `DOM.resolveNode` 暴露实时对象时由选定的 Runtime session 分配；它只属于该 DevTools 连接和 object group。

`sourceId` 标识一个浏览器 tab 的 Client runtime，并保存在该 tab 的 `sessionStorage` 中，因此自动重连 transport 与页面刷新都会复用它。Client 在打开 transport 前会在 Web Locks 可用时独占该 id，直至页面结束；从同一存储状态复制出的另一个同时存活 tab 无法取得该锁，因而会持久化一个新 id。缺少 Web Locks 的浏览器仍保留基于存储的刷新身份，但无法仲裁复制出的 live tab。`generation` 标识一次 WebSocket 接纳且每次都会轮换。断联通过 `Runtime.executionContextDestroyed` 从 Console 移除 synthetic context。重连会发布新的 CDP execution-context id，因为已销毁的 id 及其 RemoteObject 不能复用；这并不表示浏览器底层 JavaScript realm 被重新创建。

标准 CDP 不会在 `DOM.Node` 上放置 `RemoteObjectId` 字段。`DOM.Node` 携带 `nodeId` 与 `backendNodeId`；`DOM.resolveNode` 返回对应的 `Runtime.RemoteObject`，`DOM.requestNode` 执行反向映射。实现会关联这三类 CDP 身份，而不添加非标准 DOM 字段。

## Realm object bridge

每个 collector 都在私有 global symbol 下注册一个 realm 本地对象表。该表把不透明 handle 映射到实时对象，并能按身份识别当前保留的对象。替换快照时会移除新树中不存在的 handle；dispose observer 时注销该表。

对 Host 节点，Worker 使用该 DevTools 连接私有的 `node:inspector.Session` 在 Host 对象表中执行查询，从而生成原生 V8 `RemoteObjectId`。对 Client 节点，Worker 通过已有的类型化 Client Runtime channel 路由同一查询，再把返回的 Client handle 映射为连接本地 CDP object id。实时对象和引擎 object id 都不会穿过 source transport。

Client Runtime value 携带一个可选、已验证的 `InspectorObjectReference`，Host Runtime value 则通过原生 V8 object id 探测。公共 CDP adapter 把已识别的 evaluation result、property、exception、Console argument 和 paused-frame object 改成 `subtype: "node"`，记录 object-id 到 backend-node 的关系，并提供 Cordis element description。这样两个方向都成立：Elements 可以暴露实时对象，Console 中返回或打印的 Context 与 Fiber 也能定位到 Elements。

## Worker repository and updates

source 把 Cordis 树作为保留状态发布，而不是事件历史。Host MessagePort 与 Client WebSocket publisher 保留最新状态记录，并在接纳、重连或收到 resnapshot 请求后把它放入 `source/replace`。实时 replacement 仍走普通的有序 append 路径。Worker 在原子替换旧树前验证 snapshot 的精确字段、节点数与深度限制、object handle 与 Fiber uid 唯一性、Context root，以及每个 Fiber 恰好拥有一个 Context child。

`CordisTreeStore` 只拥有已验证 realm snapshot 和 source 生命周期。内部 reader 为 Runtime 与 DOM 保留 live object route；公共 reader 则投影一棵不含 transport 或 CDP id 的 detached `{ host, clients }` tree。Host 与 Client 的 `ctx.inspector.cordis.getTree()` 通过同一套关联查询协议读取同一个 Worker reader，不创建 CDP session。`CordisDomBackend` 增加 Worker 全局 backend id，每个 `CordisDomSession` 则拥有 frontend node id、搜索、enable 状态和 RemoteObject 关联。模型 adapter 可以消费公共 reader，而不依赖 DOM 序列化或 debugger activation。

source 关闭时，存储的树从 connected 变为 disconnected，而不是删除最后一份 snapshot。对象查询会排除 disconnected 树，因此 snapshot 仍可作为数据检查，但不会保留或复活实时 Context、Fiber 或 Runtime object。同一 source id 的新 transport generation 提交 replacement 后，会原子恢复 connected 状态。可配置的 disconnected tree 数量上限会淘汰最早保留的 snapshot。

每个被接受的 source snapshot 都会重建 connection-neutral document，并按稳定的 backend node identity 比较差异。只改变 revision 的 replacement 不发送 DOM event；子节点增删使用 `DOM.childNodeInserted` 与 `DOM.childNodeRemoved`，attribute 变化使用对应 DOM event，兄弟节点重排只对该 parent 使用 `DOM.setChildNodes`。只有同一 backend identity 被复用为不同 node kind 时才回退到 `DOM.documentUpdated`。断联只会使 object route 失效，不改变保留的 DOM tree，因此保留展开与选择；达到保留上限时只移除被淘汰的 `<client>` 节点。

## CDP projection

synthetic document 包含一个 `<host>` container 和一个 `<clients>` container。`<host>` 包含 Host root Context；`<clients>` 为每个 Client source 包含一个 `<client>`，每个 `<client>` 再包含该 realm 的 root Context。这些结构 element 没有 Runtime object 或 attribute。Context element 没有 attribute。Fiber element 只暴露从 Cordis 原样复制的 `uid`。connected Context 与 Fiber 可以解析为 live RemoteObject；disconnected snapshot 保留 DOM node，但对象解析失败。

标准 CDP 没有可由 backend 控制、用于普通 Elements 树节点的 frozen、locked 或 dimmed 状态。Chromium 的 detached-node 展示只存在于 Memory 面板的 `DOM.getDetachedDomNodes` 流程，并由 frontend 本地设置。在展示方式明确前，不增加 connection-state attribute 或非标准 `DOM.Node` 字段。

只读适配器实现 document 获取、子节点请求、节点描述、属性、outer HTML、搜索、backend-id push、节点解析和对象反向查询。修改型 DOM 方法明确失败。layout、CSS、accessibility 与浏览器 DOM geometry 不属于这棵语义树；仅在 Chrome DevTools 需要兼容响应时返回空结果或 unsupported。

## Alternatives considered

**在每个 realm 直接构建 CDP DOM node。** 拒绝，因为 Host 与 Client 会重复分类，frontend id 会泄漏进 source 协议，模型消费方还必须把展示协议反向解析成 Cordis 概念。

**把实时对象或 V8 object id 发送给 Worker。** 拒绝，因为 structured clone 与 JSON 无法保留身份或行为，而且引擎 object id 只属于一个 inspector session。

**由 Inspector 生成 Context id。** 拒绝，因为 Cordis Context 没有自身 id，展示适配器不能把实现 key 伪装成框架身份。嵌套 children 表达 parent，不透明 object handle 只作为路由数据。

**Fiber uid、backend node 与 frontend node 共用一个 id。** 拒绝，因为 source 重连、多条 DevTools 连接、document refresh 与 Runtime object release 的生命周期彼此独立。

**只暴露 Context，并把每个 Fiber 拥有的 Context 当成 Fiber。** 拒绝，因为这会丢失两类实时对象中的一类，使 Console 身份产生歧义，并让后续 Fiber 专属属性失去稳定 owner。

**把模型访问 API 放在 CDP 适配器上。** 拒绝，因为模型访问会继承 Chrome 专用 node 序列化、逐连接 id 和 enable 状态。Worker repository 是共享数据源，CDP 与模型访问是并列适配器。

**source 断联时移除 realm 树。** 拒绝，因为传输中断会丢失最后一份有用拓扑，并折叠用户在 Elements 中的检查状态。继续使用旧 object handle 同样不可接受：新的连接 generation 无法证明任何先前实时对象仍然存在。

## Verification

- 同一个 collector 实现能从等价 Cordis 运行时生成 Host 和 Client 快照。
- Elements 显示 `<host>` 与 `<clients>/<client>` container，每个 realm 的 root Context 直接位于其 container 下。
- Context element 不含 attribute；Fiber element 只暴露 Cordis `uid`；root Fiber 不出现。
- 每个 connected Context 与 Fiber 都有一个连接本地 frontend node id、一个 Worker backend node id 和一个可解析的连接本地 Runtime object id，且它们都不作为 attribute 暴露。
- `DOM.resolveNode` 与 `DOM.requestNode` 能往返映射 Context/Fiber 身份，且不会跨 DevTools 连接或 source generation 共享 object id。
- Runtime evaluation 返回的 Context 或 Fiber 会被标记为 node，并能在 Elements 中定位。
- 断联会销毁 Client execution context 与 RemoteObject，同时原样保留最后一棵 Elements 树；新的 transport generation 在完整 snapshot 到达后替换它。
- 重连和 resnapshot 会重放最新树状态；无变化的 snapshot 不发送 DOM mutation，结构变化只更新受影响的 parent 或 node。畸形或超限 replacement 不会替换最后一个有效快照。
- 存储的 snapshot 与查询 API 不包含 CDP 类型，可以不加修改地支持未来的模型适配器。

## Consequences

Cordis 不提供完整的全局 Context registry。collector 能恢复从 live fiber 与 event hook 可达的 Context；一个已创建、从未使用且只由应用代码保留的 Context 会有意缺席。

需要语义识别的每个 Host object 都会增加一次 Runtime round trip。annotation 失败时保留普通 RemoteObject，不破坏 Runtime 或 Debugger 投递。Client Console observation 保留原始 method result，并在之后调度序列化；每个已启用 DevTools session 独立保留 handle，因此识别既不阻塞页面调用，也不在连接间共享对象。

source 仍发布完整 snapshot，从而复用同一套 Host/Client collector，并能在 observation 丢失后恢复。Worker 承担 snapshot 比较成本，再发送增量 CDP DOM mutation，使无变化的 revision 不会重置 Elements document。节点数与字节数限制会保留有效前缀并报告截断；以后可以替换 source delta 协议，而不修改 snapshot model 或 CDP projection。

对象表会有意强引用当前可见树中的每个对象，直到下一次 replacement 或 observer dispose。该集合受保留快照限制，不能扩展成通用对象注册表。

Worker 对断联 snapshot 只保留序列化 metadata；仍在运行的 source 独立拥有其 realm-local object registry，dispose 会释放该 registry。`maxDisconnectedCordisTrees` 约束 Worker snapshot 内存；淘汰时会移除对应的已保留 Client subtree。
