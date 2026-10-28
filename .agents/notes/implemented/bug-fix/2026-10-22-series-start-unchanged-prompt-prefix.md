# Agent Note: A series start with an unchanged prompt keeps the surviving system node

Status: implemented

English | [中文](2026-10-22-series-start-unchanged-prompt-prefix.zh.md)

## Problem

On an in-history route, a prompt change is appended as a later `system/message`, so node 0 stays stale while the latest surviving node carries the rendering. A surface replacement (compaction, tool-result prune, image offload) starts a new request series. Re-baselining node 0 at a series start while the rendering already matched that latest node emptied the later node and wrote the identical text into node 0. The wire request then differed at its first message, so the provider prefix cache missed from the first token although no prompt text changed.

Real session `session-da55bbc9-…`, turn 710 step 2: `compaction/prune` replaced one tool result (seq 34669, 34670); the next request wrote 7,618 characters identical to the node it emptied (seq 34672, 34673), `request/header` logged reason `series` (seq 34674), and the step billed 722,332 uncached input tokens with 1,152 cache-read tokens (0.16% hit) against about 99.9% on the neighboring steps. A build update at turn 707 had appended the prompt node; nothing changed the rendering at turn 710.

## Decision

`SystemPromptProjection.project` re-baselines node 0 only when the effective text must move: an incapable route, an empty rendering, or a series start whose latest surviving non-empty node text differs from the rendering. When the route is in-history, the rendering is non-empty, and the latest surviving node already holds it, the projection returns no updates and the node stays where the cached history carried it. The loop still records the request series through `request/header` (`series`, or `change` with `startsSeries: true`) and rebuilds declarations as before; when the unchanged-rendering skip coincides with a tool-schema series start, the header records the declaration change without `startsSeries`.

Retry recovery keeps its guarantee: when a retry compaction shadows the latest node, the effective text falls back to an older node, differs from the rendering, and the head is rewritten before users are admitted again. The projection never appends an update after already-admitted users.

## Verification

- [`system-prompt-projection.spec.ts`](../../../../packages/core/agent-loop/tests/system-prompt-projection.spec.ts) pins the no-operation decision for a capable series start whose surviving node already matches.
- [`system-prompt-admission.spec.ts`](../../../../packages/core/agent-loop/tests/system-prompt-admission.spec.ts) pins the wire request: a compaction replacement with an unchanged rendering keeps both system messages, the previous request messages remain a prefix, and the neighboring steps regain the provider prefix.
- The [`in-history-series-start`](../../../../snapshots/session/in-history-series-start/) recorded session replays the shipped headless profile through a prompt change and a later surface replacement, pinning the unchanged-rendering series start to two retained prompt versions and no `system/message` event.

## Alternatives considered

**Always keep the appended node and never re-baseline.** Simpler, but a route that cannot append prompts, or a prompt that must clear, still needs a single current head, and a changed rendering at a series start must not append after users already admitted by a failed attempt. Rejected.

**Skip consolidation whenever the head differs.** A stale head is authoritative again on an incapable destination route, because that route ignores later system nodes; the route capability, not the head text, decides whether the later node is effective. Rejected.

**Stop treating local surface replacements as series starts.** A prune changes one tool result, so the cache loss is local, but image-offload and compaction decisions still legitimately start a series; the projection must not depend on which replacement produced the boundary. Rejected: the projection owns the prompt decision.

**Compare reconstructed requests instead of surface text.** The loop derives requests from surface events, so comparing past wire messages would duplicate request reconstruction and still need the same effective-text comparison. Rejected.

## Consequences

- A capable route can retain earlier prompt versions in model history after a series start; they cost input tokens until a later consolidation or compaction shadows them.
- A tool-schema series start on a route without tool updates no longer writes a `system/message` event, so its header records the declaration change without `startsSeries`. The request still carries the complete active declaration set through the unsupported-route projection (`projectToolUpdates`), while `Session.toolHistory()` keeps its incremental baseline instead of resetting.
- Consolidation still applies when the rendering actually differs: route switches, prompt updates concurrent with compaction, and retries that shadow the latest node.
