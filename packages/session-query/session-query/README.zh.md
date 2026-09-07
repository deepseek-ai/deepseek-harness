---
description: "面向消费方与后端作者的统一会话历史查询服务：对实时与持久会话日志的精确读取、关系追踪与提供方无关过滤。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-query

[English](README.md) | 中文

## 概述

`dsh-session-query` 为代码调用方提供检索会话历史的唯一服务：读取完整原始日志、列出并过滤会话、折叠标题、读取带边界上下文的事件、追踪会话血缘与事件关系，并执行全文搜索。实时会话优先于持久化会话，且返回的每条记录都是脱离存储的克隆，因此结果始终描述同一一致时刻。精确读取、过滤与追踪为内置行为；全文搜索来自挂载的后端，已发布实现为 `dsh-session-query-sqlite`。当你需要以编程方式访问模型所看到的内容时，直接从代码使用它。设置与用法在前；实现内部细节放在下方可折叠的开发者章节中。

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

当你需要读取或搜索会话历史、而不直接触碰会话服务或存储后端时，从应用代码使用 `ctx.sessionQuery`。该服务由具体后端插件提供——已发布组合挂载 `@deepseek-ai/dsh-session-query-sqlite`（[README](../session-query-sqlite/README.zh.md)）——因此本包从不单独挂载。一旦组合了后端，以下全部能力都可在 `ctx.sessionQuery` 上使用。

### 你可以做什么

| 操作 | 你得到什么 |
|---|---|
| `listSessions()` | 每个逻辑会话，最新的在前，带 `live` 与 `persisted` 可用性标志 |
| `readSession(id)` | 经过回放校验的完整原始事件日志，且不会让该会话变为实时 |
| `filterSessions(filters)` | 匹配 AND 连接的元数据与可用性谓词的会话 |
| `filterEvents(id, filters)` | 匹配元数据与字面文本谓词的语义事件文档 |
| `readTitleSnapshots(ids)` | 每个会话的最新折叠标题，绑定到其来源 header |
| `listEvents(id)` / `readSurface(id)` | 轻量逐事件记录，或完整的当前模型表层 |
| `readEvent(request)` | 一个完整事件加其周围有界的原始日志窗口 |
| `traceSession(id)` | 已知祖先链与递归后代树 |
| `traceEvent(request)` | 一个事件的位置替换与被引用源事件关系 |
| `searchSessions(request)` / `searchEvents(request)` | 全文搜索分页结果，由挂载的后端实现 |

不带正文的记录只公开 `SessionHeader.isSeeded`。返回事件正文的读取（`readSession`、`readSurface`、`readEvent`）与保留的 `SessionObservation` 值还携带精确 `inheritedEventCount`，因此调用方无需从日志推断切点即可区分继承事件与自有事件。

### 过滤器

`SessionResultFilter` 按 id、可空 cwd、创建时间范围、可空父级或来源可用性缩小会话范围；`SessionEventResultFilter` 按 seq/时间范围、事件类型、表层或字面文本缩小事件范围。过滤器数组使用 AND 连接，同一子句内的列表值使用 OR；空列表值不匹配任何内容，范围包含端点，格式错误的范围或未知的封闭联合值以 `SESSION_QUERY_INVALID_FILTER` 失败。

文本子句是对所提取语义文本的字面、不区分大小写、空白灵活的扫描——而非全文查询。需要任意子字符串召回时使用它；需要排序后的全文结果时使用挂载后端的搜索方法。

### 配置

继承的旋钮通过挂载后端的配置设置：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `readWindowMax` | `50` | `readEvent` 接受的 `before`/`after` 原始事件数上限 |
| `persistedReadConcurrency` | `4` | 一次批量标题读取中的并发持久化日志读取数 |
| `preparedSessionCacheSize` | `5` | 为跨 `observeSession` 读取复用而保留的冷 prepared-Session 观察数 |

### 失败与恢复

失败带有稳定的 `SessionQueryError.code` 类型。你会遇到的包括：id 不存在时 `SESSION_QUERY_SESSION_NOT_FOUND`；同一会话的实时与持久化观察在不可变 header 上不一致时 `SESSION_QUERY_SOURCE_CONFLICT`；已挂载持久化不可读时 `SESSION_QUERY_PERSISTENCE_FAILED`；持久化记录未通过 Session 校验时 `SESSION_QUERY_CORRUPT_SESSION`；加载的日志破坏表层约定时 `SESSION_QUERY_INVALID_SURFACE`。针对已知实时会话的读取从不查询持久化，因此后端故障不会让当前内存历史变得不可读。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本服务建立在一个分离与三项承诺之上：

- **实时优先的逻辑语料库。** 每次读取都解析一个一致的观察：实时 `ctx.sessions` 优先，可选的 `ctx.sessionPersistence` 补充其余部分，冲突的不可变 header 宁可失败也不合并。
- **脱离存储的结果。** 所有返回的 header、事件与记录都是克隆；不暴露实时状态，也不保留订阅。
- **精确读取具体，搜索抽象。** 读取、过滤与追踪在此只实现一次；两个全文方法是由后端拥有的唯一抽象表面。
- **一次规范的表层折叠。** `listEvents`、`readSurface` 与 `traceEvent` 使用同一个 `dsh-session` 折叠校验整个日志，因此搜索与追踪和模型历史推导一致。

决策历史记录在[统一服务决策](../../../.agents/notes/archived/architecture/2026-07-23-unified-session-query-service.md)、[追踪笔记](../../../.agents/notes/archived/feature/2026-07-13-session-query-tracing.md)与 [SQLite 提供方笔记](../../../.agents/notes/archived/feature/2026-07-10-sqlite-session-query-provider.md)中。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务定义：抽象 `SessionQueryEngine`、具体读取、配置校验 |
| [`src/corpus.ts`](src/corpus.ts) | 实时优先的语料库解析、可选持久化绑定、批量投影 |
| [`src/observation.ts`](src/observation.ts) | 实时优先的定点观察，带按修订键控的有界 prepared-Session 缓存 |
| [`src/cold-read.ts`](src/cold-read.ts) | 基于 handle 的冷日志读取，附内存中的中断轮次闭合事件 |
| [`src/types.ts`](src/types.ts) | 公共记录、过滤器、请求与分页类型 |
| [`src/config.ts`](src/config.ts) | 继承配置与封闭的 `SessionQueryError` 分类体系 |
| [`src/filters.ts`](src/filters.ts) | 提供方无关谓词与字面文本扫描 |
| [`src/extraction.ts`](src/extraction.ts) | 按事件类型的第一方语义文本提取 |
| [`src/documents.ts`](src/documents.ts) | 表层感知的语义文档投影 |
| [`src/tracing.ts`](src/tracing.ts) | 一次性会话血缘与事件关系追踪 |
| [`src/sources.ts`](src/sources.ts) | 不可变 header 兼容性检查 |
| — | 不发布运行时不变式伴生入口；结果均为按调用投影。 |

### 语料库解析

`SessionCorpus` 通过 fiber 绑定可选的 `ctx.sessionPersistence`，并实时优先解析每次读取：已知实时目标直接快照，不查询持久化；否则先列出会话，再通过短生命周期的读取 handle 完整读出日志，并在克隆前重新检查是否出现实时挂载。写入者在轮次中途崩溃的冷日志用 `interruptedTurnClosers` 在内存中补齐 —— 读取从不修改持久化。列表与加载观察之间会断言 header 兼容性。批量标题读取执行一次元数据列表与有界并发读取，把逐会话失败隔离，而取消会拒绝整个批次。

### 观察缓存

`observeSession` 不经过列表预检直接构建定点观察。实时观察以当前日志长度固定 cut，并在首次读取时才物化 `events`，因此只需要 header、cursor 或 projection 的消费者永远不会复制日志；日志只会追加，所以延后的首次读取得到的仍然正好是该前缀。冷路径先对存储会话执行 `stat`，再查询自有的有界缓存，缓存键为持久化实例加 `stat` 修订：修订未变则复用已恢复的未发布 Session，不再重读日志；修订变化或持久化实例被替换则经 handle 缝重新加载并替换条目。缓存保留 `preparedSessionCacheSize` 个条目并按最久未用淘汰，被活跃观察租约钉住的条目从不被淘汰；读取中途转为实时的会话会重试实时路径。

### 读取与追踪

`readSession` 通过 `Session.create` 回放日志，复用恢复的校验。`readSurface`、`listEvents` 与 `traceEvent` 共用一次 `foldSurface` 遍历，把事件分类为 `current`、`shadowed` 或 `log-only`，并校验从零开始且连续的 seq、表层标记的适用性以及替换或引用完整性；任何违规都以 `SESSION_QUERY_INVALID_SURFACE` 失败。追踪是一次性的：会话血缘只读取一次语料库并确定性遍历父级与后代树；事件追踪沿位置替换者跟进到最终节点，同时保持被引用源事件链接不传递。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享查询词汇逐步进入具体后端与决策证据。

- [会话查询子系统参考](../../../docs/subsystems/session-query.zh.md)——完整类型级约定：记录、过滤器、搜索页、血缘、有界读取与错误。
- [dsh-session-query-sqlite](../session-query-sqlite/README.zh.md)——已发布的全文后端及其索引生命周期。
- [dsh-tool-session-query](../tool-session-query/README.zh.md)——构建在本服务之上的面向模型消费方。
- [会话查询关系追踪](../../../.agents/notes/archived/feature/2026-07-13-session-query-tracing.md)——追踪语义与校验边界。
- [SQLite FTS5 会话搜索](../../../.agents/notes/archived/feature/2026-07-10-sqlite-session-query-provider.md)——搜索表面如何实现与对账。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该可信查询服务只向调用方返回克隆记录，且不注册任何面向模型的内容。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本包何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是任务积压。

- **无调用方授权**——这是上下文范围内的可信基础设施；模型工具或 UI 必须限制调用方可检查的会话。
- **无提供方协调器或回退**——服务在搜索上是抽象的，组合必须挂载具体后端；没有搜索提供方注册表或回退实现。
- **精确读取回放整个日志**——`readSession`、`readSurface`、`filterEvents` 与事件追踪会加载并校验完整逻辑日志，因此非常大的历史每次调用都要付出完整检查；`listSessions` 保持轻量。
- **字面文本扫描，而非全文搜索**——`text` 过滤器用正则表达式扫描提取出的文档且不排序；排序搜索需要挂载后端。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放设计问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

#### 未来：提取器与搜索提供方注册表

对被引用源事件的递归遍历、提取器与搜索提供方注册表以及更多面向模型表面均被推迟；[tool-session-query README](../tool-session-query/README.zh.md)说明了当前的消费方表面。

</details>
