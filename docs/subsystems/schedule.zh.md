# 宿主级 Schedule

[English](schedule.md) | 中文

Schedule 独立于 Session 的激活状态存储宿主任务。同一管理 API 按 id 操作任务，同一求值器处理七种权威时间类型：`after`、`at`、`every`、`daily`、`weekly`、`cron` 和 `rrule`。目标可以复用已有 Session、创建一个 Session 后复用，或每次投递创建 Session。[包 README](../../packages/schedule/schedule/README.zh.md) 负责组合与提醒格式；完整值类型和请求类型以 [`types.ts`](../../packages/schedule/schedule/src/types.ts) 为准。

<a id="durable-tasks"></a>
## 持久任务

插件 README 拥有当前 [v2 任务 schema、v1 默认值与持久 JSON 示例](../../packages/schedule/schedule/README.zh.md#storage-format)。领域保留名称、路由和整单元布局。七种时间类型均保持权威性；规范化保留已提交发生时点，不将 Cron 转为 RRULE。

损坏的存储、无效行、与任务身份不一致的键及不支持的版本在任务激活前拒绝。打开失败不改变介质。文件不存在时从空域开始。目标 Session 缺失的任务仍在管理界面中可见；读取任务从不激活其 Session。

<a id="storage-versioning"></a>
## 存储版本

README 定义[任务何时升级](../../packages/schedule/schedule/README.zh.md#storage-format)、SQLite 不变的物理 schema、修改成本以及未来兼容 v3。`compatibleVersions` 允许旧单元版本戳进入当前解码；正常编辑与投递持久化当前行。读取保持存储不变。共享的[领域版本策略](storage.zh.md#domain-versioning)同时适用于 JSON 和 SQLite。

<a id="recurrence-rules"></a>
## 重复规则

[`dsh-util-time`](../../packages/util/time/README.zh.md) 负责可复用的 `Cron`、`RRule` 解析及有界发生时点计算。两种解析值均暴露其权威表达式、时区、`next(after)` 和 `resolve(scheduledAt, acceptedAt)`。解析器返回接受值或拒绝原因；Schedule 将原因映射为自身输入错误，并负责记录验证、准入限制、持久化与投递。

每个已存 `scheduledAt` 都是带毫秒精度、年份为 0001 至 9999 的规范 RFC 3339 UTC 时刻。解码不会根据当前时区数据重新计算它。只追赶最新一次的策略保留该已提交下界，投递最新到期时点一次，再提交第一个未来时点。规则耗尽后任务以 `ended` 状态保留。

| 类型 | 权威时间字段 |
|---|---|
| `after` | 正整数 `afterSeconds` 和已提交的一次性 UTC 目标。 |
| `at` | 已提交的一次性 UTC 目标。输入接受显式偏移时刻，或本地日期、时间与显式时区。 |
| `every` | 不小于 60 的整数 `everySeconds`；发生时点始终对齐已提交的间隔锚点。 |
| `daily` | `HH:mm:ss.SSS` 形式的本地 `time` 与显式 `timeZone`。 |
| `weekly` | Daily 字段加非空、唯一、升序的 ISO `weekdays` 集合，周一为 1、周日为 7。 |
| `cron` | 规范五字段 `expression` 与显式 `timeZone`。 |
| `rrule` | `rrule` 中一条规范 `DTSTART` 和一条 `RRULE` 行；`DTSTART` 提供锚点与时区。 |

本地日历规则跳过不存在的墙钟时间，并在重叠时选择较早的时刻。固定间隔保留经过时间的含义。一次性延迟可短于一分钟；首次投递之后仍适用单任务最小投递间隔。

<a id="absolute-time-input"></a>
## 绝对时间输入

`at` 选择器接受带显式 `Z` 或数字偏移的 RFC 3339 时刻，或 `{ date, time, time_zone }`。本地日期使用 `YYYY-MM-DD`；本地时间使用 `HH:mm:ss`，可带一至三位小数秒。歧义或不存在的日历值通过共享时间工具验证。新的绝对目标必须严格位于未来且可表示。

<a id="daily-wall-clock-input"></a>
## 每日与每周输入

Daily 输入提供 `{ time, time_zone }`；Weekly 另加显式 `weekdays`。创建时选择第一个严格位于未来的实际发生时点。追赶选择最新实际到期时点，并推进到之后匹配的本地日期。等价编辑保留已存 IANA 别名和固定 UTC 目标，包括毫秒。

<a id="fixed-rate-input-and-catch-up"></a>
## 固定频率输入与追赶

Every 输入提供 `every_seconds`。新间隔从接受时间开始；修改间隔会在编辑被接受时建立新锚点。不变的间隔或名称／指令编辑保留原锚点。停机后合并错过的间隔，而非逐次重放。

<a id="cron-wall-clock-input"></a>
## Cron 输入

Cron 输入提供 `{ expression, time_zone }`。五个数字字段依次为分钟、小时、月内日期、月份和星期。支持的原子形式为 `*`、单值、闭区间、星号或区间步长，以及逗号分隔列表。周日接受 0 或 7，规范为 0。拒绝名称、宏、秒字段和单值后跟步长的形式。

Cron 保留 Vixie 的日期匹配方式：两个日期字段都受限时，月内日期**或**星期任意一个匹配即可；任一字段以 `*` 开头（包括带步长的星号）时，两组匹配值均须匹配。规范化保留此差异。搜索受一个 400 年公历周期和四位 UTC 年份范围约束。启用时拒绝没有可表示未来时点的规则。

Cron 记录从不转换为 RRULE。读取、描述性编辑、重新指定目标和重启均保留其已存表达式与时区作为权威来源。自定义编辑器接受五字段 Cron 表达式，并显示显式时区选择器。

<a id="rrule-input"></a>
## RRULE 输入

RRULE 接受有界的 RFC 5545 子集，以共享的 [`rrule.ts` 解析器](../../packages/util/time/src/rrule.ts)为准。输入恰好包含两条非空内容行：先 `DTSTART`，再 `RRULE`。开始时间为真实的 `YYYYMMDDTHHMMSS` 日期时间，使用 UTC `Z` 或显式 IANA `TZID`；拒绝浮动本地时间、数字偏移、仅日期值及额外内容行。引擎使用 `rrule` 2.8.1，支持 `MINUTELY`、`HOURLY`、`DAILY`、`WEEKLY`、`MONTHLY` 和 `YEARLY`。一次性投递使用 `COUNT=1`。

只接受 `FREQ`、`INTERVAL`、`COUNT`、`UNTIL`、`WKST`、`BYSECOND`、`BYMINUTE`、`BYHOUR`、`BYDAY`、`BYMONTHDAY`、`BYYEARDAY`、`BYWEEKNO`、`BYMONTH` 和 `BYSETPOS`；字段名和列表值必须唯一。`INTERVAL` 为正安全整数。`WKST` 为 `MO` 至 `SU` 中的星期，默认 `MO`。数字列表须在解析器规定的范围内。分钟／小时规则不接受 `BY` 部分。`BYMONTHDAY` 和带序数的 `BYDAY` 仅用于每月或每年；`BYYEARDAY` 和 `BYWEEKNO` 仅用于每年。带序数的 `BYDAY` 不能与 `BYWEEKNO` 组合，`BYSETPOS` 必须搭配另一项 `BY`。

验证发生在枚举之前。拒绝 `SECONDLY`、多个 `BYSECOND` 值及一个频率周期中超过 10,080 个可能候选时点的规则。`COUNT` 为 1 至 1,000，不能与 `UNTIL` 共存；`UNTIL` 为以 `Z` 结尾的绝对 UTC 日期时间。开始与截止年份为 0100 至 9999。集合位置至多 31 个，每个位置为 −366 至 −1 或 1 至 366，且必须在有界周期内。较严格的新规则编写检查还会在周期至多有一个候选时点时拒绝 `BYSETPOS`；解码和恢复未改变的受支持规则仍使用正常求值器。

不存在的本地 `DTSTART` 会被拒绝。后续不存在的本地发生时点会跳过，且不消耗 `COUNT`；重叠时间选择较早时刻。即使正负集合位置选中同一时点，`COUNT` 也仅计数一次。

自定义 RRULE 文本保留其 `DTSTART` 时区。面向模型的工具继续指导并接受 RRULE；共享管理 API 则显式接受每种时间类型。

<a id="delivery-targets"></a>
## 投递目标

| 目标 | 投递行为 |
|---|---|
| `session` | 投递到一个已有 Session。启用时在管理 FIFO 内检查其存在、未归档且不属于委托子 Agent。投递时再次检查归档状态。 |
| `new_once` | 首次投递前预留 Session id，需要时创建该 Session，然后保存为 `session` 并复用。重试和重启保留该预留标识。 |
| `new` | 每次投递创建 Session。创建前持久化 `pendingDelivery.targetSessionId`，使失败尝试重用同一 Session。 |

创建时省略目标则默认 `new_once`。新增或替换 `new`、`new_once` 目标需要嵌入环境提供 Session 创建能力。SDK 组合缺少该能力时，在保存前以 `invalid_rule` 拒绝这些请求；已有 `session` 目标仍可使用。创建值 `cwd` 和 `agentPreset` 可省略，使用 Host 默认值。创建的 Session 会加入其目录已注册的 Workspace（如有），且尚无标题时使用任务标题；`new` 另加该规则时区中的创建分钟。加入或重命名失败会记录日志，但不阻断投递。

<a id="task-management"></a>
## 任务管理

所有调用方使用相同的 `ScheduleCreateRequest`、`ScheduleCatalogEntry`、`ScheduleTiming` 和 `ScheduleEditRequest`。浏览器安全类型来自 `@deepseek-ai/dsh-schedule/client`。不存在 Session 绑定的管理入口或第二套类型别名。

| 操作 | 行为 |
|---|---|
| `create(request, actorSessionId?, signal?)` | 分配 id 并保存标题、指令、带类型的 `timing` 及可选目标。 |
| `list(request?)` | 分页读取；默认 100、最多 500，可选 `active` 过滤及非负 `offset`。 |
| `catalog()` / `view({ id })` | 无分页上限读取所有任务，或读取一个任务。 |
| `history({ id, limit, before? })` | 不激活 Session 地读取已保存投递；limit 为 1 至 100。 |
| `edit(request, actorSessionId?, signal?)` | 按 id 原子应用 `update` patch 或 `delete`。 |
| `deleteInactive()` | 一次批量写入仅删除 `ended` 任务，保留活动和暂停任务，返回 `{ deleted }`。空集合不写入。 |
| `run({ id }, signal?)` | 经正常准入立即投递，不改变已计划发生时点或生命周期。 |
| `deliveryLimits()` | 读取 `new` 目标的配置最小间隔。 |

Remote 路由提供 `create`、`list`、`catalog`、`view`、`history`、`edit`、`deleteInactive`、`run` 和 `deliveryLimits`；传输包装器委托给相同管理方法。Remote 验证失败使用带 Schedule 输入码的 `schedule/input-invalid`。原生调用方收到 `ScheduleInputError`。

非空的 `deleteInactive` 批量写入成功后发出 `schedule/changed`，供读取方刷新；不向 Agent 排入通知。批量写入被拒绝时也发出该事件，让读取方丢弃旧状态。正常失败保留全部行；`unknown-state` 失败可能已移除行，并隔离领域直到重新打开。失败调用以拒绝结束，不返回删除数量。

更新可以替换标题、指令、带类型时间、目标或活动状态。省略字段保留原值。规则改变或显式恢复时，在 FIFO 接受时刻计算未来时点；等价时间及描述性编辑保留已提交目标。已投递的一次性任务需要新的未来时间才能恢复。重新指定目标不要求转换时间类型。

`expectedUpdatedAt` 是可选的乐观比较。字符串与已存修订比较；显式 `null` 与缺失的修订比较。不一致时返回 `schedule_conflict`。编辑没有修订的行会创建修订；即使时钟回拨，后续修订仍单调递增。开始写入前检查取消，已经开始的持久写入不回滚。

<a id="timing-edits"></a>
## 时间编辑

`timing` 判别字段只选择其匹配的载荷，例如 `{ kind: "cron", cron: { expression: "0 9 * * 1-5", time_zone: "Asia/Shanghai" } }` 或 `{ kind: "rrule", rrule: "DTSTART:20990101T090000Z\nRRULE:FREQ=DAILY" }`。其他选择器使用 `after_seconds`、`at`、`every_seconds`、`daily` 或 `weekly`。持久化前拒绝无效组合。UI 经相同 API 保存带类型的 Cron/RRULE 输入，并保留未修改的时间规则。

<a id="saved-delivery-records"></a>
## 已保存投递记录

回执记录 `scheduledAt`、`deliveredAt`、`messageId` 和 `targetSessionId`；它确认持久 Session 收件箱写入，而非模型完成。已保存记录还可含不可变的已发送 `prompt`。旧回执缺少目标 id 时，在任何重新指定目标的编辑之前使用已解析的可复用目标，因此后续目标不会重写其历史。 回执既没有显式目的地也没有已知复用目标时，拒绝解码；新默认预留不能证明历史目的地。

新任务从已知的空历史开始。旧行没有 `deliveryHistory` 时，暴露其最新回执（如有），并设置 `earlierRecordsUnavailable: true`；不会编造丢失的历史或指令快照。省略的 `earlierRecordsPruned` 读为 false。消息 id 重复，或最新保存记录与 `lastDelivery` 不一致，均拒绝解码。

历史按追加顺序排列，不受时钟回拨影响。确认在同一任务提交中追加并裁剪，默认保留最多 200 条、30 天，同时保留最新回执。查询页从新到旧，使用不含游标自身的消息 id 游标。硬删除移除任务及历史，不移除已入队的 Session 消息。

<a id="host-delivery"></a>
## 宿主投递

一个 Host 定时器驱动活动任务。运行时与管理写入共用一个 FIFO。已有和预留 Session 通过 `schedule/resolve-agent` 解析，由嵌入环境拥有激活，已注入的 Web 控制器作为后备。复用 Session 的任务占用执行槽，直到目标 Agent 空闲；期间发生的时点会合并。`new` 目标允许多个执行并行。到期且投向相同已有 Session 的重复记录共享一条消息；`after` 和 `at` 单独投递。

定时与手动投递均遵守单任务 60 秒最小间隔。`newSessionIntervalSeconds` 可为 `new` 目标提高间隔，最多一周。已存后继时点保持间隔时，下界从上次发生时点计算；否则从上次确认计算，因此投递延迟不会移动规则锚点。读取仅在适用时暴露 `executionActive` 和 `deliveryFloorEndsAt`。

Session 收件箱持久化先于任务回执写入，因此两份存储之间崩溃可能重复投递。Host 必须运行。指向某 Session 的活动任务会参与其归档准入；归档停止操作会删除这些活动任务。

管理变更提交后，Schedule 向除操作者之外的每个已加载相关 Agent 排队发送尽力而为的通知。通知加入下一模型步骤，不开启新轮次；其 Session I/O 不占用管理／投递队列。每次投递新建的 Session 不会累积到相关元数据中。

<a id="historical-session-changes"></a>
## 历史 Session 变更

历史版本 1 的 `schedule/change` 事件保留冻结的 `LegacyScheduleRecord` 类型：`after`、`at`、`every`，包括原来的可选标题。它们仍是已保存的 Session 数据，Schedule 不为其保留解释器、警告钩子、导入器或定时器。`schedule.json` 中已有的 Host 任务仍使用正常的解码器与求值器。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxschedule--scheduleservice"></a>

### `ctx.schedule` — `ScheduleService`

Shared management service; reads and management writes never activate a Session, and only delivery creates or resumes one.

`sessionPersistence` supplies header-only target validation and the `session/flush` listener that acknowledges durable inbox delivery through `ctx.sessions.flush()`.

```ts cordis-catalog
/** Read effective delivery limits without loading or activating a task.
 * @returns The configured minimum spacing between deliveries that each create a Session, in seconds.
 */
@Remote('deliveryLimits') deliveryLimits(): { readonly newSessionIntervalSeconds: number }

/**
 * Create one task with a Host-generated identity for a human Remote caller.
 * @param request - Title, prompt, recurrence, and delivery destination.
 * @param signal - Cancellation checked before the durable write begins, including after FIFO waits.
 * @returns The stored task. Cancellation does not roll back an in-flight write.
 */
@Remote('create') async remoteCreate(request: ScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleCatalogEntry>

/**
 * Create one task and record the acting Agent's Session as involved; the Remote form omits that Session.
 *
 * The record is built from the clock reading taken before the request joins the serialized queue. A `session`
 * target must exist and must not belong to a delegated child; a `new_once` target reserves its Session identity.
 * @param request - Title, prompt, recurrence, and delivery destination.
 * @param actorSessionId - Session of the acting Agent, or undefined for a human caller.
 * @param signal - Cancellation checked before the durable write begins, including after FIFO waits.
 * @returns The stored task. Cancellation does not roll back an in-flight write.
 */
async create( request: ScheduleCreateRequest, actorSessionId?: SessionId, signal?: AbortSignal, ): Promise<ScheduleCatalogEntry>

/**
 * Read one page of Host tasks without activating target Sessions.
 * @param request - Optional activity filter, page size, and offset.
 * @returns The requested page and total matching task count.
 */
async list(request: ScheduleListRequest = {}): Promise<ScheduleListResult>

/**
 * Remote form of the shared Host-wide list.
 * @param request - Optional activity filter, page size, and offset.
 * @returns The requested page and total matching task count.
 */
@Remote('list') async remoteList(request: ScheduleListRequest): Promise<ScheduleListResult>

/**
 * Read every Host task without a page bound or Session activation.
 * @returns All tasks, active first, with target and execution metadata.
 */
@Remote('catalog') async catalog(): Promise<ScheduleCatalogEntry[]>

/**
 * Read one task without activating its target Sessions.
 * @param request - Task identity.
 * @returns The task, or a non-mutating miss.
 */
@Remote('view') async view(request: ScheduleViewRequest): Promise<ScheduleViewResult>

/**
 * Read one page of saved deliveries without activating or reading a target Session.
 * @param request - Task identity, explicit page size, and optional exclusive cursor.
 * @returns Newest-first saved deliveries, or a task/cursor lookup failure.
 */
async history(request: ScheduleDeliveryHistoryRequest): Promise<ScheduleDeliveryHistoryResult>

/**
 * Remote form of the target-based {@link ScheduleService.history}; an invalid limit rejects with
 * `schedule/input-invalid`.
 * @param request - Task identity, explicit limit, and optional exclusive message cursor.
 * @returns Newest-first deliveries in append order, or a task/cursor lookup failure.
 */
@Remote('history') async remoteHistory(request: ScheduleDeliveryHistoryRequest): Promise<ScheduleDeliveryHistoryResult>

/**
 * Deliver one task now without consuming or moving its scheduled occurrence; an archived destination Session rejects
 * with `schedule/target-archived`.
 * @param request - Task identity.
 * @param signal - Cancellation checked after entering the delivery transaction and before delivery.
 * @returns Task state after Session persistence acknowledged the delivery, `schedule_execution_pending` while
 * another execution of the task is queued, running, or inside its delivery floor, or a non-mutating miss.
 */
@Remote('run') async run(request: ScheduleRunRequest, signal?: AbortSignal): Promise<ScheduleRunResult>

/**
 * Delete every ended Host task, leaving active tasks armed.
 *
 * Ended tasks never schedule another delivery, so the removal changes no pending
 * target and no timer is recomputed. Rows are enumerated and removed in one FIFO
 * slot, so a delivery ordered behind this call ends its task after the
 * enumeration rather than during it. The batch is one domain write: a normal
 * failure rejects with every listed row still stored, while a backend
 * `unknown-state` failure may have removed rows and quarantines the Host
 * domain, so later schedule operations reject until the domain is reopened.
 * A successful nonempty batch emits `schedule/changed` without Agent notices.
 * A rejected batch announces `schedule/changed` because it does not establish
 * which rows landed, and clients then re-read the catalog.
 * @returns Count of removed rows; zero when the Host held no ended task.
 */
@Remote('deleteInactive') async deleteInactive(): Promise<ScheduleDeleteInactiveResult>

/**
 * Update or delete one task for a human Remote caller; an invalid patch rejects with `schedule/input-invalid`.
 * @param request - Task identity and one update or delete operation.
 * @param signal - Cancellation checked before the durable write begins, including after FIFO waits.
 * @returns The updated task, the deletion outcome, or a non-mutating miss or conflict.
 */
@Remote('edit') async remoteEdit(request: ScheduleEditRequest, signal?: AbortSignal): Promise<ScheduleEditResult>

/**
 * Update or delete one task and record the acting Agent's Session as involved; the Remote form omits that Session.
 *
 * An update applies every patch field in one write and recomputes the next occurrence when the rule changes or
 * the task resumes. A supplied `expectedUpdatedAt` that differs from the stored value returns `schedule_conflict`.
 * @param request - Task identity and one update or delete operation.
 * @param actorSessionId - Session of the acting Agent, or undefined for a human caller.
 * @param signal - Cancellation checked before the durable write begins, including after FIFO waits.
 * @returns The updated task, the deletion outcome, or a non-mutating miss or conflict.
 */
async edit( request: ScheduleEditRequest, actorSessionId?: SessionId, signal?: AbortSignal, ): Promise<ScheduleEditResult>
```

Types: [SessionId](core.zh.md)

Source: [`packages/schedule/schedule/src/index.ts`](../../packages/schedule/schedule/src/index.ts)

<a id="schedule-events"></a>

### `schedule/*` events

<a id="schedulechanged--emit"></a>

#### `schedule/changed` — emit

Durable task set changed; clients refetch global task and Session-active catalogs.

```ts cordis-catalog
/** Durable task set changed; clients refetch global task and Session-active catalogs.
 * @mode emit
 */
'schedule/changed'(): void
```

Source: [`packages/schedule/schedule/src/types.ts`](../../packages/schedule/schedule/src/types.ts)

<a id="scheduleresolve-agent--waterfall"></a>

#### `schedule/resolve-agent` — waterfall

Restore a reminder's Session through its embedding's owning controller. Call next() to use the Web Session controller.

```ts cordis-catalog
/**
 * Restore a reminder's Session through its embedding's owning controller.
 * Call next() to use the Web Session controller.
 * @param sessionId - Original Session receiving the reminder.
 * @mode waterfall
 */
'schedule/resolve-agent'(sessionId: SessionId, next: () => Promise<Agent>): Promise<Agent>
```

Types: [Agent](core.zh.md) · [SessionId](core.zh.md)

Source: [`packages/schedule/schedule/src/index.ts`](../../packages/schedule/schedule/src/index.ts)
<!-- END GENERATED cordis-surface -->
