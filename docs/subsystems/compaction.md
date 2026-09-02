# Compaction

English | [中文](compaction.zh.md)

The compaction seam — a [capability seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md) split like bash: Service Definition ([dsh-compaction](../../packages/compaction/compaction), `ctx.compaction`), Service Provider (a backend such as [dsh-compaction-basic](../../packages/compaction/compaction-basic)), and human Consumer ([dsh-command-compact](../../packages/compaction/command-compact)). Compaction is **one optional capability**, not part of the agent-loop spine — so its vocabulary lives here, not in [core.md](core.md). A tokenizer- or template-based backend is a sibling package implementing the same interface. Unlike bash, the interface necessarily depends on `dsh-session` and `dsh-llm`: its verbs act on an agent-owned `Session`, and its durable summary event uses the `ContentBlock` vocabulary (see the [compaction capability-seam Agent Note](../../.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.md)).

Source: [`packages/compaction/compaction/src/types.ts`](../../packages/compaction/compaction/src/types.ts)

## The `compaction/*` session events

Compaction extends [`SessionEventMap`](session.md) with three event types via declaration merging. All three are **log-only** — they record the lock, summary, selected range, shadowed event seqs, token count, and model call without joining the surface. `SurfaceEventType` is deliberately NOT extended (only message-producing events reach the model), so the summary itself rides on a separate `user/message` with `surfaceOp: { op: 'replace', start, end }` — the only surface mutation performed by summary compaction. The [Agent Note](../../.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.md) owns the rationale for reusing `user/message`.

| Event | Payload | Role |
|---|---|---|
| `compaction/start` | `{ turn }` | acquires the log-recorded lock; a number identifies the open automatic turn, while `null` identifies a standalone manual attempt |
| `compaction/summary` | `{ summary, rawOutput?, llmStreamCall?, shadowedRange, shadowedSeqs, shadowedTokenCount, provider, model, maxTokens?, usage? }` | the safe summary projection, optional complete provider output and usage, an `llmStreamCall: true` marker when producing the result consumed exactly one call through this context's `ctx.llm.stream()` (which requires complete `rawOutput`), the shadowed surface-boundary pair (`start`/`end` seqs — a position span, not a numeric interval), the shadowed seqs in surface order, the estimated token count, and the summarize call's envelope (`provider`, `model`, plus its generation cap when one applied) — logged so the one-shot request is reconstructable from log + code (the reconstructability Agent Note); unmarked `rawOutput` does not identify the call path |
| `compaction/end` | `{ turn, error? }` | releases the lock with the same numeric-or-null owner (`error` records an unsuccessful attempt) |

The lock brackets the **whole** operation: `compaction/start` is appended first, then summarization, the `compaction/summary` record, and the `user/message` replacement all land, and only then `compaction/end`. Releasing the lock last turns a crash mid-operation into a detectable orphaned lock (a `compaction/start` with no matching `compaction/end`) rather than a `compaction/end` that falsely claims compaction finished.

The markers are lock time points, not an exclusive container. An unrelated idle injection can appear between a standalone manual start and end while summarization is pending. The manual path revalidates only its selected positional span, so that injected context survives after the replacement checkpoint. A live unmatched start blocks every entry point; an unmatched start before a newer `session/end-seed` is stale evidence from a prior lifecycle and is ignored.

These variants are merged inside a `declare module '@deepseek-ai/dsh-session/types'` block, so — unlike the top-level types on the other subsystem pages — they are not pasted as a drift-checked ` ```ts type-equiv ` block (the `verify-type-equiv` extractor matches only top-level declarations by name). The payload table above is the catalog entry; follow the source link for the authoritative fields.

## `CompactionResult`

What a successful compaction returns to its caller: the bookkeeping-event seqs, safe summary projection, shadowed range and seqs, and estimated token count.

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

## The service

Automatic callers state why policy is running; implementations may treat confirmed overflow more aggressively than ordinary pressure.

```ts type-equiv
/** Why automatic policy is asking a backend to consider compaction. */
type CompactionTrigger = 'pressure' | 'context-overflow'
```

`CompactionEngine` exposes `compactIfNeeded(agent, trigger, signal)` for automatic `pressure` or `context-overflow` policy, `compactNow(agent, signal)` for one useful idle-session reduction even below pressure, and `compactRegion(...)` for an explicit inclusive surface range. `compactNow()` runs as agent maintenance between turns, returns `null` without writing when no useful range exists, records a standalone `turn: null` bracket before summarization, and flushes a closed attempt before later queued prompts may derive from the new surface. Every backend creates its replacement `user/message` source with `compactCheckpointSource(compactionId, sourceCommandId?)`; client and wire consumers import that constructor, `CompactionCheckpointSource`, and `isCompactCheckpointSource()` from the cordis-free `@deepseek-ai/dsh-compaction/checkpoint` subpath, while the package root re-exports them for host consumers. The required transaction identity correlates the replacement checkpoint, while the predicate keeps recognition independent of any one backend. Implementations must forward the supplied signal to summarization. The seam owns no pricing API: the singleton [`ctx.tokenMeter`](token-meter.md) directly owns estimation and replay, while `dsh-compaction-basic` owns retention, event sequencing, routed summarization calls, and their configuration.

Expected manual failures use `ManualCompactionErrorCode`:

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

`changed` and `summary` leave the conversation surface unchanged but still close and persist the failed attempt in the log. `commit` may follow partial mutation; `persistence` means the in-memory bracket closed but its flush failed. Cancellation remains separate and throws the exact abort reason after required cleanup.

Pressure compaction runs at the `agent/pre-step` waterfall before request derivation. Once pressure or canonical overflow qualifies, compaction-basic invokes optional [`ctx.toolResultPruner`](../../packages/compaction/compaction-tool-result-pruner/README.md) before range selection, remeasures through `ctx.tokenMeter`, and can advance the surface without a summary. Failed-request recovery runs through `agent/request-error` after the failed step closes and returns a retry action only when the surface replacement generation advances, even if later summary work throws after pruning; cancellation still wins. Region boundaries preserve tool-call/result pairing but not whole turns, allowing early closed steps of one oversized turn to compact. `dsh-compaction-basic` owns thresholds, retained-tail policy, overflow caps, and failure handling.

The Service Definition exports `toolPairingBalancedBefore(session, seq)` and `toolPairingBalancedAfter(session, seq)` for the tool-call/result pairing checks before and after a seq. Both validate current surface membership and reject missing seqs and orphan results; the [package contract](../../packages/compaction/compaction/README.md#tool-pairing-boundaries) defines their cache behavior.

## Tool-result pruning outcomes

The optional tool-result pruning service reports each durable content replacement and the aggregate Unicode-code-point reduction. Its public result types live in [`compaction-tool-result-pruner/src/types.ts`](../../packages/compaction/compaction-tool-result-pruner/src/types.ts).

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

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [CommandId](commands.md) · [SessionSeq](session.md)

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

Types: [ContentBlock](llm-streaming.md) · [Session](session.md)

Source: [`packages/compaction/compaction-tool-result-pruner/src/index.ts`](../../packages/compaction/compaction-tool-result-pruner/src/index.ts)
<!-- END GENERATED cordis-surface -->
