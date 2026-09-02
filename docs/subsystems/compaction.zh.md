# 压缩（compaction）

[English](compaction.md) | 中文

压缩 seam 是一个[能力 seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md)，与 bash 一样分为 Service Definition（[dsh-compaction](../../packages/compaction/compaction)，`ctx.compaction`）、Service Provider（例如 [dsh-compaction-basic](../../packages/compaction/compaction-basic) 后端）和面向用户的 Consumer（[dsh-command-compact](../../packages/compaction/command-compact)）。压缩是**一项可选能力**，不属于 agent loop（智能体循环）主干，因此其词汇定义在此而非 [core.md](core.zh.md) 中。基于 tokenizer 或模板的后端是实现同一接口的兄弟包。与 bash 不同，该接口必然依赖 `dsh-session` 和 `dsh-llm`：其动词作用于 agent 所有的 `Session`，而其持久摘要事件使用 `ContentBlock` 词汇（见[压缩能力 seam Agent Note](../../.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.zh.md)）。

源码：[`packages/compaction/compaction/src/types.ts`](../../packages/compaction/compaction/src/types.ts)

## `compaction/*` 会话事件

压缩通过声明合并为 [`SessionEventMap`](session.zh.md) 扩展三种事件类型。三者都**仅写入日志**——它们记录锁、摘要、选中范围、被遮蔽事件 seq、token 数以及模型调用，绝不进入 surface。这里有意不扩展 `SurfaceEventType`（只有产生消息的事件才到达模型），因此摘要本身承载在另一条带有 `surfaceOp: { op: 'replace', start, end }` 的 `user/message` 上——这是摘要压缩执行的唯一 surface 变更。[Agent Note](../../.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.zh.md) 负责复用 `user/message` 的决策依据。

| 事件 | 载荷 | 作用 |
|---|---|---|
| `compaction/start` | `{ turn }` | 获取日志记录的锁；数字标识尚未结束的自动轮次，`null` 标识独立手动尝试 |
| `compaction/summary` | `{ summary, rawOutput?, llmStreamCall?, shadowedRange, shadowedSeqs, shadowedTokenCount, provider, model, maxTokens?, usage? }` | 安全摘要投影、可选的完整提供方输出与 usage、生成结果时恰好通过此上下文的 `ctx.llm.stream()` 发起一次调用所带的 `llmStreamCall: true` 标记（此时必须提供完整的 `rawOutput`）、被遮蔽的 surface 边界对（`start`/`end` seq——位置跨度，而非数值区间）、按 surface 顺序排列的被遮蔽 seq、估算 token 数，以及摘要调用的 envelope（`provider`、`model`，若有生成上限则还包括该上限）——写入日志后，该一次性请求可由日志 + 代码重建（见可重建性 Agent Note）；未带标记的 `rawOutput` 并不能判定调用路径 |
| `compaction/end` | `{ turn, error? }` | 使用相同的数字或 `null` 归属值释放锁（`error` 记录失败尝试） |

锁括住**整个**操作：先追加 `compaction/start`，然后执行摘要生成、写入 `compaction/summary` 记录与 `user/message` 替换，最后才追加 `compaction/end`。最后释放锁意味着操作中途崩溃会表现为可检测的遗留锁（有 `compaction/start` 而无匹配的 `compaction/end`），而非一个虚假声称压缩已完成的 `compaction/end`。

这些标记表示锁的时间点，而不是排他的容器。摘要等待期间，不相关的空闲注入可以出现在独立的手动 start 与 end 之间。手动路径只重新验证所选位置 span，因此替换检查点之后仍保留该注入上下文。活动的未匹配 start 会阻塞所有入口点；较新 `session/end-seed` 之前的未匹配 start 是先前生命周期留下的陈旧证据，会被忽略。

这些变体在 `declare module '@deepseek-ai/dsh-session/types'` 块内合并，因此——与其他子系统页面上的顶层类型不同——它们不以漂移检查的 ` ```ts type-equiv ` 块粘贴（`verify-type-equiv` 提取器只按名称匹配顶层声明）。上方的载荷表即为目录条目；权威字段请循源码链接查看。

## `CompactionResult`

成功压缩向调用方返回：记账事件 seq、安全摘要投影、被遮蔽的范围与 seq，以及估算 token 数。

```ts type-equiv
/** Result of a successful compaction operation. */
interface CompactionResult {
  /** Stable identity shared by this compaction's complete durable lifecycle. */
  compactionId: CompactionId
  /** Human command that initiated this compaction, when it was manual. */
  sourceCommandId?: CommandId
  /** The seq of the appended `compaction/start` event. */
  startSeq: SessionSeq
  /** The seq of the appended `compaction/summary` event. */
  summarySeq: SessionSeq
  /** The seq of the appended `compaction/end` event. */
  endSeq: SessionSeq
  /** The summary content blocks produced by the backend. */
  summary: ContentBlock[]
  /**
   * The surface-boundary pair that was shadowed: the seqs of the first
   * (`start`) and last (`end`) surface nodes of the replaced range. A
   * surface-POSITION span, not a numeric seq interval — after a prior replace
   * lands a fresh high-seq summary node at an older range's position, `start`
   * can be GREATER than `end`. {@link CompactionResult.shadowedSeqs} is the
   * authoritative set of shadowed nodes, in surface order.
   */
  shadowedRange: { start: SessionSeq; end: SessionSeq }
  /** The seqs of all shadowed surface nodes, in surface order. */
  shadowedSeqs: SessionSeq[]
  /** Estimated token count of the shadowed content. */
  shadowedTokenCount: number
}
```

## 服务

自动调用方会说明策略为何运行；实现可以比普通压力更激进地处理已确认的溢出。

```ts type-equiv
/** Why automatic policy is asking a backend to consider compaction. */
type CompactionTrigger = 'pressure' | 'context-overflow'
```

`CompactionEngine` 暴露 `compactIfNeeded(agent, trigger, signal)` 以执行自动 `pressure` 或 `context-overflow` 策略，暴露 `compactNow(agent, signal)` 以便即使未达到压力也对空闲会话进行一次有效缩减，还针对显式、两端均包含的 surface 范围暴露 `compactRegion(...)`。`compactNow()` 作为轮次之间的 agent maintenance 运行；没有有效范围时返回 `null` 且不写入；在摘要前记录独立的 `turn: null` 标记对，并在后续排队提示词能够从新表层派生前 flush 已闭合尝试。每个后端都使用 `compactCheckpointSource(compactionId, sourceCommandId?)` 创建替换用 `user/message` 的源；client 与 wire 消费方从无 Cordis 的 `@deepseek-ai/dsh-compaction/checkpoint` 子路径导入该构造函数、`CompactionCheckpointSource` 和 `isCompactCheckpointSource()`，包根则为 host 消费方重新导出它们。必填的事务身份会关联替换检查点，而该判定函数使检查点识别不依赖任一特定后端。实现必须把传入的 signal 转发给摘要流程。该 seam 不拥有计价 API：单例 [`ctx.tokenMeter`](token-meter.zh.md) 直接拥有估算与回放，而 `dsh-compaction-basic` 拥有保留策略、事件排序、按路由执行的摘要调用及其配置。

预期的手动失败使用 `ManualCompactionErrorCode`：

```ts type-equiv
/** Expected failure classes for an explicit idle-session compaction request. */
type ManualCompactionErrorCode =
  | 'busy'
  | 'cancelled'
  | 'changed'
  | 'summary'
  | 'commit'
  | 'persistence'
```

`changed` 和 `summary` 保持会话表层不变，但仍会闭合失败尝试并将其持久化到日志。`commit` 可能发生在部分变更之后；`persistence` 表示内存中的标记对已闭合，但 flush 失败。取消独立于这些失败，并在完成必要清理后抛出原始 abort 原因。

压力压缩在 `agent/pre-step` waterfall（瀑布式事件）中运行，先于请求推导。一旦压力或规范化溢出满足条件，compaction-basic 会在选择范围前调用可选的 [`ctx.toolResultPruner`](../../packages/compaction/compaction-tool-result-pruner/README.zh.md)，再通过 `ctx.tokenMeter` 重新测量，并且可以在不生成摘要的情况下推进 surface。失败请求的恢复在失败的步骤关闭后通过 `agent/request-error` 运行；仅当 surface replacement generation 前进时才返回重试动作，即便后续摘要工作在剪枝后抛异常亦如此；取消仍然优先。区域边界保持工具调用/结果配对，但不保持整个轮次，因此一个过大轮次中较早关闭的步骤可以被压缩。`dsh-compaction-basic` 拥有阈值、保留尾部策略、溢出上限与失败处理。

该 Service Definition 导出 `toolPairingBalancedBefore(session, seq)` 与 `toolPairingBalancedAfter(session, seq)`，用于检查 seq 之前与之后的工具调用/结果配对。两者都会验证当前 surface 成员关系，并拒绝缺失的 seq 与遗留结果；[包约定](../../packages/compaction/compaction/README.zh.md#tool-pairing-boundaries)定义其缓存行为。

## 工具结果剪枝产出

可选的工具结果剪枝服务会报告每次持久内容替换以及 Unicode code point 的总减少量。其公开结果类型位于 [`compaction-tool-result-pruner/src/types.ts`](../../packages/compaction/compaction-tool-result-pruner/src/types.ts)。

```ts type-equiv
/** Cited source event and size accounting for one landed surface replacement. */
interface PrunedEntry {
  /** Full-fidelity tool-result event shadowed by the replacement. */
  readonly originalSeq: SessionSeq
  /** Newly appended pruned tool-result event. */
  readonly replacementSeq: SessionSeq
  /** Tool call shared by the original and replacement. */
  readonly callId: ToolCallId
  /** Original text size in Unicode code points. */
  readonly charsBefore: number
  /** Replacement text size in Unicode code points. */
  readonly charsAfter: number
}
```

```ts type-equiv
/** Aggregate outcome of one stable-surface pruning pass. */
interface PruneResult {
  /** Replacements in the snapshotted surface order. */
  readonly pruned: readonly PrunedEntry[]
  /** Total Unicode code points removed across replacements. */
  readonly charsRemoved: number
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcompaction--compactionengine-abstract-seam"></a>

### `ctx.compaction` — `CompactionEngine` (abstract seam)

Abstract compaction service. Implementations own trigger policy, retention, and summarization, and may consume a separate measurement service. A successful run replaces the selected surface span with one summary node and prevents concurrent compaction of the same session. The replacement user message uses compactCheckpointSource with the transaction identity so consumers recognize and correlate it independently of the backend. Load one implementation per context as `ctx.compaction`.

```ts cordis-catalog
/**
 * Consider automatic compaction for one explicit trigger. Pressure policy
 * uses the latest durable routed request, while context-overflow policy may
 * force a useful balanced reduction even below the normal threshold. Return
 * `null` when no safe range can be compacted. A single oversized retained
 * unit or request envelope cannot be repaired through surface compaction.
 *
 * @param agent - agent context owning the session surface and routing options.
 * @param trigger - normal pressure or provider-confirmed context overflow.
 * @param signal - cancellation signal; model-backed implementations must forward it.
 * @returns the compaction result, or `null` if no compaction was needed.
 */
abstract compactIfNeeded( agent: CompactionAgentContext, trigger: CompactionTrigger, signal: AbortSignal, ): Promise<CompactionResult | null>

/**
 * Explicitly compact useful history even below automatic pressure thresholds.
 * Implementations synchronously start an idle task before any asynchronous
 * work, select a useful range without writing on a no-op, then
 * append a standalone `compaction/start` before summarization. That durable
 * marker is the compaction lock until one `compaction/end` attempt. Later waking
 * prompts remain accepted in FIFO order and start only after the optional
 * durability checkpoint and idle-task settlement. Context injected while the
 * summary runs may sit between the marker pair; only the selected span must
 * remain stable.
 *
 * @param agent - idle agent whose durable history should be compacted.
 * @param signal - cancellation scoped to this compaction request.
 * @param sourceCommandId - initiating command identity for a manual compaction.
 * @returns the compaction result, or `null` when no safe useful range exists.
 * @throws {@link ManualCompactionError} for expected busy, agent-cancellation,
 * changed-span, summarization/shrink, commit-stage, or persistence failures;
 * an aborted request preserves its exact abort reason. Failed attempts remain
 * visible in the log.
 */
abstract compactNow( agent: ManualCompactAgentContext, signal: AbortSignal, sourceCommandId?: CommandId, ): Promise<CompactionResult | null>

/**
 * Forcibly compact a range of surface nodes into a single summary node.
 * `start` and `end` name an inclusive span by surface position, not numeric seq
 * order; replacements can make visible seqs non-monotonic. Both edges must be
 * balanced so assistant tool calls remain paired with their results. A model-
 * backed implementation forwards cancellation and rejects active, missing,
 * reversed, or unbalanced ranges. The target session is `agent.session`.
 * Its replacement user message must use {@link compactCheckpointSource} with
 * the transaction's `CompactionId`.
 * Use {@link toolPairingBalancedBefore} and {@link toolPairingBalancedAfter}
 * for the edge checks.
 *
 * @param start - first surface seq, inclusive.
 * @param end - last surface seq, inclusive.
 * @param agent - context whose session is mutated and whose routing options guide summarization.
 * @param signal - optional cancellation; model-backed implementations must forward it.
 * @throws when compaction is active or the range is missing, reversed, or unbalanced.
 * @returns the appended event seqs, summary, replaced range, and token accounting.
 */
abstract compactRegion( start: SessionSeq, end: SessionSeq, agent: CompactionAgentContext, signal?: AbortSignal, ): Promise<CompactionResult>
```

Types: [CommandId](commands.zh.md) · [SessionSeq](session.zh.md)

Source: [`packages/compaction/compaction/src/index.ts`](../../packages/compaction/compaction/src/index.ts)

<a id="ctxtoolresultpruner--toolresultpruner"></a>

### `ctx.toolResultPruner` — `ToolResultPruner`

Deterministic head/middle/tail pruning for current tool-result surface nodes.

```ts cordis-catalog
/**
 * Measure text content in Unicode code points; non-text blocks cost zero.
 * @param blocks - tool-result content to measure.
 * @returns total Unicode code points across text blocks.
 */
measureContent(blocks: readonly ContentBlock[]): number

/**
 * Replace an over-budget text middle while retaining rich-block order.
 * Text slicing is by Unicode code point, not UTF-16 code unit, so a retained
 * boundary cannot split a surrogate pair. Grapheme clusters may still split.
 * @param blocks - original tool-result content.
 * @returns pruned content, or `null` when the text is within budget.
 */
pruneContent(blocks: readonly ContentBlock[]): ContentBlock[] | null

/**
 * Prune every over-budget tool result from one stable current-surface snapshot.
 * Each replacement preserves the complete event data except for `content`,
 * cites the shadowed node so replay can recover the replacement input, and is
 * immediately preceded by a `compaction/prune` shadow-price event pricing the
 * shadowed node through the injected token meter, so pure consumers can
 * subtract it without per-node state.
 * @param session - session whose current surface is rewritten.
 * @returns landed replacements and aggregate Unicode-code-point savings.
 * @throws when the session rejects a replacement; replacements committed
 * earlier in the pass remain durable.
 */
pruneSession(session: Session): PruneResult
```

Types: [ContentBlock](llm-streaming.zh.md) · [Session](session.zh.md)

Source: [`packages/compaction/compaction-tool-result-pruner/src/index.ts`](../../packages/compaction/compaction-tool-result-pruner/src/index.ts)
<!-- END GENERATED cordis-surface -->
