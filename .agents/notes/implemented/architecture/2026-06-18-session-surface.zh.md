# Agent Note: 会话 surface：事件日志上的有序投影

Status: implemented

[English](2026-06-18-session-surface.md) | 中文

## 问题

事件日志是权威数据源，但历史操纵此前没有持久化的共享机制。如果没有这样的机制，上下文压缩（context compaction）等插件会通过顺序敏感的监听器改写派生请求，却不记录每次替换使用了哪些事件。每次新增历史操纵时，还必须修改 `deriveMessages()`。

## 决策

新增一个 **surface**：事件 seq 的派生并缓存的有序投影（即产出 LLM（大语言模型）消息的事件子集），通过事件日志中的 `surfaceOp` 标记维护。

### `SessionEvent` 新增两个顶层字段

每个 `SessionEvent` 获得两个可选字段（结构性元数据，与 `seq`/`time` 同级）：

- **`sourceEventSeqs?: number[]`**：被引用为数据来源的早期事件 seq 编号，例如 result 引用的 `tool/call`，或被 compaction marker 遮蔽的 surface 节点。出现的列表必须非空、唯一、更早且已知。V2 `assistant/message` 嵌入其 provider stream，不能携带该字段。如果没有这些引用的 seq，回放就无法验证 replace-range 操作是否列出了它移除的每个事件。
- **`surfaceOp?: SurfaceOp`**：该事件如何进入 surface。非 surface 事件不携带此字段。

### SurfaceOp：两种操作

```ts
export type SurfaceOp =
  | 'append'                                    // normal tail append
  | { op: 'replace'; start: number; end: number }  // shadow [start, end] inclusive
```

1. **Append**：在尾部追加新事件的 seq。`user/message`、`assistant/message`、`tool/result`、`context/message` 使用此操作。agent loop（智能体循环）在所有此类追加上传入 `surfaceOp: 'append'`，并在适用时记录 `sourceEventSeqs`：`tool/result` 记录其 `tool/call` 来源，`assistant/message` 则直接拥有其嵌入式 stream。

2. **Replace**：移除从 `start` 到 `end`（两端包含）的条目，并在其位置插入新事件的 seq。`start` 和 `end` 都必须存在于当前 surface；`start === end` 表示替换单个条目。该事件的 `sourceEventSeqs` 必须包含所有被遮蔽的 surface seq。被遮蔽的事件仍留在日志中，但不再出现在 surface 上。

### SurfaceManager：基于增量，而非全量重建

一个 `Session` 拥有一个 `SurfaceManager`，后者维护事件 seq 的有序 `number[]`。管理器会在提交前校验每个种子或追加候选项而不应用它，然后只处理上次同步之后已经提交的事件，而不重新扫描整个日志。`Session.surface` 通过只读的 `SessionSurface` 约定暴露同一个管理器，因此接纳、派生历史、压缩与工作区上下文共享同一份增量状态。Replace 按数组位置定位两个端点（均包含在范围内），并把替换 seq splice 到该范围；不会用第二个管理器、链接对象或 seq 到节点的 map 来重复表达顺序。

无新事件时增量处理为 O(1)，有新事件到达时为 O(新事件数)。

`deriveMessages()` 在存在 surface 标记时使用 surface，对没有标记的会话回退到既有的线性扫描（向后兼容）。

### 持久化

新字段作为顶层 JSON 属性序列化。JSONL 存储无需单独列映射：其无损 JSON 边界会保留两个值。已发布 v0 与 v1 共享该 surface 表示，恒等的 v0-to-v1 边会精确保留它；未来结构性表示变更会递增 `SESSION_FORMAT_VERSION` 并拥有一项相邻迁移。

### 崩溃恢复

`repair.ts` 模块在崩溃后为孤立的工具调用合成 `tool/result` 闭合事件。这些闭合事件携带 `surfaceOp: 'append'` 和指向孤立 `tool/call` 事件的 `sourceEventSeqs`，确保重建的 surface 有效。

### 不变式

`Session` 在始终启用的 seed/append 边界校验 `sourceEventSeqs` 与 `surfaceOp`：source list 必须非空、唯一、更早且已知；`assistant/message` 不携带 source list；replacement endpoint 必须存在于 surface 顺序中；`sourceEventSeqs` 必须覆盖每个被遮蔽的节点。这些是单记录接纳与存储投影规则，不是由可选 invariant service 提供的规则。

每个可进入 surface 的事件都必须携带 `surfaceOp`，否则它将从派生历史中消失。类型化的 `append` 重载对字面事件类型强制执行此规则；`append` 和种子构造函数中的运行时检查覆盖宽化联合类型和当前已加载日志。历史 v0 的校验与规范化属于 v0-to-v1 边，而不属于通用 Session 代码。

## 曾考虑的替代方案

- **逐插件的 `agent/request` 包装**（surface 之前的历史操纵模式）：监听器排序脆弱、无法持久记录改动内容，且每种新操纵都迫使核心 `deriveMessages()` 再次修改。
- **半开区间 `[start, endExclusive)` 的 replace 范围**：否决。端点由 surface 事件 seq 命名，单条目替换（`start === end`）在闭区间语义下读起来更自然。
- **链接节点对象加 seq map**：否决。生产代码不读取前驱链接，唯一的后继用途就是数组中的下一个位置，而替换本来就需要线性 `indexOf` 查找。单个 seq 数组在保留相同渐进复杂度的同时，只留下一个需要校验的表示。
- **脏标记后全量重建**替代增量处理：在会话生命周期内为 O(N²)，每次单事件追加都要重新扫描所有先前事件。

## 后果

- **`packages/core/session`**：`surface.ts`（`SurfaceManager`）维护一个用于候选接纳和实时投影的有序 seq 数组；`SessionSurface` 是其只读公共视图。`SurfaceOp`/`SurfaceIntent` 与顶层会话事件字段记录条目如何加入它。`append()` 要求 surface 事件携带 `SurfaceIntent`，`deriveMessages()` 以遍历 surface 作为唯一派生路径，`repair.ts` 则发出 surface 感知的闭合事件。种子构造函数拒绝缺少 `surfaceOp` 标记的可进入 surface 的种子事件（见「不变式」一节）。
- **`packages/core/agent-loop`**：所有涉及 surface 事件的追加操作都传入 surface 选项。每个 `assistant/message` 都引用产生它的分片 seq；每个 `tool/result` 都引用它的 `tool/call` seq。
- **`packages/session/session-persistence-jsonl`**：无需改动。
- **`packages/session/session-persistence`**：抽象接口不变。

surface 是历史操纵赖以落地的基础——dsh-compaction 的压缩就搭载于其上。压缩或 tool-result-pruner 插件追加一个既有的消息产出事件类型（例如一条携带摘要的 `user/message`），附带 `surfaceOp: { op: 'replace', start, end }` 和覆盖被遮蔽条目的 `sourceEventSeqs`——新事件在 surface 上取代该范围的位置，而插件自身的 trace 事件（如 `compaction/start`、`compaction/end`）不进入 surface。回放以确定性方式保留该决策。

一次 `tool/result` 替换只能改写当前的一个 `tool/result`，并且必须保留除 `content` 以外的每个数据字段。Session 接纳会与位置范围和引用的源事件校验一起强制这条规则，不依赖可选的诊断插件。
