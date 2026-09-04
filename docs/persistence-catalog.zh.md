<!-- 英文源文件由 scripts/gen-persistence-catalog.ts 生成；本中文文件是通过双语配对维护的经评审对侧。
     更新时先运行 `pnpm run gen-persistence-catalog` 更新英文，再更新本文件并运行 `pnpm run verify-translation-pairing --write docs/persistence-catalog.md` 重新记录配对。 -->

# 会话持久化事件目录

[English](persistence-catalog.md) | 中文

会话持久事件日志中可能出现的所有事件类型：完整持久化的 `SessionEvent` 信封，以及可通过合并扩展的 `SessionEventMap` 中的每个成员，包括 `@deepseek-ai/dsh-session` 所属的词汇和本仓库中每个插件对 `@deepseek-ai/dsh-session/types` 的声明合并，并附有源 JSDoc、完整 payload 声明、surface 标记和声明位置。本文档是 [session.md](subsystems/session.zh.md)（surface 排序与 `deriveMessages()` 投影）、[persistence.md](subsystems/persistence.zh.md)（如何让日志持久化）和 [session.md](subsystems/session.zh.md#cordis-surface) 中生成区域（实时总线接线；日志事件**不是** cordis 事件，它通过唯一的 `session/event` emit 到达监听器）的补充。

英文源文件根据源码生成（`scripts/gen-persistence-catalog.ts`），并由 `pnpm run verify-persistence-catalog`（`doc-sync`（文档同步门禁）的一部分）验证新鲜度；本中文文件作为经评审对侧通过双语配对维护。声明块保留源码声明和嵌套属性的 JSDoc，只移除其所在接口／模块带来的缩进，并使用 `ts persistence-catalog` 围栏（doc-typecheck 会跳过这些围栏，因为声明引用了其所属模块中的类型）。payload 中的类型名称会链接到记录该类型的页面。参见 [persistence-log-catalog Agent Note](../.agents/notes/archived/process/2026-07-04-persistence-log-catalog.md)。

以下信封声明组合了每个事件的 `type`、单调递增的 `seq`、以 epoch 毫秒表示的 `time`、`data`、可选的未知类型跳过标记 `ignorable`，以及条件字段 `surfaceOp`／`sourceEventSeqs`。**surface** 表示 `SurfaceEventType` 成员：它会生成一条 LLM（大语言模型）消息，并声明该事件如何加入 surface 列表。**log-only** 表示其他所有事件：这类记录可持久化、可回放，但不参与派生历史。每个 payload 均可进行 JSON 序列化（在 `Session.append` 处强制执行）。当前 writer 会写入 `SESSION_FORMAT_VERSION`；受支持的历史产物通过构建期静态相邻迁移目录进入这套当前词汇（参见[版本生命周期](subsystems/persistence.zh.md)）。范围仅限本仓库中的包；下游插件可以继续合并其他当前版本事件类型，这些类型按设计不属于本目录，并且在后续格式迁移边中需要显式 disposition。

## 事件信封

```ts persistence-catalog
/** The appendable event-type keys of {@link SessionEventMap}, plugin-merged extensions included. */
export type SessionEventType = keyof SessionEventMap

/**
 * The subset of {@link SessionEventType} values whose events produce LLM
 * messages and are eligible to appear on the ordered surface. Only these
 * event types may carry {@link SurfaceOp}; user and tool events may also cite
 * earlier sources through {@link SessionEvent.sourceEventSeqs}.
 */
export type SurfaceEventType =
  | 'user/message'
  | 'assistant/message'
  | 'tool/result'

/**
 * How a session event entered the ordered surface. Only valid on
 * {@link SurfaceEventType} events.
 *
 * - `'append'`: added to the tail — normal path for user/assistant/tool
 *   messages.
 * - `{ op: 'replace', start, end }`: replaces surface nodes from `start`
 *   (inclusive) through `end` (inclusive) with this node. Both must exist as
 *   surface nodes in the current surface. `start === end` replaces a single
 *   node. The node's {@link SessionEvent.sourceEventSeqs} must include every
 *   shadowed surface node. Used by compaction; any surface-replacing producer
 *   may use it.
 */
export type SurfaceOp =
  | 'append'
  | { op: 'replace'; start: SessionSeq; end: SessionSeq }

/**
 * One immutable entry in the session log.
 *
 * A proper discriminated union over `type` (not independent `type`/`data`
 * unions), so `switch (event.type)` narrows `event.data` without casts.
 *
 * The {@link sourceEventSeqs} and {@link surfaceOp} fields are conditional:
 * they only exist on {@link SurfaceEventType} variants (`user/message`,
 * `assistant/message`, `tool/result`).
 * Non-surface events (boundary markers, attempts, errors) never carry
 * surface metadata — the compiler enforces this at `Session.append()`
 * call sites.
 */
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K
    /** Monotonic sequence number within the session. */
    seq: SessionSeq
    /** Unix epoch milliseconds. */
    time: number
    data: SessionEventMap[K]
    /**
     * Marks an event a reader may safely skip when it does not recognize
     * `type`. Absent means required: a reader meeting an unrecognized type
     * without this marker MUST refuse to reconstruct the session instead of
     * silently dropping the event, because an unrecognized required event may
     * change how the rest of the log is interpreted. A writer sets `true` only
     * on purely informational records whose loss cannot affect reconstruction;
     * defaulting to required means a forgotten marker over-refuses (an
     * inconvenience) rather than silently resuming a gutted session.
     */
    ignorable?: true
  } & (K extends SurfaceEventType ? {
    /**
     * Seq numbers of earlier events that this event cites as sources, such as
     * the surface nodes shadowed by a compaction replacement. A v2
     * `assistant/message` embeds its provider stream and cannot carry this field.
     */
    sourceEventSeqs?: SessionSeq[]
    /** How this event entered the surface; absent for non-surface events. */
    surfaceOp?: SurfaceOp
  } : object)
}[T]
```

来源：[`packages/core/session/src/types.ts:379`](../packages/core/session/src/types.ts) · [`packages/core/session/src/types.ts:387`](../packages/core/session/src/types.ts) · [`packages/core/session/src/types.ts:416`](../packages/core/session/src/types.ts) · [`packages/core/session/src/types.ts:447`](../packages/core/session/src/types.ts)

## 事件

### `agent/*`

<a id="agentinboxspliced--log-only"></a>

#### `agent/inbox/spliced` — log-only

```ts persistence-catalog
/**
 * One normalized mutation of an agent's durable pending-message lists.
 * Live dispatch precedes projection mutation, so synchronous observers may
 * read the pre-splice inbox to recover the removed messages.
 */
'agent/inbox/spliced': {
  target: InboxTarget
  start: number
  removedCount?: number
  inserted: UserMessage[]
  outcome?: 'canceled'
}
```

来源：[`packages/core/agent/src/types.ts:58`](../packages/core/agent/src/types.ts)

### `agent-preset/*`

<a id="agent-presetselected--log-only"></a>

#### `agent-preset/selected` — log-only

```ts persistence-catalog
/**
 * The session's agent preset was chosen after creation, while the session
 * was still blank. Log-only: it records the composition later turns ran
 * under, so a resumed or forked session rebuilds the same one instead of
 * the header's creation-time value.
 */
'agent-preset/selected': { agentPreset: string }
```

来源：[`packages/preset/agent-presets/src/session.ts:28`](../packages/preset/agent-presets/src/session.ts)

### `approval/*`

<a id="approvalasked--log-only"></a>

#### `approval/asked` — log-only

```ts persistence-catalog
/**
 * An approval question was put to the answerer chain — log-only audit
 * (like `hook/*`; NOT a surface event, carries no `surfaceOp`). `id` pairs
 * it with the `approval/decided` that always follows; `toolName` is the
 * tool the question is about, `callId` the exact tool call when the asker
 * had one, `reason` the asker's human-readable explanation (e.g. a hook's
 * permission-decision reason).
 */
'approval/asked': {
  id: ApprovalRequestId
  toolName: string
  callId?: ToolCallId
  reason?: string
}
```

类型：[ToolCallId](subsystems/core.zh.md)

来源：[`packages/interaction/user-approval/src/types.ts:44`](../packages/interaction/user-approval/src/types.ts)

<a id="approvaldecided--log-only"></a>

#### `approval/decided` — log-only

```ts persistence-catalog
/**
 * The outcome of a prior `approval/asked` (same `id`) — log-only audit.
 * Exactly one per ask, appended when the outcome is known: a decision, a
 * cancellation, or the fail-closed `'unavailable'`.
 */
'approval/decided': {
  id: ApprovalRequestId
  outcome: ApprovalOutcome
}
```

来源：[`packages/interaction/user-approval/src/types.ts:55`](../packages/interaction/user-approval/src/types.ts)

<a id="approvalpolicy--log-only"></a>

#### `approval/policy` — log-only

```ts persistence-catalog
/**
 * The session's approval policy was switched — log-only, durable,
 * replayable, never in the model transcript (the model learns the policy
 * from the runtime-context snapshot and live switch notices). The LAST
 * such event is the session's override.
 * `source: 'delegation'` marks an override seeded into a child; an absent
 * source is a runtime switch.
 */
'approval/policy': {
  policy: ApprovalPolicy
  /** Marks an override seeded into a child at delegation. */
  source?: 'delegation'
}
```

来源：[`packages/interaction/user-approval/src/index.ts:32`](../packages/interaction/user-approval/src/index.ts)

### `assistant/*`

<a id="assistantattempt--log-only"></a>

#### `assistant/attempt` — log-only

```ts persistence-catalog
/**
 * One model attempt that committed no surface message. The embedded stream
 * preserves a failed, retried, cancelled, or stream-error attempt that
 * reached settlement without fabricating model-visible history.
 */
'assistant/attempt': { turn: number; step: number; stream: AssistantStreamRecord[] }
```

来源：[`packages/core/session/src/types.ts:313`](../packages/core/session/src/types.ts)

<a id="assistantmessage--surface"></a>

#### `assistant/message` — surface

```ts persistence-catalog
/**
 * Assembled assistant message for one step (derived history uses this).
 * Carries the step's `usage` when the adapter reported token accounting, so
 * the model output and its accounting travel together (there is no separate
 * usage record). `usage` is absent when the adapter reported none. A turn
 * cancelled mid-stream finalizes its delivered text/reasoning prefix as this
 * event with `interrupted: true`; undispatched tool calls are absent. The
 * marker distinguishes that prefix without re-deriving interruption from turn
 * boundaries. An aborted turn with no such event streamed no visible content.
 */
'assistant/message': {
  turn: number
  step: number
  message: AssistantMessage
  /** Exact timed model stream, compacted without joining delta boundaries. */
  stream: AssistantStreamRecord[]
  usage?: TokenUsage
  interrupted?: true
}
```

类型：[TokenUsage](subsystems/llm-streaming.zh.md)

来源：[`packages/core/session/src/types.ts:299`](../packages/core/session/src/types.ts)

### `command/*`

<a id="commanddone--log-only"></a>

#### `command/done` — log-only

```ts persistence-catalog
/**
 * The paired command settled. `kind`/`text` carry the handler's verbatim
 * outcome (a thrown/aborted handler settles as `kind: 'error'` with the
 * rendered failure). A successful command may identify the earlier
 * authoritative domain event for a richer client-computed presentation.
 */
'command/done': {
  commandId: CommandId
  kind: 'success' | 'error'
  text?: string
  sourceEventSeq?: import('@deepseek-ai/dsh-session/types').SessionSeq
}
```

来源：[`packages/interaction/commands/src/types.ts:104`](../packages/interaction/commands/src/types.ts)

<a id="commandrun--log-only"></a>

#### `command/run` — log-only

```ts persistence-catalog
/**
 * A resolved slash command entered its handler. Log-only (never model
 * surface); paired with `command/done` by `commandId`, mirroring the
 * `tool/call`↔`tool/result` pairing. The payload is structured — `name`
 * and `args` are `parseCommand`'s own split (name and verbatim rawInput,
 * separator whitespace included), so a consumer (a projection unit
 * folding its own command records, a rich command card) never re-parses
 * a line. `args` is absent when the definition sets `recordInput: false`
 * because an authoritative domain event owns the input payload.
 */
'command/run': { commandId: CommandId; name: string; args?: string; source: CommandSource }
```

来源：[`packages/interaction/commands/src/types.ts:97`](../packages/interaction/commands/src/types.ts)

### `compaction/*`

<a id="compactionend--log-only"></a>

#### `compaction/end` — log-only

```ts persistence-catalog
/**
 * Marks the end of a compaction — log-only, releases the lock. Its owner
 * matches `compaction/start`; `error` records an unsuccessful attempt.
 */
'compaction/end': { compactionId: CompactionId; sourceCommandId?: CommandId; turn: number | null; error?: string }
```

来源：[`packages/compaction/compaction/src/types.ts:72`](../packages/compaction/compaction/src/types.ts)

<a id="compactionprune--log-only"></a>

#### `compaction/prune` — log-only

```ts persistence-catalog
/**
 * Shadow price of one model-free prune replacement — log-only, no
 * surfaceOp. The shared shadow-price protocol: a surface `replace` event
 * is priced by the metering event immediately before it (`compaction/summary`
 * for a summarizing compaction, this event for a prune), which states the
 * heuristic token price of the exact replaced range so a pure consumer
 * can subtract it without retaining per-node prices. The replacement MUST
 * be appended synchronously right after this event.
 */
'compaction/prune': {
  /** The replaced range's first and last surface-node seqs (a surface-position span, like {@link CompactionResult.shadowedRange}). */
  shadowedRange: { start: SessionSeq; end: SessionSeq }
  /** The seqs of all shadowed surface nodes, in surface order. */
  shadowedSeqs: SessionSeq[]
  /** Heuristic price of the shadowed content under the token-meter's fixed estimator. */
  shadowedTokenCount: number
}
```

来源：[`packages/compaction/compaction/src/types.ts:82`](../packages/compaction/compaction/src/types.ts)

<a id="compactionstart--log-only"></a>

#### `compaction/start` — log-only

```ts persistence-catalog
/**
 * Marks the start of a compaction — log-only, holds the lock until
 * `compaction/end`. A numbered owner is strictly enclosed by that open turn;
 * `null` identifies a standalone manual transaction between turns.
 */
'compaction/start': { compactionId: CompactionId; sourceCommandId?: CommandId; turn: number | null }
```

来源：[`packages/compaction/compaction/src/types.ts:24`](../packages/compaction/compaction/src/types.ts)

<a id="compactionsummary--log-only"></a>

#### `compaction/summary` — log-only

```ts persistence-catalog
/**
 * Completed summary, its inputs, and its model call facts — log-only, no surfaceOp.
 * The summary content is in `data.summary`; the actual surface replacement
 * is performed by the immediately following `user/message` event that
 * shadows the compacted range. That adjacency is contractual — the
 * shadowed pricing fields are the replacement's shadow price, so a
 * consumer may pair a replacement with the metering event directly
 * before it (`compaction/prune` documents the shared protocol).
 */
'compaction/summary': {
  compactionId: CompactionId
  sourceCommandId?: CommandId
  summary: ContentBlock[]
  shadowedRange: { start: SessionSeq; end: SessionSeq }
  shadowedSeqs: SessionSeq[]
  shadowedTokenCount: number
  /** The provider route that wrote the summary. */
  provider: string
  /**
   * The model that wrote the summary — the summarize call's envelope,
   * reported by the backend that made the call, logged so the one-shot
   * request is reconstructable from log + code and "which model wrote
   * this summary" has a durable answer (the reconstructability Agent Note).
   */
  model: string
  /** The generation cap the summarize call sent, when one applied. */
  maxTokens?: number
  /** Provider-reported token usage for the summarization request, when emitted. */
  usage?: TokenUsage
} & (
  | {
    /** Complete provider output before the backend's safe summary projection. */
    rawOutput: ContentBlock[]
    /** Identifies exactly one call through this context's `ctx.llm.stream()`. */
    llmStreamCall: true
  }
  | {
    /** Optional complete output from an unmarked template, remote, or other summarizer. */
    rawOutput?: ContentBlock[]
    /** An unmarked summary does not identify a call through this context's LLM seam. */
    llmStreamCall?: never
  }
)
```

类型：[ContentBlock](subsystems/core.zh.md) · [TokenUsage](subsystems/llm-streaming.zh.md)

来源：[`packages/compaction/compaction/src/types.ts:34`](../packages/compaction/compaction/src/types.ts)

### `feedback/*`

<a id="feedbackrecord--log-only"></a>

#### `feedback/record` — log-only

```ts persistence-catalog
/**
 * One recorded human remark about this session. Log-only and independent
 * of its trigger; it never enters model context or derived history.
 */
'feedback/record': { text: string }
```

来源：[`packages/feedback/command-feedback/src/index.ts:62`](../packages/feedback/command-feedback/src/index.ts)

### `goal/*`

<a id="goalchange--log-only"></a>

#### `goal/change` — log-only

```ts persistence-catalog
/**
 * Complete post-mutation goal state or clear tombstone.
 */
'goal/change': GoalChangeMeta
```

来源：[`packages/goal/goal/src/domain.ts:66`](../packages/goal/goal/src/domain.ts)

### `hook/*`

<a id="hookinvoked--log-only"></a>

#### `hook/invoked` — log-only

```ts persistence-catalog
/**
 * A hook command was invoked at a hook point — a log-only record (like
 * `compaction/*`; NOT a {@link SurfaceEventType}, carries no `surfaceOp`).
 * `dialect` is the bridge that ran it (`claude`/`codex`), `point`
 * the hook point (`PreToolUse`, `Stop`, …), `matcher` the matcher-group
 * pattern that selected it (absent for match-all), `handlerId` a stable id
 * for the command (so an invoked/result pair correlates). `turn` is the open
 * turn the invocation lives inside.
 */
'hook/invoked': {
  turn: number
  point: string
  dialect: HookDialect
  matcher?: string
  handlerId: string
}
```

来源：[`packages/hooks/hook-protocol/src/types.ts:19`](../packages/hooks/hook-protocol/src/types.ts)

<a id="hookresult--log-only"></a>

#### `hook/result` — log-only

```ts persistence-catalog
/**
 * Log-only outcome paired to `hook/invoked` by `handlerId`. Decision is the
 * parsed permission result, `stop` for `continue:false`, or `pass`; exit code
 * may be absent, stderr is bounded, and duration is wall-clock runtime.
 */
'hook/result': {
  turn: number
  point: string
  handlerId: string
  decision: string
  exitCode?: number
  stderrSummary?: string
  durationMs: number
}
```

来源：[`packages/hooks/hook-protocol/src/types.ts:31`](../packages/hooks/hook-protocol/src/types.ts)

### `llm/*`

<a id="llmretry--log-only"></a>

#### `llm/retry` — log-only

```ts persistence-catalog
/** Durable, non-surface record of one provider-routed retry scheduled after a failed request attempt. */
'llm/retry': LlmRetryEventData
```

来源：[`packages/llm/llm-retry/src/types.ts:9`](../packages/llm/llm-retry/src/types.ts)

<a id="llmretry-started--log-only"></a>

#### `llm/retry-started` — log-only

```ts persistence-catalog
/** Durable transition written after a retry wait succeeds and before the next request attempt starts. */
'llm/retry-started': LlmRetryStartedEventData
```

来源：[`packages/llm/llm-retry/src/types.ts:11`](../packages/llm/llm-retry/src/types.ts)

### `model/*`

<a id="modelselection--log-only"></a>

#### `model/selection` — log-only

```ts persistence-catalog
/**
 * Complete validated model selection requested for subsequent prompt
 * assembly. Log-only: it never enters derived model history.
 */
'model/selection': ModelSelection
```

来源：[`packages/api/session-controller/src/types.ts:41`](../packages/api/session-controller/src/types.ts)

### `permission/*`

<a id="permissionpreset--log-only"></a>

#### `permission/preset` — log-only

```ts persistence-catalog
/**
 * Records the selected preset as durable, log-only user intent. The knob
 * events follow in the same turn and control execution; this event stays
 * out of the model transcript and lets the permission projection unit
 * preserve a selection when bundles match.
 */
'permission/preset': { preset: string }
```

来源：[`packages/interaction/permission-presets/src/index.ts:53`](../packages/interaction/permission-presets/src/index.ts)

### `plan/*`

<a id="planmode--log-only"></a>

#### `plan/mode` — log-only

```ts persistence-catalog
/**
 * Whether plan mode is in force from this point on: log-only, non-surface,
 * whole-value replace. The last `plan/mode` wins; a log with none folds to
 * inactive through the projection unit's fold.
 */
'plan/mode': { active: boolean }
```

来源：[`packages/plan/plan-mode/src/index.ts:46`](../packages/plan/plan-mode/src/index.ts)

### `request/*`

<a id="requestcontext--log-only"></a>

#### `request/context` — log-only

```ts persistence-catalog
/**
 * Route metadata for the next request, logged only when the route or capacity
 * changes. It does not participate in request reconstruction or header equality.
 */
'request/context': RequestContext
```

来源：[`packages/core/session/src/types.ts:341`](../packages/core/session/src/types.ts)

<a id="requestheader--log-only"></a>

#### `request/header` — log-only

```ts persistence-catalog
/**
 * Full header for the next request, appended inside its step before dispatch.
 * It is log-only; the latest snapshot reconstructs the request header.
 */
'request/header': {
  header: EpochHeader
  reason: RequestHeaderReason
  /** A changed header also begins a distinct model-message series. */
  startsSeries?: true
}
```

来源：[`packages/core/session/src/types.ts:331`](../packages/core/session/src/types.ts)

### `sandbox/*`

<a id="sandboxmode--log-only"></a>

#### `sandbox/mode` — log-only

```ts persistence-catalog
/**
 * The session's sandbox mode was switched — log-only (like `approval/*`;
 * NOT a surface event, carries no `surfaceOp`): durable and replayable,
 * never in the model transcript. The LAST such event is the session's
 * override (folded by the sandboxMode projection unit). `source: 'delegation'` marks
 * an override seeded into a child; an absent source is a runtime switch.
 */
'sandbox/mode': {
  mode: SandboxMode
  /** Marks an override seeded into a child at delegation. */
  source?: 'delegation'
}
```

来源：[`packages/sandbox/sandbox-policy/src/session-mode.ts:33`](../packages/sandbox/sandbox-policy/src/session-mode.ts)

### `schedule/*`

<a id="schedulechange--log-only"></a>

#### `schedule/change` — log-only

```ts persistence-catalog
/**
 * Versioned Schedule mutation. The owning package validates the complete
 * session-local transition stream before accepting a candidate event.
 */
'schedule/change': ScheduleChange
```

类型：[ScheduleChange](subsystems/schedule.zh.md)

来源：[`packages/schedule/schedule/src/types.ts:219`](../packages/schedule/schedule/src/types.ts)

### `session/*`

<a id="sessionend-seed--log-only"></a>

#### `session/end-seed` — log-only

```ts persistence-catalog
/**
 * Marks the end of a constructor seed. Events before it have smaller seq
 * values and came from the seed (resume, fork, or replay); this lifecycle
 * produced none of them. This log-only event is the durable projection of
 * {@link Session.firstLiveSeq}.
 *
 * A fresh fork child owns one `{ inherited: true }` marker at its exact
 * inherited-prefix cut, even when that prefix ends in an ancestor marker.
 * The last tagged marker is the current Session's cut; untagged markers keep
 * ordinary restore and replay lifecycle boundaries.
 *
 * `Session`'s constructor is the only legitimate writer. The invariant
 * companion deliberately constrains nothing here, so a plugin appending one
 * would silently classify every live bracket before it as seed history.
 *
 * An owner of a standalone open/close bracket (`compaction/start` …
 * `compaction/end`) reads it because seed history and live work are otherwise
 * byte-identical: an unmatched opening marker before this event belongs to
 * an ended lifecycle, whatever ended it. NOT a liveness signal about other
 * writers — a concurrently live session holds its own boundary elsewhere,
 * so tolerating concurrent writers needs a signal beyond the log.
 */
'session/end-seed': { inherited?: true }
```

来源：[`packages/core/session/src/types.ts:375`](../packages/core/session/src/types.ts)

<a id="sessiontitle--log-only"></a>

#### `session/title` — log-only

```ts persistence-catalog
/**
 * Latest-wins session title snapshot. Log-only: it never enters the model
 * surface or derived history.
 */
'session/title': SessionTitleEventData
```

类型：[SessionTitleEventData](subsystems/session-title.zh.md)

来源：[`packages/session/session-title/src/index.ts:77`](../packages/session/session-title/src/index.ts)

<a id="sessiontitle-llm-request--log-only"></a>

#### `session/title-llm-request` — log-only

```ts persistence-catalog
/** Log-only pre-dispatch record of one session-title model request. */
'session/title-llm-request': SessionTitleLlmRequestEventData
```

类型：[SessionTitleLlmRequestEventData](subsystems/session-title.zh.md)

来源：[`packages/session/session-title-llm/src/index.ts:45`](../packages/session/session-title-llm/src/index.ts)

### `session-log-deepseek/*`

<a id="session-log-deepseekdelivery-accepted--log-only"></a>

#### `session-log-deepseek/delivery-accepted` — log-only

```ts persistence-catalog
/** Records that the configured endpoint accepted one delivery through `throughSeq`. */
'session-log-deepseek/delivery-accepted': {
  /** Session identity the accepted delivery carried; inherited fork markers retain the parent's id. */
  sessionId: import('@deepseek-ai/dsh-session/types').SessionId
  /** Accepted Session format generation; absence identifies version 0. */
  sessionFormatVersion?: number
  /** Last canonical event included in the accepted request. */
  throughSeq: import('@deepseek-ai/dsh-session/types').SessionSeq
}
```

来源：[`packages/session/session-log-deepseek/src/types.ts:59`](../packages/session/session-log-deepseek/src/types.ts)

### `step/*`

<a id="stepend--log-only"></a>

#### `step/end` — log-only

```ts persistence-catalog
/** Closes step `step` of turn `turn`. */
'step/end': { turn: number; step: number }
```

来源：[`packages/core/session/src/types.ts:281`](../packages/core/session/src/types.ts)

<a id="stepstart--log-only"></a>

#### `step/start` — log-only

```ts persistence-catalog
/** Opens step `step` of turn `turn` — one model call plus the tool executions it requested. */
'step/start': { turn: number; step: number }
```

来源：[`packages/core/session/src/types.ts:279`](../packages/core/session/src/types.ts)

### `subagent/*`

<a id="subagentdescriptor--log-only"></a>

#### `subagent/descriptor` — log-only

```ts persistence-catalog
/**
 * Durable identity and lifecycle mode of a session-backed subagent child,
 * appended once by the establishing provider inside the child's initial
 * turn, before its first request. Continuable records also carry their
 * resumable composition. Log-only: it carries no `surfaceOp`, never enters
 * model history, and survives compaction.
 */
'subagent/descriptor': SubagentDescriptorData
```

来源：[`packages/subagent/subagent/src/descriptor.ts:38`](../packages/subagent/subagent/src/descriptor.ts)

<a id="subagentmodel-selection-policy--log-only"></a>

#### `subagent/model-selection-policy` — 仅日志

```ts persistence-catalog
/**
 * Records that this session's delegation tool exposes child provider,
 * model, and reasoning-effort selection. Appended before the first model
 * request; absence means the fixed-route definition. Log-only: it carries
 * no `surfaceOp` and never enters model history.
 */
'subagent/model-selection-policy': {
  /** Exact routes this Session may select explicitly for a child. */
  allowedModels: AllowedModelRoute[]
}
```

来源：[`packages/subagent/tool-subagent/src/model-selection-state.ts:17`](../packages/subagent/tool-subagent/src/model-selection-state.ts)

### `team/*`

<a id="teammember--log-only"></a>

#### `team/member` — log-only

```ts persistence-catalog
/** Whole teammate lifecycle value, stored only in the Team Lead Session. */
'team/member': { version: 2; teamId: TeamId; member: TeamMemberSnapshot }
```

类型：[TeamId](subsystems/agent-team.zh.md) · [TeamMemberSnapshot](subsystems/agent-team.zh.md)

来源：[`packages/experimental/agent-team/src/types.ts:204`](../packages/experimental/agent-team/src/types.ts)

<a id="teammessagedelivered--log-only"></a>

#### `team/message/delivered` — log-only

```ts persistence-catalog
/** Durable acknowledgement that the target Session recorded the message. */
'team/message/delivered': {
  version: 2
  teamId: TeamId
  messageId: TeamMessageId
  targetId: SessionId
}
```

类型：[TeamId](subsystems/agent-team.zh.md) · [TeamMessageId](subsystems/agent-team.zh.md)

来源：[`packages/experimental/agent-team/src/types.ts:210`](../packages/experimental/agent-team/src/types.ts)

<a id="teammessagequeued--log-only"></a>

#### `team/message/queued` — log-only

```ts persistence-catalog
/** Durable mailbox enqueue, stored before delivery is attempted. */
'team/message/queued': { version: 2; teamId: TeamId; message: TeamMessageSnapshot }
```

类型：[TeamId](subsystems/agent-team.zh.md) · [TeamMessageSnapshot](subsystems/agent-team.zh.md)

来源：[`packages/experimental/agent-team/src/types.ts:208`](../packages/experimental/agent-team/src/types.ts)

<a id="teamtask--log-only"></a>

#### `team/task` — log-only

```ts persistence-catalog
/** Whole shared-task value, stored only in the Team Lead Session. */
'team/task': { version: 2; teamId: TeamId; task: TeamTaskSnapshot }
```

类型：[TeamId](subsystems/agent-team.zh.md) · [TeamTaskSnapshot](subsystems/agent-team.zh.md)

来源：[`packages/experimental/agent-team/src/types.ts:206`](../packages/experimental/agent-team/src/types.ts)

### `todo/*`

<a id="todowrite--log-only"></a>

#### `todo/write` — log-only

```ts persistence-catalog
/** Whole-list snapshot; latest write wins on replay. Log-only UI state; never derived history. */
'todo/write': { todos: TodoItem[] }
```

类型：[TodoItem](subsystems/todo.zh.md)

来源：[`packages/todo/tool-todo/src/types.ts:31`](../packages/todo/tool-todo/src/types.ts)

### `tool/*`

<a id="toolcall--log-only"></a>

#### `tool/call` — log-only

```ts persistence-catalog
/**
 * The model requested one tool invocation: `name` with the raw `arguments`
 * JSON string exactly as the model produced it (unparsed). `callId` pairs the
 * call with its `tool/result`.
 */
'tool/call': { turn: number; step: number; callId: ToolCallId; name: string; arguments: string }
```

类型：[ToolCallId](subsystems/core.zh.md)

来源：[`packages/core/session/src/types.ts:308`](../packages/core/session/src/types.ts)

<a id="toolcode-dispatch--log-only"></a>

#### `tool/code-dispatch` — log-only

```ts persistence-catalog
/**
 * One bridged sub-dispatch SETTLING: the pairing ids (matching the
 * `tool/code-dispatch-start` with the same `subCallId`), the tool `name`
 * with the same JSON-normalized `arguments`, and the sub-call's complete
 * model-facing outcome in `tool/result`'s own vocabulary
 * (`content` + `isError`), so UIs render a sub-call through the exact
 * code path that renders a native call. Every started sub-call settles
 * with exactly one of these (abort included: the aborted pipeline result
 * is an `isError` outcome).
 * Log-only: `deriveMessages()` ignores it, so sub-calls never re-enter
 * model context; persistence and UIs get every call. Appended inside the
 * parent `run_code`'s execution (the bridge drains in-flight dispatches
 * before returning), so its execution-enclosure relation holds by
 * construction.
 */
'tool/code-dispatch': PtcDispatchEventData
```

来源：[`packages/core/tools/src/types.ts:56`](../packages/core/tools/src/types.ts)

<a id="toolcode-dispatch-start--log-only"></a>

#### `tool/code-dispatch-start` — log-only

```ts persistence-catalog
/**
 * One sub-dispatch STARTING inside a `run_code` program: the parent
 * `run_code` call id, the deterministic sub-call id (`<parent>:code:<n>`,
 * numbered in submission order), and the tool `name` with its
 * JSON-normalized `arguments` — the exact value dispatched, normalized
 * BEFORE dispatch, so this append can never fail on payload shape.
 * Appended when the scheduler actually starts the call (not at
 * submission), so a start means the tool body pipeline was entered; a
 * call abandoned in the queue logs nothing. Log-only: `deriveMessages()`
 * ignores it; UIs use it for live per-sub-call running state and pair it
 * with `tool/code-dispatch` by `subCallId` (timing = the two events'
 * `time` fields).
 */
'tool/code-dispatch-start': PtcDispatchStartEventData
```

来源：[`packages/core/tools/src/types.ts:40`](../packages/core/tools/src/types.ts)

<a id="toolresult--surface"></a>

#### `tool/result` — surface

```ts persistence-catalog
/**
 * A completed tool call's model-facing result, optional internal failure
 * identity, and optional tool-private `meta` presentation payload. `meta` is
 * opaque to the core (the producing tool owns its shape and reads it back in
 * `presentResult`) but MUST be JSON-serializable: `Session.append`
 * runtime-validates all event data with `isJsonValue`, so a non-serializable
 * `meta` is rejected at the source, and the durable log reproduces the
 * identical card on replay. Absent
 * unless the tool attaches one (e.g. `dsh-tool-fs` carries its result-time
 * contextual diff here).
 */
'tool/result': {
  turn: number
  step: number
  message: ToolResultMessage
  error?: { name: string; code: string }
  meta?: JsonValue
}
```

来源：[`packages/core/session/src/types.ts:320`](../packages/core/session/src/types.ts)

### `tool-workflow/*`

<a id="tool-workflowagent-end--log-only"></a>

#### `tool-workflow/agent-end` — log-only

```ts persistence-catalog
/**
 * Records one member settlement.
 * @param data - run identity, paired member sequence, and outcome.
 */
'tool-workflow/agent-end': ToolWorkflowAgentEndData
```

来源：[`packages/workflow/tool-workflow/src/types.ts:57`](../packages/workflow/tool-workflow/src/types.ts)

<a id="tool-workflowagent-start--log-only"></a>

#### `tool-workflow/agent-start` — log-only

```ts persistence-catalog
/**
 * Records one published workflow member.
 * @param data - run identity, member sequence, display identity, and child Session.
 */
'tool-workflow/agent-start': ToolWorkflowAgentStartData
```

来源：[`packages/workflow/tool-workflow/src/types.ts:52`](../packages/workflow/tool-workflow/src/types.ts)

<a id="tool-workflowrun-end--log-only"></a>

#### `tool-workflow/run-end` — log-only

```ts persistence-catalog
/**
 * Closes one workflow record after cleanup.
 * @param data - stable run identity and terminal reason.
 */
'tool-workflow/run-end': ToolWorkflowRunEndData
```

来源：[`packages/workflow/tool-workflow/src/types.ts:62`](../packages/workflow/tool-workflow/src/types.ts)

<a id="tool-workflowrun-start--log-only"></a>

#### `tool-workflow/run-start` — log-only

```ts persistence-catalog
/**
 * Opens one top-level workflow record.
 * @param data - stable run identity and display name.
 */
'tool-workflow/run-start': ToolWorkflowRunStartData
```

来源：[`packages/workflow/tool-workflow/src/types.ts:47`](../packages/workflow/tool-workflow/src/types.ts)

### `turn/*`

<a id="turnend--log-only"></a>

#### `turn/end` — log-only

```ts persistence-catalog
/**
 * Closes turn `turn` with the {@link TurnEndReason} that ended it. A turn
 * with no entered step has no `step/start` or `step/end`. The loop does not await a
 * flush at turn boundaries: `dsh-session-checkpoint-policy` owns the
 * per-request durability checkpoint, and consumers that read storage after
 * `whenIdle()` flush themselves. Success commits the turn; rejection is
 * reported live and does not prevent later work.
 */
'turn/end': { turn: number; reason: TurnEndReason }
```

类型：[TurnEndReason](subsystems/session.zh.md)

来源：[`packages/core/session/src/types.ts:277`](../packages/core/session/src/types.ts)

<a id="turnstart--log-only"></a>

#### `turn/start` — log-only

```ts persistence-catalog
/**
 * Opens turn `turn` before the loop claims queued input or runs pre-step.
 * Rejection, empty input, cancellation, or failure may close it with no
 * step; otherwise the following identified `user/message` event or batch
 * records the messages entering the step.
 */
'turn/start': { turn: number }
```

来源：[`packages/core/session/src/types.ts:268`](../packages/core/session/src/types.ts)

### `user/*`

<a id="usermessage--surface"></a>

#### `user/message` — surface

```ts persistence-catalog
/**
 * A user-role message on the model-visible surface: a direct human prompt
 * (the queued message claimed for this turn), a synthetic `agent.inject()`
 * context (file-change notices, subdir AGENTS.md, skill content, cron
 * notifications, …), or an entered goal continuation round. All three
 * project their `content` verbatim; `source` tells them apart.
 */
'user/message': UserMessage
```

来源：[`packages/core/session/src/types.ts:289`](../packages/core/session/src/types.ts)

### `web/*`

<a id="webdeepseek-search-llm-request--log-only"></a>

#### `web/deepseek-search-llm-request` — log-only

```ts persistence-catalog
/** Secret-free auxiliary DeepSeek search request recorded before dispatch. */
'web/deepseek-search-llm-request': DeepSeekSearchLlmRequest
```

来源：[`packages/web/web-search-deepseek/src/provider.ts:83`](../packages/web/web-search-deepseek/src/provider.ts)
