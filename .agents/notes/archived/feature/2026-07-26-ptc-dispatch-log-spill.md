# Agent Note: Spilling the durable copy of PTC mode sub-dispatch results

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-26-ptc-dispatch-log-spill.zh.md)

> Scope: limiting the `tool/code-dispatch` event's content with the existing spill implementation. The [host foundation note](2026-07-26-ptc-dispatch-ui-foundation.md) deliberately accepted the unlimited log and deferred spill support to this change; the [live-parallel note](2026-07-26-ptc-live-parallel-dispatch.md) defines the event pair that this listener processes.

## Problem

After full-content dispatch logging was added, a `run_code` program that reads a large file wrote the complete rendered text into the session log without a limit or spill policy, while native results were limited to `maxInlineBytes` before logging. This treated the most likely large results differently: sub-calls are intended for bulk data work, and each affected turn added megabytes to the JSONL.

## Decision

**A `tools/ptc-dispatch-log` waterfall on the registry, with spill policy as its first listener.**

- **Extension point**: `tools/ptc-dispatch-log` is a scope-filtered waterfall that the bridge runs over each settled sub-dispatch before appending `tool/code-dispatch`. The bridge receives the registry's private `shapeDispatchLog` invoker as a capability closure in `RunCodeBridgeOptions`; the waterfall is the public contract, and the invoker does not add a service method. If a listener throws, the invoker reports any thrown value safely and uses the original settled content. The `PtcDispatchLog` payload carries the outer execution, the `agent` routing key, the sub-call identity, and the default content: the rendered result projection that a native `tool/result` would carry, while the program receives the structured `value`. A listener can replace only the durable copy, which the model never sees. The listener runs as tracked work outside the program's result path. When more than `maxParallelSubCalls` log tasks are pending, the ordered commit loop waits, so a slow spill backend limits later sub-call starts instead of accumulating unlimited pending I/O. Run settlement still waits for every task inside the open turn.
- **Policy**: `dsh-spill-policy` registers a listener for this event and uses the same replacement code as its model-result listener: the same `maxInlineBytes` limit, preview and locator, within-limit invariant, and best-effort fallback. The spill artifact is labeled `dispatch` under the sub-call id. UIs and replay read its full text through the same path used for spilled native results, so both result kinds render with the same information.
- **One deliberate difference**: the model-result listener skips `read` to prevent a `read → spill → read again` loop. The dispatch-log listener also replaces oversized `read` sub-call content because a log copy is not model context, so that loop cannot occur, and `read` is the tool most likely to produce a large log entry.

## Alternatives considered

**Apply a plain byte limit inside the bridge without spill storage.** Rejected: truncation without a locator loses data that replay or UIs may need and restores the less informative "truncated summary" rendering that earlier changes removed.

**Spill inside the bridge directly by calling `ctx.spillStore` from `ptc.ts`.** Rejected: the registry would require the spill capability. The waterfall keeps this policy with the other spill decisions and allows compositions to omit it; omitting `maxInlineBytes` still makes the listener a no-op.

**Reuse `tools/post-execute` for nested calls instead of a new event.** Rejected: post-execute can change the program-facing result, so nested calls deliberately skip it and programs receive complete data. The durable copy needs a separate listener that runs after the program has its value.

## Consequences

PTC mode dispatch entries in the session log now have the configured byte limit, and the README's Known Limitations entry about unlimited dispatch logging now points here. Old logs with oversized dispatch content still replay because the event fields are unchanged; only future appends contain less text. The web UI renders spilled sub-call output as preview and locator text through the same path as native results, with no special case.
