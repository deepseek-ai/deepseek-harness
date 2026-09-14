# Agent Note: Session 开发者迁移规则

Status: proposed

[English](2026-09-10-session-developer-transition.md) | 中文

## Problem

重构跨多个阶段。旧系统必须持续可用，但不推荐新插件继续依赖具体 `Session`、JSONL handle 或生命周期事件。开发者需要按 branch 状态判断规范入口。

## Proposal

固定一个心智模型：**通过 `SessionService` 获得 `LogicalSession`，通过其成员使用逻辑会话；只有 provider 和组合根知道物理实现。**

| 阶段 | 开发规范 |
|---|---|
| 当前 master | 仍按现有公开 API 开发，不假设未合并 stack 已发布。 |
| 阶段 1 后 | 新参数、字段、回调和 test double 使用 `LogicalSession`。现有外部代码可暂时保留 deprecated `Session` 导入与构造器。 |
| 阶段 2 后 | `ctx.sessions` 拥有 live registry 与 storage attachment；Agent loop 和插件不保存 persistence handle。 |
| 阶段 3 后 | 新存储实现 `SessionStorageReader`／`Writer`；普通功能仍不把 storage 当作 session API。 |
| 阶段 4–5 后 | 逻辑会话拥有实时写入与投影；仓库内代码不再使用兼容别名。 |
| 长期 | 组合根选 session/service/storage/query provider；功能包不因 provider 更换而改变。 |

### 维护规则

- 创建、恢复、fork、列举或查找 live session 只调用 `SessionService`；不要维护第二份 registry。
- 得到 `LogicalSession` 后只用 `header`、`id`、`seq`、`surface`、`append()`、`eventAt()`、`snapshotEvents()` 等公开成员；不要猜测事件数组或内存 Map。
- 持久化 provider 拥有格式、迁移、租约、revision 和物理 I/O；搜索、统计、标题、前端与 telemetry 使用逻辑协议或自己的 Service Definition。
- 新 provider 通过共享合约测试并由组合根显式注册。核心代码不得按 provider 名称分支或扫描包。
- 新代码不得使用 `SessionPersistence`、`ctx.sessionPersistence` 与旧 handle/access/snapshot/revision 名称；阶段 5 在旧消费方归零后删除它们。
- 文档和测试明确标注 current、completed stage、target 或 compatibility，不把草稿 PR 当作已发布行为。

普通插件只声明对 `ctx.sessions` 的 Cordis 依赖，接受并传递 `LogicalSession`，并使用其公开成员。现有插件可在迁移期间保留 `Session`、`Session.create` 与 `Session.fromRestore`，但新代码使用逻辑会话类型与游离 factory。只有实现新后端的插件才接触 storage/query 协议；它无需知道默认实现使用哪种内存、持久化或查询索引。

### 常见操作迁移

以下是目标伪代码；具体可用方法以所在阶段的类型声明为准。

```ts ignore-check
// Types: Session -> LogicalSession
function render(session: LogicalSession) {}

// Create/open: new Session(...) or storage.open(...) -> SessionService
const created = await ctx.sessions.create(options)
const opened = await ctx.sessions.open(id, options)

// Live lookup/list: private Map or file scan -> SessionService
const one = ctx.sessions.get(id)
const live = ctx.sessions.list()

// Identity/header: concrete fields or storage metadata -> logical session
const id = session.id
const header = session.header

// Events: session.events[index] or handle.read(...) -> logical session
const event = session.eventAt(seq)
const events = session.snapshotEvents(from, to)

// Model-visible history: local event folding -> canonical surface
const surface = session.surface

// Write: push(events) or direct JSONL write -> logical session
session.append(type, data, surfaceIntent)

// Projection: concrete lifecycle subscription -> projection port
ctx.sessions.registerProjectionPort(projectionPort)

// Titles, statistics, filters, full-text retrieval, and cold reads -> SessionQuery
const page = await ctx.sessionQuery.query(request)

// Fork: copy arrays or files -> SessionService
const child = await ctx.sessions.fork(session, boundary, childId)

// Durability: flush a handle directly -> SessionService
const durable = await ctx.sessions.flush(session)
```

### 新贡献者怎样上手

1. 先读[总览](2026-09-06-logical-session-storage-rebuild.zh.md)，理解唯一目标：逻辑 Session 与所有物理实现完全解耦。
2. 再读[能力协议](2026-09-10-session-capability-protocols.zh.md)和当前 `docs/subsystems/session.zh.md`；前者是目标，后者是所在 branch 的当前事实。
3. 按阶段顺序阅读进度：1.1→1.2→1.3→1.4→1.5→2→3。不要只读最后阶段的 diff 后修改较早阶段。
4. 从一个拥有明确调用方的迁移开始：改类型、改入口、补合约测试，并证明旧路径没有新增使用。生命周期、格式或失败顺序变化必须独立成阶段。
5. 提交前运行目标测试、类型检查、文档检查和依赖检查；在 handoff 写明 current、target、gap、下一删除条件与准确 branch/commit。

## Alternatives considered

**等全部阶段合并后再迁移插件。** 拒绝，因为期间新增的具体依赖会扩大最终清理面。

**永久保留旧名。** 拒绝，因为双入口会让文档与类型永久分叉。临时入口具有兼容测试，只有在获得外部迁移证据后才能通过独立决策移除。

## Acceptance criteria

- 阶段 1 以上的新代码以 `LogicalSession` 作为推荐会话对象并从 `SessionService` 获得它；deprecated `Session` 入口继续兼容现有外部代码。
- 普通插件不导入具体 provider；依赖门检查该规则。
- 阶段 5 前的兼容入口有覆盖、已命名旧消费方和删除条件。
- 新贡献者能从总览、协议、当前子系统文档和阶段顺序定位一个安全迁移任务。

## Risks

不同 stack 层暴露不同 API。开发者必须以目标 branch 为准，不把阶段 3 的 API 回写到较低阶段。`LogicalSession` 也不能吸收没有自然归属的搜索、统计或 I/O，避免变成新的大对象。
