# Agent Note: Compaction as a capability seam (abstract contract + basic backend)

Status: implemented

English | [中文](2026-06-18-compaction-capability-seam.zh.md)

## Problem

A long-running agent conversation grows without bound. As the event log accumulates turns, the derived message history eventually approaches the model's context window — the model then truncates mid-response (`max-tokens`) or degrades. **Compaction** is the mitigation: replace a run of older history with a concise summary, keeping recent context intact.

The [session surface](../architecture/2026-06-18-session-surface.md) was built as the foundation for exactly this — an ordered projection over the event log with a `surfaceOp: { op: 'replace', start, end }` operation purpose-built to shadow a range of entries and insert a replacement, with `sourceEventSeqs` listing every source event so replay can validate that the replacement cites every event it removes. What remained was the plugin that *decides what to compact and produces the summary*.

Two forces shape the design. First, compaction policy and reusable token measurement vary independently: measurement belongs to the LLM-family [`ctx.tokenMeter` service](../../archived/architecture/2026-07-15-replay-token-meter-service.md), while summarization can be a model call, a template, or a remote service. Second, `SurfaceEventType` is closed to the message-producing event types (`user/message`, `assistant/message`, `tool/result`); only those may carry `surfaceOp`. A bespoke `compaction/*` event therefore **cannot** itself appear on the surface — the compiler and Session's always-on append/seed boundary reject `surfaceOp` on it.

## Decision

### Compaction is a capability seam with separate Service Definition and Service Provider roles

Per the [capability-seams Agent Note](../architecture/2026-06-13-capability-seams.md), compaction ships as separate packages so the contract, the algorithm, and (later) the consumer API evolve independently:

1. **Interface** — `@deepseek-ai/dsh-compaction`: an abstract `CompactionEngine` owning the `ctx.compaction` key, the `CompactionResult` vocabulary, the `compaction/*` session events, the manual failure taxonomy, and the canonical checkpoint message source. It declares `compactIfNeeded()`, `compactNow()`, and `compactRegion()` as **abstract** — the contract states *what* compaction does, not *how*.
2. **Implementation** — `@deepseek-ai/dsh-compaction-basic`: a concrete `BasicCompactionEngine` that consumes `ctx.tokenMeter` and owns the tail→head retention walk, summarization via `ctx.llm.stream()`, the surface replacement, the lock, pre-step pressure, and canonical context-overflow recovery. `summarize()` is its sole subclass hook; pricing and replay stay with the meter.
3. **Model-free companion** — `@deepseek-ai/dsh-compaction-tool-result-pruner`: a concrete optional service that rewrites oversized current `tool/result` nodes before the backend selects a summary range. It is not a second compaction implementation and does not implement `CompactionEngine`.
4. **Human consumer** — `@deepseek-ai/dsh-command-compact` registers argument-free `/compact` through `ctx.commands` and calls the backend-independent `compactNow()` operation. It is direct human control, not a model-facing tool.

### The contract depends on `dsh-session` and `dsh-llm` — a deliberate deviation

The capability-seams Agent Note states the Service Definition package "depends only on cordis" (true of `dsh-shell`, whose vocabulary is self-contained). Compaction **cannot** honor that: its verbs act on an agent-owned `Session` (`compactRegion(start, end, agent)`) and its output uses the content vocabulary (`CompactionResult.summary: ContentBlock[]`). There is no way to express the contract without naming `Session`/`SessionEvent` (from `dsh-session`) and `ContentBlock` (from `dsh-llm`).

This is not a coupling smell — it is the contract's domain. The "only cordis" guidance was always shorthand for "the interface depends only on what the contract genuinely names, and never on an implementation." `dsh-session` and `dsh-llm` are themselves interface/vocabulary packages, not implementations; `dsh-compaction` still imports no backend. The seam's real invariant — *consumers and implementations evolve independently behind an abstract service* — holds intact.

### Three abstract operations, algorithm in the backend

Putting the full algorithm (the retention walk, token-summing, text extraction) as concrete methods on the interface recouples the contract to one strategy: a backend that wants a different retention policy or event sequence would have to fight inherited concrete code. Making all three operations abstract puts every *how* decision in the backend and keeps the interface a statement of *what*. Token measurement is not a compaction hook at all; the singleton service lets multiple consumers share one per-session replay fold.

`compactIfNeeded(agent, trigger, signal)` takes an explicit `'pressure' | 'context-overflow'` trigger and cancellation. It reads only the latest durable routed request; no header means no work, while any routed provider/model target uses the singleton estimator. `compactNow(agent, signal)` requires an idle agent and performs one useful balanced reduction even below pressure, returning `null` without writes when none exists. `compactRegion(start, end, agent, signal?)` uses `agent.session` as its single session identity and keeps an optional signal for explicit callers. The default summarizer resolves its target from explicit config, the latest logged routed target, then agent options, and records the provider/model pair after any `llm/stream` routing. It replays the routed request's prefix and appends the compaction directive as a trailing user message so the provider's warm KV cache is reused — see the [`dsh-compaction-basic` README](../../../../packages/compaction/compaction-basic/README.md). The result carries `llmStreamCall: true` because it consumed exactly one call through this context's LLM service; a subclass sets that marker only under the same condition, since retained `rawOutput` alone does not identify the call path. The call sets the provider-neutral `GenerateOptions.purpose` to `compaction`; adapters may map that purpose to model-hidden transport metadata, and the DeepSeek adapter sends `x-deepseek-harness-compact: 1`.

### Automatic pressure runs after successful durable step work

Successful-call pressure runs at the next `agent/pre-step`, after the preceding response, tool results, buffered context, and steering are durable and before the next request is derived. `dsh-compaction-basic` measures the canonical logged request through `ctx.tokenMeter`, so the next request sees any replacement without a speculative envelope override. Once pressure qualifies, optional `ctx.toolResultPruner` rewriting runs before summary selection; compaction-basic remeasures the durable surface and skips summarization if pruning restores safe pressure.

Canonical provider context overflow takes a separate path. The failed step closes and `agent/request-error` receives the original request error. Compact-basic owns its per-agent overflow count, prunes before forcing one useful balanced reduction, and returns `{ kind: 'retry' }` only if `session.surface.replaceGeneration` increases, including pruning-only progress when no summary range exists. The loop then closes the failed turn, opens a new numbered retry turn, and reconstructs its request from the durable log. No replacement, a recovery failure before any replacement, cancellation, an exhausted cap, or an unrelated error preserves the original provider failure. If pruning already advanced the generation before later summary work fails, recovery retries from that durable pruned surface unless cancellation or disposal wins. The complete lifecycle decision is in the [after-call recovery Agent Note](../architecture/2026-07-10-after-call-compaction-pressure-and-overflow-recovery.md).

```
assistant/message → tool/result/context/steering → step/end
claim the next batch → await waterfall agent/pre-step  ⟵ pressure compaction before the next request
enter → next step/start

provider overflow → step/end
await waterfall agent/request-error  ⟵ forced compaction between attempts
retry → next numbered step/start      ⟵ derives from the replacement surface
```

### Retention is turn-agnostic; tool-pairing balance is the only structural guard

Auto-compaction checks after **every successful** step, not once per turn. This is load-bearing for runaway-turn survival: a tool-heavy ReAct turn appends an `assistant/message` + a `tool/result` per step, so the surface grows within a turn. The next pre-step check can compact early closed tool pairs before continuation opens another step, and provider-confirmed overflow remains the backstop when a request crosses the limit first.

`compactIfNeeded` retains the smallest tail of whole surface units whose estimated size reaches the resolved retained-token budget and compacts older nodes. A unit is a complete closed step or one no-step message. If the token cutoff lands inside a step, retention expands until the cut is tool-pairing balanced. Balance is checked on surface order, not log sequence, because replacement summaries have new sequence numbers at old surface positions. `dsh-compaction` exports the before/after edge helpers; their per-session cache folds only appended surface-tail nodes while `replaceGeneration` is unchanged, does no event reads for log-only growth, and rebuilds current membership and balances after replacement. `compactRegion` rejects boundaries that split a tool call from its result. The in-flight turn receives no special retention.

A runaway turn thus compacts exactly like any other history: its early *closed* steps get summarized while its recent steps stay verbatim. When the only compactable content left is an un-splittable open tail step (its tool-calls have no results yet), compaction declines (`null`) and retries once that step closes.

**Some single-unit overflow remains out of scope.** Summary range selection cannot split an indivisible unit. The optional pruner can repair a closed tool pair when removable text-bearing tool-result content is the bulk and the pruned remainder fits. Envelope-only pressure, an oversized indivisible non-tool node such as a pasted `user/message`, and a tool unit whose non-prunable remainder is still oversized remain outside compaction; bounding those units is a separate concern.

### Head-anchoring: one auto checkpoint, always at the head

Auto-compaction always starts at the surface head, merging the prior checkpoint with newly compacted history so only one automatic checkpoint remains. `shadowedRange` is therefore positional rather than a numeric sequence interval: a newer summary sequence may occupy an older surface position. `shadowedSeqs` records the authoritative surface order. Manual mid-range compaction may leave multiple checkpoints.

### Approximate convergence invariant

`resolveConfig` supplies usable defaults: threshold ratio `0.8`, retained-tail ratio `0.16`, empty summarization provider/model overrides, `maxTokens: 8192`, `compactionRetries: 1`, `maxOverflowRetries: 1`, and `auto: true`. Optional exact provider/model policies partially override the top-level defaults; pressure scales ratios against capacity from the route-owning LLM adapter, while `retainTokens` can replace ratio retention. Retention must remain below the resulting threshold. Convergence remains dynamic because provider output caps can be spent on hidden or surfaced reasoning tokens and summary size is unpredictable. If pressure remains over threshold, `compactIfNeeded()` re-compacts the head checkpoint up to the configured retry count, but each committed summary must be smaller than what it shadows. Overflow needs no capacity metadata and bypasses threshold and retained-tail policy for one maximal balanced head reduction, leaving the newest indivisible unit. The ownership split is specified by the [routed model context and compaction policy Agent Note](../architecture/2026-07-20-routed-model-context-and-compaction-policy.md).

### Surface replacement: `compaction/*` events are log-only; one `user/message` carries the summary

Because `SurfaceEventType` is closed, the summary cannot ride on a `compaction/*` event. The backend instead appends a **single `user/message`** with `source: COMPACT_CHECKPOINT_SOURCE` and `surfaceOp: { op: 'replace', start, end }` whose `content` is the (framed) summary and whose `sourceEventSeqs` covers the shadowed entries *and* the bookkeeping events. The interface exports that source and `isCompactCheckpointSource()` so consumers recognize a persisted or cloned checkpoint without depending on backend package identity. The `compaction/*` events record the lock, summary, selected range, shadowed seqs, token count, and model call without joining the surface. The surface mutation sits **inside** the lock — `compaction/end` is the last event appended:

```
compaction/start    → log-only. Acquires the lock.
[summarize older range via the backend]
compaction/summary  → log-only. Records the raw summary, local-call marker, range, shadowed seqs, and token count.
user/message     → canonical checkpoint source + surfaceOp { op:'replace', start, end }.
                   THE surface mutation (framed summary).
                   deriveMessages() renders it as a user-role message.
compaction/end      → log-only. Releases the lock (carries `error` on a recoverable failure).
```

`deriveMessages()` then yields `[summary_as_user_message, ...retained_entries]`. Reusing `user/message` is honest rather than a workaround: a summary genuinely *is* user-role context.

### Checkpoint framing + incremental merge (backend-private)

The basic backend wraps the summary as established checkpoint context and tags it for incremental merging on the next cycle. The raw summary remains on `compaction/summary`. Framing is backend policy; the seam promises that one replacement user message carries the possibly framed summary and uses the canonical checkpoint source.

### Blocking via a log-recorded lock, plus a crash/recoverable failure taxonomy

The `compaction/start … compaction/end` bracket is justified by two roles:

1. **Crash-detectable orphan plus recorded summary inputs** (primary). Summarization is a slow model call persisted *after* `compaction/start`. A crash mid-summarization leaves a `compaction/start` with no matching `compaction/end` — a detectable orphan. Releasing the lock last (rather than first) converts the crash window from *silent corruption* into that detectable orphan.
2. **Prevents concurrent compaction.** Every automatic, manual, and explicit-range entry point refuses a live unmatched `compaction/start`. The bracket is the single lock; no process-local mutex duplicates it.

The lock excludes another compaction, not unrelated facts. Its markers are time points rather than an exclusive container, so durable inbox splices may appear between a standalone manual start and end. Automatic work requires whole-surface stability inside its turn. Manual work revalidates only the selected positional span, letting append-only context outside it remain visible after replacement.

The lifecycle boundary makes crash state unambiguous:

- **Current lifecycle:** a dangling `compaction/start` after the newest `session/end-seed` is the live durable lock and reports busy.
- **Later lifecycle:** a newer constructor-written `session/end-seed` proves that the older unmatched start is stale, so resume, fork, and adoption do not remain wedged by a dead writer.
- **Recoverable failure:** once start lands, the backend makes exactly one `compaction/end { error }` attempt. Summary or stability failure leaves the conversation surface unchanged while preserving the failed attempt in the log. If the close append fails, the unmatched start remains intentionally blocking.

`compaction/end` keeps its `error?` field (mirroring `tool/result`'s self-contained error — one event tells success from failure without correlating a sibling). There is no separate `compaction/error` event.

**Core session repair stays compaction-agnostic — deliberately.** `interruptedTurnClosers` is never taught about `compaction/*`. The general `session/end-seed` lifecycle boundary supplies the evidence the compaction owner needs; the compaction invariant and backend interpret it without adding plugin-specific repair to core.

## Alternatives considered

- **The full algorithm as concrete interface methods** — rejected because it recouples the contract to one retention strategy. All three operations are abstract; reusable measurement is a separate LLM-family service and `summarize()` is basic's sole hook.
- **Compaction on `agent/request` or a compaction-specific loop callback** — rejected because the former observes a provisional request and the latter couples generic lifecycle to compaction policy. Pre-step replay of the prior durable request plus canonical overflow recovery covers successful and rejected calls.
- **A `compact` boolean or untyped request metadata map** — rejected because multiple auxiliary call kinds would become mutually exclusive flags, while an open bag would discard compiler-checked vocabulary. One typed `purpose` discriminant extends with additional call kinds without adding another `GenerateOptions` field.
- **A separate `compaction/error` event** — rejected: `compaction/end` keeps an `error?` field, mirroring `tool/result`'s self-contained error — one event tells success from failure without correlating a sibling.
- **Teaching core turn-repair about `compaction/*`** — rejected: the general end-seed boundary already distinguishes prior-lifecycle history, and patching core for every future `xxx/start … xxx/end` pair is exactly the coupling the capability-seam architecture exists to avoid.

## Consequences

- **Packages**: `packages/compaction/compaction` supplies the interface, `compaction-basic` supplies the backend, `compaction-tool-result-pruner` supplies optional deterministic rewriting, and `command-compact` supplies human `/compact`. `packages/llm/token-meter` owns replay-aware measurement independently.
- **Automatic extension points**: `agent/pre-step` (`@mode waterfall`) handles pressure before request derivation and `agent/request-error` (`@mode waterfall`) handles final request failures after the failed step closes. The pre-step payload carries the claimed batch, turn, step, and signal (see the [payload-object events decision](../../archived/architecture/2026-08-06-agent-event-payload-objects.md)), with no compaction-only prompt/prefix payload.
- **`SessionEventMap`** gains `compaction/start` / `compaction/summary` / `compaction/end` by declaration merging (merge-extensible); `SurfaceEventType` is **not** touched. These are session events, not cordis `Events`, so the event-taxonomy gate needs no entry.
- **`dsh-compaction`** owns `COMPACT_CHECKPOINT_SOURCE`, `isCompactCheckpointSource(source)`, `toolPairingBalancedBefore(session, seq)`, and `toolPairingBalancedAfter(session, seq)`. The marker identifies replacement summaries across backend implementations. The cached surface-edge checks prevent `compactRegion` and `compactIfNeeded` from splitting a tool-call/result pair, validate current membership by seq, answer both edges from one per-cut balance sequence, and reject stale or missing seqs and orphan results.
- **`dsh-session`** validates positional replacement, complete cited source-event coverage, and content-only single-node `tool/result` rewrites through its one surface manager. Its invariant companion treats fresh appended tool results as executions that require an open step and pending call, while the compaction companion owns numeric-turn versus standalone-null bracket relations.
- **Wiring**: `examples/tui-agent/cordis.yml` loads zero-config `dsh-token-meter`, `dsh-compaction-tool-result-pruner`, `dsh-compaction-basic`, then `dsh-command-compact`; service-wide defaults make the composition usable without repeated numeric policy.

## Testing

- **Unit:** Real Loader and invariant plugins cover whole-unit retention, pruning configuration and replay, rich-block ordering, metadata preservation, convergence, both `compaction/end` outcomes, open-tail refusal, pruning-only and summarized overflow recovery, generation proof, caps, and original-error preservation.
- **Loop:** Tests pin pre-step after the preceding `step/end` and before the next `step/start`, actual `agent/request` routing, closed failed steps, fresh retry numbering, and complete thrown/in-band overflow → compaction → reconstructed retry composition.
- **Manual:** Maintenance serialization, marker ordering, injection retention, live/stale orphan classification, cancellation, close/flush failures, command mapping, and the queued TUI journey are pinned without a model key.
- **With-key e2e:** A real model and bash session with lowered limits triggers compaction, records a complete `compaction/start…end` pair, shrinks the surface, and finishes the task.
- **Snapshot:** The assembled context-overflow scenario derives the auxiliary call from `compaction/summary` only when `llmStreamCall: true` proves that the local LLM service consumed it; canonical reconstructed blocks pin the complete recovery without provider delta partitioning.
