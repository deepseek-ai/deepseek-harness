# 宿主级 Schedule

[English](schedule.md) | 中文

Schedule 独立于 Session 的加载状态存储提醒，并将其投递到原 Session。本页记录 [`types.ts`](../../packages/schedule/schedule/src/types.ts) 中的持久与模型可见类型；[包 README](../../packages/schedule/schedule/README.zh.md) 负责组合方式与提醒文本格式。

## 持久记录

`ScheduleId` 是全局唯一的[品牌化 ID](core.zh.md#branded-ids)。版本 1 的 `schedule` storage domain 的 `tasks` 表将每条 `ScheduleRecord` 与原始 `sessionId` 绑定，并存储 `status: 'active' | 'inactive'` 和可选的 `lastDelivery`。缺少状态的记录规范化为 `active`，不扫描或重建历史 Session。创建时将目标规范化为 RFC 3339 UTC `scheduledAt`；`after` 保留提交的延迟，`every` 保留固定间隔，`daily` 与 `weekly` 保留规范化后的本地 `time` 及显式 `timeZone`，`cron` 保留规范化后的五字段 `expression` 及显式 `timeZone`。每日、每周与 cron 记录解码保留已提交时点及已存储的时区拼写。已存储的任务记录声明必填的 `title`，即任务界面显示的短名称；创建时必须提供该字段，且绝不从指令派生。任何已存储记录都不得缺少标题：`title` 缺失、去除首尾空白后为空、带首尾空白或超过 120 个字符的已存储记录都会以 `ScheduleLogError` 拒绝持久化解码；schedule domain 未声明备份并跳过的策略，因此一条这样的已存储任务会拒绝整个 domain 的打开，而不是被丢弃。仅显式删除会移除任务；此前已物理删除的任务不会被恢复或虚构。

```ts type-equiv
/** Durable one-shot reminder created from a positive delay. */
interface AfterScheduleRecord {
  /** Globally unique task identity. */
  readonly id: ScheduleId
  /** Rule discriminator for a delayed one-shot reminder. */
  readonly kind: 'after'
  /** Required stored task name; already trimmed, non-empty, and at most 120 characters. */
  readonly title: string
  /** Trimmed reminder content supplied at creation. */
  readonly prompt: string
  /** Positive safe-integer delay accepted at creation. */
  readonly afterSeconds: number
  /** Four-digit-year RFC 3339 UTC target. */
  readonly scheduledAt: string
}
```

```ts type-equiv
/** Durable one-shot reminder created from an absolute instant. */
interface AtScheduleRecord {
  /** Globally unique task identity. */
  readonly id: ScheduleId
  /** Rule discriminator for an absolute one-shot reminder. */
  readonly kind: 'at'
  /** Required stored task name; already trimmed, non-empty, and at most 120 characters. */
  readonly title: string
  /** Trimmed reminder content supplied at creation. */
  readonly prompt: string
  /** Four-digit-year RFC 3339 UTC target. */
  readonly scheduledAt: string
}
```

```ts type-equiv
/** Durable fixed-rate reminder aligned to creation or its most recent interval edit. */
interface EveryScheduleRecord {
  /** Globally unique task identity. */
  readonly id: ScheduleId
  /** Rule discriminator for a fixed-rate recurring reminder. */
  readonly kind: 'every'
  /** Required stored task name; already trimmed, non-empty, and at most 120 characters. */
  readonly title: string
  /** Trimmed reminder content supplied at creation. */
  readonly prompt: string
  /** Fixed safe-integer interval, never below one minute. */
  readonly everySeconds: number
  /** Next anchor-aligned occurrence while active, or final occurrence when inactive. */
  readonly scheduledAt: string
}
```

```ts type-equiv
/** Durable daily wall-clock reminder; gaps skip a date and overlaps use the earlier instant. */
interface DailyScheduleRecord {
  /** Globally unique task identity. */
  readonly id: ScheduleId
  /** Rule discriminator for a daily wall-clock reminder. */
  readonly kind: 'daily'
  /** Required stored task name; already trimmed, non-empty, and at most 120 characters. */
  readonly title: string
  /** Trimmed reminder content supplied at creation. */
  readonly prompt: string
  /** Local time normalized to HH:mm:ss.SSS. */
  readonly time: string
  /** Explicit IANA zone; equivalent timing edits retain the stored spelling. */
  readonly timeZone: string
  /** Committed next UTC instant while active, or final occurrence when inactive. */
  readonly scheduledAt: string
}
```

```ts type-equiv
/** One-shot task variants. */
type OneShotScheduleRecord = AfterScheduleRecord | AtScheduleRecord
```

```ts type-equiv
/** Recurring Host task variants. */
type RecurringScheduleRecord = EveryScheduleRecord | DailyScheduleRecord | WeeklyScheduleRecord | CronScheduleRecord
```

```ts type-equiv
/** Reminder rule and target, stored with its original Session binding. */
type ScheduleRecord = OneShotScheduleRecord | RecurringScheduleRecord
```

## 绝对时间输入

`at` 选择器可以是严格且带偏移量的 RFC 3339 字符串，也可以是精确的本地日历对象。本地形式让这种解释在工具边界保持显式：

```ts type-equiv
/** Structured local-calendar input accepted by creation and timing edits. */
interface LocalAtInput {
  /** Four-digit ISO calendar date. */
  readonly date: string
  /** Local wall-clock time with optional one-to-three digit milliseconds. */
  readonly time: string
  /** Explicit UTC or IANA Area/Location zone. */
  readonly time_zone: string
}
```

```ts type-equiv
/** Absolute selector accepted by creation and timing edits. */
type AtInput = string | LocalAtInput
```

随发行版交付的 Web 组合不含 `time-context` 行；在插件管理页启用可选实验性 bundle `@deepseek-ai/dsh-experimental-schedule-bundle` 会插入并挂载 time-context，它为每条提示词采样浏览器的 IANA 时区。当 open turn 只有一个无歧义的浏览器时区时，Time-context 会告诉模型按该请求本地时区解释未明确限定时区的自然语言日期和时间；浏览器时区记录混合或缺失时，则告诉模型询问用户。该指引不是持久 Session 默认值：模型仍必须在字符串形式中传入偏移量，或在本地形式中传入 `time_zone`；Schedule 绝不会读取浏览器、Session、进程或模型上下文。

Schedule 会拒绝无效偏移量与时区、不带偏移量的字符串、非未来目标，以及落在夏令时缺口内的本地时间。遇到夏令时重叠时，会选择第一次出现的较早时点。创建成功后只存储规范化后的 UTC `scheduledAt`，因此回放绝不依赖环境时区状态。

<a id="daily-wall-clock-input"></a>
## 每日本地钟表时间输入

`daily` 是与 `after_seconds`、`at`、`every_seconds`、`weekly` 和 `cron` 互斥的创建选择器之一。例如，`daily: { time: '23:00:00', time_zone: 'Asia/Shanghai' }` 选择该时区每个符合条件的本地日期的 23:00。对象必须精确包含以下字段，不包含日期、偏移量或间隔：

```ts type-equiv
/** Daily local-time selector accepted by creation and timing edits. */
interface DailyInput {
  /** Local HH:mm:ss time with optional one-to-three fractional digits. */
  readonly time: string
  /** Explicit UTC or IANA Area/Location zone. */
  readonly time_zone: string
}
```

创建时要求 `HH:mm:ss` 及可选的一至三位小数秒，拒绝闰秒和 `24:00`，将显式 IANA 时区规范化，并以 `HH:mm:ss.SSS` 存储 `time`。首个 `scheduledAt` 严格晚于创建时刻。不存在的本地时间或整个日期被跳过；重叠时间选择较早时点，每个本地日期一次。若较早时点已过去，较晚的重复时点不符合条件。仅 UTC 目标年份受 0001–9999 范围约束；UTC 范围边缘的本地日期可以落在第 0 年或第 10000 年。

已保存的下一目标是已提交的 UTC 时点。宿主解码器与重启保留该时点，不依据时区规则重新解析；规范名称变化后，有效的已存储时区别名仍可读取。后续目标使用宿主当前的 IANA 数据。下一目标必须晚于投递判断时刻，并且其本地日期晚于所选发生时点的日期。没有可表示的未来 UTC 目标时，创建以 `time_out_of_range` 失败。

## 固定速率输入与补偿

`every_seconds` 是至少 60 秒的安全整数间隔，与创建时间对齐。它衡量经过的时间，而不是每日本地钟表时间：发生偏移量变化时，`every_seconds: 86400` 不能替代 `daily`。协议不提供共享冷却时间或跨记录准入规则；下文描述的 cron 选择器是钟表时间语义，不是固定速率间隔。

宿主启动时若 Every、Daily、Weekly 或 Cron 记录已逾期，只发送最新一次到期发生时点。Every 推进到投递判断时刻之后第一个与当前间隔起算点对齐的目标；Daily、Weekly 和 Cron 遵循上文与下文的本地日期规则。错过的发生时点不会累积。若没有可表示的下一 UTC 目标，投递后保留未运行记录及最近一次回执。

一次性提醒各自产生一条 follow-up。同一次扫描中属于同一 Session 的到期重复记录共用由 `renderRecurringReminderBatchFraming` 渲染的一条 follow-up，每条记录各包含最新一次触发。一分钟下限仅适用于固定速率间隔；投递不等待目标 Agent 空闲。

<a id="cron-wall-clock-input"></a>
## Cron 钟表时间输入

`cron` 是互斥的创建选择器之一。它的对象只携带严格的标准五字段 Vixie 表达式 `minute hour day-of-month month day-of-week` 和显式 IANA 时区，例如 `cron: { expression: '*/15 9-17 * * 1-5', time_zone: 'Asia/Shanghai' }`。字段取值范围如下：

| 字段 | 取值范围 | 说明 |
|---|---|---|
| minute | 0-59 | |
| hour | 0-23 | |
| day-of-month | 1-31 | |
| month | 1-12 | |
| day-of-week | 0-7 | `0` 和 `7` 都表示周日。 |

每个字段接受 `*`、单个值、`a-b` 范围、`n >= 1` 的 `*/n` 与 `a-b/n` 步长，以及由这些形式组成的逗号分隔列表。其他写法一律以 `invalid_rule` 拒绝，且错误信息会指出违规字段：`L`、`W`、`#` 运算符，`JAN`/`MON` 名称，`@daily` 风格宏，带秒字段的六字段表达式，超出范围的值、反向范围、零步长和空字段。由于该方言只有五个字段，最小间隔为一分钟；亚分钟级调度仍然不受支持。

创建时会先规范化表达式再存储。规范化会把每个字段展开为匹配值集合，再确定性地重新编码该集合：重复值合并，相邻的值与范围合并，均匀步长写为 `a-b/n`，而以 `*` 开头的字段写为星号步长（匹配全部取值时写 `*`，否则写最宽的星号步长并追加其余取值），步长 `1` 被移除，周日统一写为 `0`。不以 `*` 开头的字段绝不会变成星号步长。保留每个字段的星号标志，正是下文 day-of-month/day-of-week 规则在存储的表达式上仍与 Vixie 一致的原因。持久化解码器会拒绝非规范化的已存储表达式。

首个目标是该时区内本地日期与时间匹配的第一个严格未来时点。它复用 Daily 与 Weekly 的本地时间解析：不存在的本地时间被跳过，重叠时间每个日期只取较早一次。已提交的 UTC `scheduledAt` 在重启时绝不重新计算。

day-of-month 与 day-of-week 遵循 Vixie 语义。字段文本以 `*` 开头即为星号字段，与它匹配的取值集合无关，因此 `*/1` 与 `*/2` 都是星号字段，而 `1-31` 与 `0-7` 受限。任一字段为星号字段时，本地日期只有在两个字段都匹配时才算匹配；两个字段都不是星号字段时，匹配任一字段即算匹配。

cron 解码保留已提交时点及已存储的时区拼写，并拒绝非规范化的已存储表达式。cron 仅属于当前宿主的 `ScheduleRecord`；冻结的历史 Session 解码器不接受它。

## 历史 Session 变更

版本 1 的 `schedule/change` 事件仍可作为历史 Session 数据解码。其 create、fold 和 invariant 类型使用 `LegacyScheduleRecord`，仅接受 After、At 和 Every；Daily、Weekly 与 Cron 仅属于当前宿主的 `ScheduleRecord`。宿主记录解码器独立于冻结的历史解码器。在 title 出现之前写入的 create 记录不含 `title`，因此历史解码器接受该缺失成员，而宿主解码器仍要求它。历史事件不会填充 storage domain 或触发投递。这些事件中的已有提醒需要显式通过 `schedule_create` 重新创建；不会隐式迁移 Session 或转换旧 `at` 记录。

```ts type-equiv
/**
 * Frozen Session event and fold vocabulary; daily rules belong only to Host storage.
 *
 * A version-1 event written before titles existed persists no `title` member, so
 * `after`, `at`, and `every` decode without one and stay readable. The Host task
 * record requires the member and never persists a record without it.
 */
type LegacyScheduleRecord =
  | LegacyAfterScheduleRecord
  | LegacyAtScheduleRecord
  | LegacyEveryScheduleRecord
```

```ts type-equiv
/** Creates one durable reminder record. */
interface ScheduleCreateChange {
  readonly version: 1
  readonly operation: 'create'
  readonly schedule: LegacyScheduleRecord
}
```

```ts type-equiv
/** Deletes one currently active reminder. */
interface ScheduleDeleteChange {
  readonly version: 1
  readonly operation: 'delete'
  readonly id: ScheduleId
}
```

```ts type-equiv
/** Records that one active one-shot reminder entered the durable dispatch history. */
interface OneShotScheduleDispatchChange {
  readonly version: 1
  readonly operation: 'dispatch'
  readonly id: ScheduleId
}
```

```ts type-equiv
/** Records one fixed-rate decision and advances directly past missed occurrences. */
interface EveryScheduleDispatchChange {
  readonly version: 1
  readonly operation: 'dispatch'
  readonly id: ScheduleId
  /** Wall-clock decision time used to select the latest due occurrence. */
  readonly acceptedAt: string
}
```

```ts type-equiv
/** Durable dispatch shapes supported by the current rule set. */
type ScheduleDispatchChange = OneShotScheduleDispatchChange | EveryScheduleDispatchChange
```

```ts type-equiv
/** Strict version-1 durable Schedule mutation union. */
type ScheduleChange = ScheduleCreateChange | ScheduleDeleteChange | ScheduleDispatchChange
```

历史 decoder 与 fold 拒绝未知版本、额外字段、复用 ID 和无效转换。该事件仍编入[持久化目录](../persistence-catalog.zh.md#schedulechange--log-only)。Session 历史不负责决定当前活动任务。

## 活动视图与管理

工具值将存储记录与当前墙钟派生的时间状态组合。宿主在投递需要时恢复原 Session；列出和删除任务不会激活该 Session。

```ts type-equiv
/** Current delivery timing derived from the durable record and wall clock. */
type ScheduleState = 'scheduled' | 'overdue'
```

```ts type-equiv
/** Host-driven delivery resumes the original Session when needed. */
type ScheduleDeliveryMode = 'host'
```

```ts type-equiv
/** Complete model-facing view of one active reminder. */
type ScheduleView = ScheduleRecord & {
  /** Whether the target remains in the future. */
  readonly state: ScheduleState
  /** Reminder delivery never leaves the owning session. */
  readonly deliveryMode: ScheduleDeliveryMode
}
```

[工具目录](../tool-catalog.zh.md#deepseek-aidsh-schedule) 负责 `schedule_create`、`schedule_list`、`schedule_delete` 和 `schedule_update` 的 schema。创建、删除和更新在 storage domain 写入确认后返回成功。宿主级队列将这些变更与到期投递串行化；删除任务不会移除已入队消息。模型工具操作当前 Session，共享宿主的 create、list、update 和 delete 方法接受显式 Session 绑定。创建必须提供 `title`，其去除首尾空白后必须非空且不超过 120 个字符；缺失、空白或过长的标题以 `invalid_prompt` 拒绝，且创建过程绝不从指令派生标题。create 和 list 视图在指令之外同时携带已存储的 `title`，且 `title` 缺失或非法的已存储记录在解码时被拒绝。

```ts type-equiv
/** Reminder creation selector, shared by the model consumer and Host service. */
interface ScheduleCreateRequest {
  /** Non-empty reminder text. */
  prompt: string
  /** Required task name of at most 120 characters, non-empty after trimming; names the card, detail heading, and task lists. */
  title: string
  /** Relative one-shot delay in seconds. */
  after_seconds?: number
  /** Absolute one-shot target. */
  at?: AtInput
  /** Fixed recurrence interval in seconds. */
  every_seconds?: number
  /** Daily wall-clock time in an explicit IANA zone. */
  daily?: DailyInput
  /** Weekly wall-clock time and explicit ISO weekday set in an IANA zone. */
  weekly?: WeeklyInput
  /** Five-field cron expression evaluated in an explicit IANA zone. */
  cron?: CronInput
}
```

```ts type-equiv
/** Session-scoped task list, without Agent activation. */
interface ScheduleListRequest {
  /** Original Session binding. */
  sessionId: SessionId
}
```

```ts type-equiv
/** Delete request identifying a task within its original Session binding. */
interface ScheduleDeleteRequest extends ScheduleListRequest {
  /** Task to remove. */
  id: ScheduleId
}
```

```ts type-equiv
/** Successful `schedule_delete` value, including the non-mutating not-found result. */
type ScheduleDeleteResult =
  | { readonly id: ScheduleId; readonly deleted: true }
  | { readonly id: ScheduleId; readonly deleted: false; readonly code: 'schedule_not_found' }
```

## Web 目录

Remote 方法 `schedule.catalog()` 返回活动和未运行的宿主任务及其原始 Session 绑定，先按 `scheduledAt` 升序排列，再按 `id` 字典序排列。它只读取 Schedule domain，不激活 Session 或读取其历史。浏览器消费方接收以下可安全用于浏览器的类型：

```ts type-equiv
/** Durable Session inbox delivery acknowledgment, not model execution completion. */
interface ScheduleDeliveryReceipt {
  /** Canonical UTC target of the delivered occurrence. */
  readonly scheduledAt: string
  /** Canonical UTC time sampled after Session persistence acknowledged delivery. */
  readonly deliveredAt: string
  /** Identity of the delivered message, shared by tasks in one recurring batch. */
  readonly messageId: MessageId
}
```

```ts type-equiv
/** Browser-safe retained reminder with its original Session binding. */
type ScheduleCatalogEntry = ScheduleRecord & {
  /** Session receiving this reminder when it becomes due. */
  readonly sessionId: SessionId
  /** Inactive reminders remain visible but never schedule another delivery. */
  readonly status: 'active' | 'inactive'
  /** Most recent durably acknowledged inbox delivery, when available. */
  readonly lastDelivery?: ScheduleDeliveryReceipt
}
```

Remote 方法 `schedule.list({ sessionId })`、模型 `schedule_list` 和 Session 页头目录仅返回活动任务。模型视图派生的时间 `state` 与存储的生命周期 `status` 仍是不同概念。删除通过 `schedule.delete({ sessionId, id })` 使用条目的原始绑定；绑定不匹配时返回未找到。模型工具传入当前 Agent 的 Session，全局用户界面则传入所选任务的绑定。仅校验绑定并不构成调用者鉴权。无 payload 的 `schedule/changed` 事件通知客户端刷新列表；重新连接后，客户端再次获取当前状态。

随发行版交付的 Web 组合不含 `ui-schedule` 行；在插件管理页启用可选实验性 bundle `@deepseek-ai/dsh-experimental-schedule-bundle` 会插入它并与宿主能力一起挂载。[客户端包](../../packages/client/ui-schedule/README.zh.md) 负责目录、空状态与删除控件。页面单独筛选全部、活动和未运行任务，保留未运行任务详情及详情页签条内的原 Session 入口，并要求显式确认删除。“规则”和“发送记录”将任务设置与按需分页加载的已保存回执分开。回执与未运行状态均不确认模型执行。

## 修改时间

`schedule.update({ sessionId, id, expected, change })` 修改活动任务，不激活其 Session。`expected` 是完整的已观察 `ScheduleRecord`，不是附带额外元数据的目录条目。Host 在投递和删除共用的 FIFO 内将它与当前记录比较。正常投递可能在编辑期间推进目标；此时旧快照返回 `schedule_conflict`，不会覆盖当前规则。任务不存在或绑定不匹配时返回 `schedule_not_found`，未运行任务返回 `schedule_ended`。

```ts type-equiv
/** Timing-only edit; it may select a different recurrence kind than the stored record, and one-shot targets use an absolute `at`. */
type ScheduleTimingChange =
  | { readonly kind: 'at'; readonly at: AtInput }
  | { readonly kind: 'every'; readonly every_seconds: number }
  | { readonly kind: 'daily'; readonly daily: DailyInput }
  | { readonly kind: 'weekly'; readonly weekly: WeeklyInput }
  | { readonly kind: 'cron'; readonly cron: CronInput }
```

```ts type-equiv
/** Compare-and-update request within the original Session binding. */
interface ScheduleUpdateRequest extends ScheduleDeleteRequest, ScheduleUpdateContent {
  /** Complete record observed when editing began, including the committed target. */
  readonly expected: ScheduleRecord
  /** New timing; its kind may differ from the stored record's kind, and an omitted value keeps the committed target. */
  readonly change?: ScheduleTimingChange
}
```

```ts type-equiv
/** Successful current record, non-mutating lookup/conflict failure, or invalid name/instruction/timing. */
type ScheduleUpdateResult =
  | { readonly id: ScheduleId; readonly updated: boolean; readonly record: ScheduleRecord }
  | ScheduleUpdateMiss
  | ScheduleToolError
```

Daily 规则改变后，沿用本地时间和时区语义计算严格晚于当前时间的首个目标。Cron 规则改变后，先规范化表达式，再按相同的本地日期、缺口与较早重叠规则计算首个严格未来目标。Every 间隔改变后，以接纳保存时刻加该间隔建立新的起点。After 或 At 任务可以在保留 id 的同时，通过 At 记录接收新的绝对目标。这些操作保留已存储的 `title`、指令、原始 Session 绑定、生命周期状态和全部已保存回执。变更也可以选择不同的重复类型，此时按新规则重算目标，并保留同一 id、标题、指令、Session 绑定、状态与全部已保存回执。归一化后等价的规则返回 `updated: false` 及未改变的记录，不重写存储、不重设目标，也不发出变更事件。写法不同但等价的 Cron 表达式就是这样的无变更，因为比较使用规范化表达式与规范化时区。

输入校验复用现有时间错误。改变后的绝对目标在 FIFO 槽位开始执行时仍须位于未来。任务 put 成功后才发出变更通知并重算 timer。存储和生命周期失败会 reject；取消检查发生在排队和初始化等待之后，但不能回滚已经开始的写入。一次性记录保留 UTC 时点，而非编辑表单中的 IANA 时区。时间编辑不追加历史 Session 事件：模型通过 `schedule_update` 做同样的原地修改，它与读取到的记录做比对，而不是删除后重建任务。

## 已保存的发送记录

`schedule.history({ sessionId, id, limit })` 读取已保存的回执，不激活 Session。显式 limit 必须是 1–100 的安全整数。分页按追加顺序逆序排列，不按墙钟排序；可选的消息 id 游标排除上一页最早的记录。新记录追加不会改变该游标的定位。任务不存在或 Session 绑定错误时返回 `schedule_not_found`；游标未知时返回 `delivery_cursor_not_found`，不会视为查询成功的空页。

```ts type-equiv
/** Saved inbox delivery with its immutable sent prompt when recorded by this Host. */
interface ScheduleDeliveryRecord extends ScheduleDeliveryReceipt {
  /** Prompt sent for this occurrence; unavailable for legacy receipts. */
  readonly prompt?: string
}
```

```ts type-equiv
/** Explicitly bounded saved-delivery query within one Session binding. */
interface ScheduleDeliveryHistoryRequest extends ScheduleDeleteRequest {
  /** Required safe-integer page size from 1 through 100. */
  limit: number
  /** Message identity of the oldest entry in the previous page; excluded from this page. */
  before?: MessageId
}
```

```ts type-equiv
/** Configured limits applied when appending one task's delivery receipt. */
interface DeliveryRetentionBounds {
  /** Retained window in days, measured back from the acknowledgment being appended. */
  readonly days: number
  /** Maximum retained records per task; the newest survive. */
  readonly records: number
}
```

```ts type-equiv
/** Newest-first saved deliveries, or a non-mutating task/cursor lookup failure. */
type ScheduleDeliveryHistoryResult =
  | {
    readonly id: ScheduleId
    readonly records: ScheduleDeliveryRecord[]
    /** Whether earlier delivery records may be unavailable; missing receipts are never reconstructed. */
    readonly earlierRecordsUnavailable: boolean
    /** True only after an append removed saved records; absent legacy evidence is false. */
    readonly earlierRecordsPruned: boolean
    /** Current Host retention configuration, also used by the delivery writer. */
    readonly retention: DeliveryRetentionBounds
    /** Oldest returned message identity, present only when older saved records remain. */
    readonly nextBefore?: MessageId
  }
  | { readonly id: ScheduleId; readonly code: 'schedule_not_found' | 'delivery_cursor_not_found' }
```

新任务初始化空历史。缺少历史字段的旧任务仅展示已有的最近一次回执，标明更早记录不可用，且读取不会重写任务行。后续确认会保留该回执，并追加带有指令快照的真实新回执。已丢失的历史与缺失的旧指令快照不会被重建。历史、最近回执、状态和下一目标由同一次任务行写入提交；显式删除任务会停止后续投递、把任务行连同其已保存的回执一并移除，并使其离开 `list` 与 `catalog`；对话消息不受影响。已保存的发送记录在追加确认时按配置的 `deliveryHistoryDays` 窗口（以每条回执的 `deliveredAt` 向前计算）与 `deliveryHistoryRecords` 条数上限裁剪；新追加的最近一次回执始终保留，发生裁剪时标记更早记录不可用。分页限制返回的记录数量，不限制存储大小或指令字节数。

## 宿主投递

宿主启动时读取持久任务，并将定时器设为最早的活动目标。未运行任务仍可查询，但不会再次安排投递。投递时通过 Session controller 获取原 Session，包括尚未加载的 Session。恢复后重新采样实际时间，并排除时钟回拨后尚未到期的成员；这些任务仍保留定时义务。投递不涉及 Goal 或独立的 Run 完成记录。

插件来源的 `followup()` 同步将消息追加到 Session 收件箱。Session flush 成功后，一次任务记录 put 追加带有指令快照的发送记录，并同时存储最新的 `ScheduleDeliveryReceipt`，以及一次性任务的 `inactive` 状态或重复任务的下一目标和状态。同一批次的重复任务共享回执的 `messageId`；每条回执保留该任务已投递的发生时点。投递不会中途引导或取消当前轮次，也不等待模型完成。

Session 获取、消息入队或持久化确认失败时，任务继续保存在存储中，并报告宿主警告。后续管理变更或宿主重启会重试。Session 持久化与任务 put 不具有跨存储原子性。收件箱已持久化、任务尚未 put 时发生崩溃，可能重复投递；回执并未消除这一间隔。Schedule 不提供模型结果回执、执行取消或外部通知渠道。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxschedule--scheduleservice"></a>

### `ctx.schedule` — `ScheduleService`

Shared management service; reads, deletion, and timing edits never activate a Session.

`sessionPersistence` is a load-order requirement rather than a directly called service: a delivery commits only when `ctx.sessions.flush()` reports that a `session/flush` listener participated, and the persistence backend providing this service is the plugin that registers that listener.

```ts cordis-catalog
/**
 * Create a reminder bound to the caller-selected Session without activating it.
 *
 * The request must supply a title; a missing, blank-after-trim, or over-long
 * title rejects with `invalid_prompt` instead of deriving one from the prompt.
 * The record is built from the clock reading taken before the request joins the
 * serialized queue, so a create that waits behind a longer operation keeps its
 * request-time anchor and may already be due when the queue reaches it.
 * @param sessionId - Original Session receiving the reminder.
 * @param request - Validated tool selector, required title, and reminder content.
 * @param signal - Optional cancellation checked before persistence begins, including after FIFO waits.
 * @returns The durably stored schedule. Cancellation does not roll back an in-flight write.
 */
async create(sessionId: SessionId, request: ScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleRecord>

/**
 * Read the selected Session's active tasks without resuming its Agent.
 * @param request - Session whose task list is requested.
 * @returns Persisted reminders in storage order.
 */
@Remote('list') async list(request: ScheduleListRequest): Promise<ScheduleRecord[]>

/**
 * Read all active and inactive Host reminders with their original Session bindings.
 * A deleted reminder has no row, so it is absent here.
 * Does not activate Sessions or read Session history.
 * @returns Reminders ordered by scheduledAt ascending, then lexicographically by id.
 */
@Remote('catalog') async catalog(): Promise<ScheduleCatalogEntry[]>

/**
 * Read saved inbox deliveries without activating or reading the original Session.
 * The task's own row supplies its binding, so its records stay readable through this lookup.
 * @param request - Session binding, task identity, explicit limit, and optional exclusive message cursor.
 * @returns Newest-first deliveries in append order, or a task/cursor lookup failure.
 * @throws ScheduleInputError when limit is not a safe integer from 1 through 100.
 */
@Remote('history') async history(request: ScheduleDeliveryHistoryRequest): Promise<ScheduleDeliveryHistoryResult>

/**
 * Delete one task belonging to the selected Session, leaving queued messages intact.
 *
 * The row is removed: the task no longer schedules, leaves `list` and `catalog`, and its
 * saved delivery records go with it.
 * @param request - Session and exact task identity.
 * @param signal - Optional cancellation checked before persistence begins, including after FIFO waits.
 * @returns Whether that Session owned a deleted task. Cancellation does not roll back an in-flight write.
 */
@Remote('delete') async delete(request: ScheduleDeleteRequest, signal?: AbortSignal): Promise<ScheduleDeleteResult>

/**
 * Update the name, instruction, and timing of an active task within the original Session
 * binding without activating the Session or changing saved deliveries.
 *
 * Each supplied field replaces its stored value; an omitted field keeps it. A name or
 * instruction change alone does not reset the committed target.
 * @param request - Task binding, complete observed record, and any combination of timing, name, and instruction.
 * @param signal - Cancellation checked after domain readiness and FIFO waits, before persistence begins.
 * @returns The committed record, unchanged record for a no-op, or a non-mutating input/lookup/conflict result.
 * Storage and lifecycle failures reject; cancellation after a write starts does not roll it back.
 */
@Remote('update') async update(request: ScheduleUpdateRequest, signal?: AbortSignal): Promise<ScheduleUpdateResult>
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
<!-- END GENERATED cordis-surface -->
