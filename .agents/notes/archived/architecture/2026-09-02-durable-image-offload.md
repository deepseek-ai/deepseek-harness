# Agent Note: Durable image offload by surface replacement

Status: implemented
Archived: 2026-09-10

English | [中文](2026-09-02-durable-image-offload.zh.md)

## Problem

Request-size image offload was recomputed from scratch on every request. Each route collected every image occurrence on the derived surface, oldest first, and once the accumulated bytes exceeded its budget it rounded the excess up to a whole removal quantum and replaced that many oldest occurrences with placeholder text, per the [unified image request pipeline](../feature/2026-08-20-unified-image-request-pipeline.md). Nothing remembered where the previous request stopped; the prefix was stable only because the arithmetic over an append-only history repeated itself.

That stability failed wherever the arithmetic inputs moved. The [Files inline fallback](../../archived/bug-fix/2026-08-21-deepseek-files-inline-fallback.md) rebuilt a request under a 20 MiB inline budget with a 10 MiB quantum, offloading far more images for that one request, and the next request in file mode brought them back. The pi-ai route used a quantum of one byte, so its prefix moved on almost every request. Compaction lowered the total and returned previously offloaded images. A route switch moved every step boundary. Each move changed the model-visible prefix and invalidated the provider cache prefix.

The same recomputation broke the repository invariant that model-visible input is reconstructable from the session log. Which representation was dispatched, the exact derived request-version byte lengths, and the route budgets and quanta were runtime or configuration facts that never entered the log; `request/header` records call config, system prompt, and tools only. Provider usage anchors token totals and cannot recover the image set, and the [route-priced estimate](../../archived/feature/2026-08-24-route-priced-image-request-pressure.md) documented that it did not reproduce the fallback budget. No consumer could pair a logged assistant response with the image set its request carried.

## Decision

The offload of an image occurrence is a durable surface fact recorded the way compaction records its reductions: a `surfaceOp: replace` node.

**Marked copies on the surface.** `ImageBlock` gains `offloaded?: true`. An offloaded occurrence lives in a replacement event of the same type as the node that carried it (`user/message` or `tool/result`) whose content is a copy of the original with those blocks marked; `sourceEventSeqs` points at the replaced node. The session core, its event map, its derivation, and its validation are unchanged. `deriveMessages()` sends the marked block; serialization renders every marked block as `offloadedImageText` with the currently resolved access path and prepares only retained occurrences.

**Only advances.** A replacement never reverts. When a budget grows, a route changes, or compaction lowers the total, the marked copies stay, so the model-visible prefix and the provider cache prefix move only forward.

**Adapters project, never decide.** An image-capable route enforces an `LlmImageRequestBudget` (`representation`, `maxBytes`, `maxImages`, both quanta) over the retained occurrences' exact request-version bytes. When they still exceed the budget, in file mode, under the inline fallback's tighter budget, or under the pi-ai bound, the adapter fails the attempt with `IMAGE_OFFLOAD_REQUIRED` and `LlmFailure.offloadImages` naming how many more oldest occurrences must be offloaded, computed with the shared `requiredImageOffload()`. Nothing plans an offload before dispatch.

**Recovery owned by `dsh-compaction-image-offload`.** Image offload is compaction in another capacity dimension: the provider rejects a request, durable history is reduced, the step retries. The executor is a sibling of `compaction-tool-result-pruner` in the compaction group and listens on the `agent/request-error` waterfall. On `IMAGE_OFFLOAD_REQUIRED` it walks the surface in model request order, marks the first `offloadImages` retained occurrences, and for each node that carried one appends the seam's `compaction/prune` shadow price followed by the marked copy, then returns the `retry` action without spending the provider retry budget or logging `llm/retry`. Assistant nodes carry model output, not input images, and are skipped. When nothing remains to offload it delegates and the failure reaches ordinary recovery. The loop re-runs the step over the replaced surface and logs the fresh `request/header` every surface replacement gets; the agent loop is unchanged.

**Token accounting.** `priceImages` receives the surface's `ImageBlock`s and prices a marked one as its placeholder text; the DeepSeek and replay pricing no longer reproduce any offload arithmetic. The meter needs no new state: the `compaction/prune` event and the replacement reprice the node like a tool-result prune.

**Other consumers.** Compaction reconstructs each selected event through `deriveEventMessage()` and sees the marks. Resume, fork, and replay reproduce the surface from the log. Text-only routes keep their separate whole-history substitution.

## Alternatives considered

**Keep recomputing the offload point per request.** Stable only while the arithmetic inputs held still; the inline fallback, the pi-ai quantum, compaction, and route switches all moved the prefix, and no consumer could reconstruct a historical request's image set.

**Record each request's projection outcome as a log-only event.** Restores reconstructability but not stability: the recorded outcome is not a decision input, so every oscillation still happens and the log merely documents it, with two sources of truth for the offloaded set that can disagree.

**Log the full projected request body.** Everything except the offload decision is already derivable; repeating the history per request grows the log quadratically to record one position.

**A log-only `image/offload` watermark event applied by session derivation.** An earlier revision recorded the offload point as a position (event seq plus block path) and had `Session.deriveMessages()` mark every occurrence at or before it. That gave the session a second mechanism for changing model-visible history next to `surfaceOp: replace`, with its own validation, fold, cache invalidation, and required-on-read event, and placed the logic in the core instead of on the plugin that decides. Issue #3041 asks that a permanent eviction use a surface-changing event rather than a request-projection event; because the offload never reverts, it is one.

**Let each adapter append the replacement.** The adapter owns the budgets but not the session surface; a surface change appended below the loop lets two adapters define the surface differently. Adapters report the count they need instead.

**Plan the offload before dispatch, in the loop or in a plugin.** The loop knows the exact prepared route before deriving each request, so planning there never spends a failed attempt; but it puts a route-specific policy into the one component every profile shares, changes the documented step order, and bypasses the `agent/request-error` waterfall that context-overflow compaction and retry already use for the same repair-and-retry pattern. A pre-step plugin keeps the loop unchanged but cannot see the step's own messages or the first request's route, so the failure path stays necessary, and the plan needs every route to declare its budget on its model info. Handling only the failure costs one attempt per quantum crossing (64 MiB in DeepSeek file mode, 20 MiB on pi-ai) and matches the planned direction: routes will stop checking sizes locally, send every image, and the provider will report what it cannot cache, which is exactly a failure naming an offload point.

**Keep a transient extra offload for the inline fallback and exact-byte overflow.** Would have sent an unlogged projection in exactly the cases the invariant exists for; the failure-and-advance path costs one serialization attempt and keeps every dispatched request derivable from the log.

## Consequences

Offloaded images never return automatically when budgets grow, a larger route is selected, or compaction lowers the total; recovery is the read-only path in the placeholder, which the model uses deliberately. A Files outage or a temporary switch to a small-budget route offloads permanently; both are accepted for the same reason. Each offload copies the carrying node's message into the log; images are references, so the copy is the node's text plus block metadata.

Every dispatched request's image set is determined by the log alone, across file mode, inline fallback, resume, fork, retry, and compaction, and the provider cache prefix no longer oscillates. The execution-world access path embedded in placeholder and handle text is still resolved at serialization time; that gap exists for retained images too and belongs to a separate decision about recording the execution-world mapping. The route-local byte checks are provisional: once the provider reports uncacheable images itself, `requiredImageOffload()` and the route budgets go away while the marked copies and the recovery branch stay as they are.

## Testing

`packages/llm/llm/tests/content.spec.ts` pins arbitrary-depth image traversal, the offload count including the 129-to-64 MiB quantum example, and placeholder projection. `packages/compaction/compaction-image-offload/tests/image-offload.spec.ts` pins the `IMAGE_OFFLOAD_REQUIRED` replace-and-retry path with its `compaction/prune` shadow prices and without a retry event, the untouched original node, request-order counts after an earlier surface replacement, and the exhausted case that delegates downstream. Adapter specs pin placeholder projection, prepared-only-retained reads, and the exact-byte failure with its count; `route-pricing.spec.ts` pins placeholder pricing for a marked replacement. The `inline-image-prompt` TypeScript SDK snapshot replays an authored `IMAGE_OFFLOAD_REQUIRED` attempt through the shipped profile and pins the replacement and the retried request.
