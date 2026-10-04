# Agent Note: After-call compaction pressure and context-overflow recovery

Status: implemented
Archived: 2026-09-30

English | [中文](2026-07-10-after-call-compaction-pressure-and-overflow-recovery.zh.md)

## Problem

`agent/pre-step` runs before final request routing and before assistant output, tool results, buffered context, and steering exist. Even with the assembled prompt and session prefix, its pressure view is provisional because `agent/request` can still change routing or call configuration and tool schemas are not frozen with those inputs. Adding fields cannot make pre-call state describe a completed call and couples the generic extension point to compaction.

Successful calls are not the only pressure signal. A provider can reject a request for exceeding its context window before it returns usage, and some successful calls omit usage. The system therefore needs replayable post-call pressure plus a narrow failure-recovery path that preserves the provider error whenever compaction cannot prove useful progress.

## Decision

### Successful pressure runs at the next pre-step boundary

`agent/pre-step` receives the exclusive claimed message batch plus `{ turn, step, signal }` and returns the final reject/enter decision. It carries no compaction-only prompt or prefix fields.

Compact-basic wraps `agent/pre-step` before each proposed request. At a continuation boundary the preceding assistant output, every dispatched or synthetic tool result, post-tool context, and steering are already durable, so pressure policy sees the complete successful-call state without splitting an assistant tool call from its result. At the initial boundary a headerless session has no completed routed request and produces no pressure work. Compact-basic contains operational failures, warns, and delegates without rejecting the proposed step.

`dsh-compaction-basic` reads the exact latest routed model from the durable request header only to establish that a completed route exists, then asks the singleton `ctx.tokenMeter` to measure the canonical logged envelope and current surface. It does not fall back to `AgentOptions.model` for automatic pressure. A headerless session has no completed routed request to assess and produces no work; any durable non-empty model name uses the same estimator. Operational measurement or summarization failures warn and continue from the latest durable surface: full history before any replacement, or the pruned surface if pruning already landed.

### Request recovery is limited to the final model boundary

`agent/request-error` represents terminal failures from the final adapter boundary. Adapter selection, dispatch, iterator construction, and iteration throws become terminal `error` or `aborted` finishes before the agent loop consumes them; adapter-emitted terminal finishes enter the same path. Prompt assembly, request middleware, request logging, result processing, tools, step listeners, and cleanup remain ordinary failures. [Terminal LLM stream failures](2026-07-29-terminal-llm-stream-failures.md) owns this normalization boundary.

The failed step closes before recovery runs. A handling listener repairs durable state, returns `{ kind: 'retry' }`, and stops waterfall delegation. The loop then closes the failed turn and opens one retry turn from the durable log without an intervening idle notification. Retry policy and attempt counts remain plugin-owned; compaction-basic clears its per-agent overflow count when the chain reaches terminal `agent/settled`. Both DeepSeek adapters normalize recognized provider context-limit failures to `CONTEXT_WINDOW_EXCEEDED`. The [retry-action decision](../simplification/2026-07-27-request-error-retry-action.md) owns the return boundary.

If cancellation lands after assistant tool calls are durable but before all calls dispatch, the loop records a synthetic `tool/call` and aborted `tool/result` pair for every undispatched call before following the normal abort path. The surface therefore never retains orphaned durable tool calls merely because cancellation won the race.

### CompactionEngine exposes intent, not token accounting

`CompactionEngine.compactIfNeeded(agent, trigger, signal)` accepts `trigger: 'pressure' | 'context-overflow'`. The interface gains no estimation methods or token types; `ctx.tokenMeter` remains the reusable accounting owner.

For `pressure`, compaction-basic resolves the durable provider/model target's adapter-owned capacity and exact-target policy, then applies the resulting threshold and retained-tail budgets to one unified `ctx.tokenMeter.measure()` result. Below pressure it returns without pruning. Once pressure qualifies, optional `ctx.toolResultPruner` rewrites oversized current results and compaction-basic remeasures through the same meter; safe pressure skips the model call, while remaining pressure selects and summarizes from the pruned surface. The same singleton meter owns range pricing, cited source-event accounting, shadowed token counts, and non-shrinking-summary rejection. Common defaults remain threshold ratio `0.8`, retained-history ratio `0.16`, summarization provider/model `''`, `maxTokens: 8192`, `compactionRetries: 1`, and `auto: true`; optional `modelPolicies` entries override them for an exact provider/model pair.

For canonical overflow, compaction-basic requires no capacity metadata and bypasses scalar pressure and the normal retained-token budget. It prunes first, then chooses the maximal tool-balanced head range while leaving the newest indivisible unit and attempts one shrinking summary compaction under the same signal when a range exists. The automatic listener snapshots `session.surface.replaceGeneration` and returns `{ kind: 'retry' }` whenever pruning or summarization increases it. This remains true when pruning lands before later summary work throws; cancellation still wins. A backend returning a result without replacement cannot authorize retry, while pruning-only progress can authorize a retry without a `CompactionResult`.

`maxOverflowRetries` is optional and defaults to `1`; `0` disables overflow recovery without disabling pressure. `auto: false` registers neither automatic listener. Noncanonical errors, exhausted attempts, an already-aborted signal, a missing routed model, no safe range, no generation change, and recovery throws before any replacement all delegate to the next listener. With no later recovery, the loop reports the original provider error object and code. A recovery throw after generation advances authorizes retry from durable progress; cancellation or disposal remains authoritative even if recovery work completes concurrently.

The default summarizer resolves explicit configuration, then the latest logged route, then agent options. Because direct `llm/stream` middleware may reroute that auxiliary call, `compaction/summary.{provider, model}` records the final mutable `GenerateOptions` target observed after dispatch rather than the pre-waterfall candidate.

## Testing

Unit tests cover the final-adapter normalization boundary, closed-turn retry numbering and reset, cancellation and disposal, step-boundary ordering, routed-envelope pressure, pressure-gated pruning, pruning-only relief, pruned-input summarization, balanced overflow reduction, durable prune progress before later failure, generation proof, caps, delegation, and auxiliary-call routing. Real-loop tests cover thrown and in-band overflow through pruning or summary compaction to a reconstructed retry request.

## Alternatives considered

- **Add compaction-only fields to pre-step** — rejected because the canonical durable session and token meter already own the measurement input; the generic lifecycle need not carry a second envelope.
- **Retry the same numbered step** — rejected because recovery appends durable events after the failed boundary. A new step preserves balanced nesting and reconstructability.
- **Retry whenever `compactIfNeeded` returns a result** — rejected because a custom backend can report success without changing model-visible state. `replaceGeneration` is the authoritative proof.
- **Let compaction-basic parse provider wording** — rejected because classification belongs at adapters and must cover both thrown and in-band delivery.
- **Fall back to `AgentOptions.model` when no durable route exists** — rejected because automatic policy must describe a completed logged request. Headerless pressure and recovery delegate unchanged.

## Consequences

The next pre-step pressure check describes the preceding completed routed request, including durable tool results and newly claimed input. Optional model-free pruning removes predictable tool-output bulk before summary selection and can independently create retry-worthy progress. Canonical overflow supplies the backstop when no successful usage anchor exists. Recovery is bounded, cancellation-owned, and monotonic: it retries only after a visible surface generation change.

The cost is pressure work in the shared pre-step waterfall and adapter-maintained overflow classification. Provider wording and heuristic character density remain maintenance risks. Surface compaction still cannot repair an envelope that alone exceeds the window, split an indivisible non-tool node, or repair a tool unit whose non-prunable remainder remains oversized. The optional pruner can repair an otherwise indivisible tool pair when removable text-bearing tool-result content is the bulk.

The [claimed pre-step lifecycle](2026-07-31-claimed-pre-step-inbox-lifecycle.md) supersedes this note's former post-step trigger. The service split, standalone token meter, balanced range contract, log-recorded lock, summary replacement, and sole `summarize()` subclass hook remain unchanged.
