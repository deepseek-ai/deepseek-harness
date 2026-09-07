# Agent Note: Route-priced image request pressure

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-24-route-priced-image-request-pressure.zh.md)

## Problem

The token meter priced an `ImageBlock` as the structural JSON of its durable reference — roughly forty tokens — while a DeepSeek request image costs up to 384 visual tokens, so an image-dense session could carry hundreds of thousands of unbilled estimated tokens. Provider usage anchors only completed requests: the first multimodal request, images added after the anchor, and offload-set changes all fed automatic compaction a pressure figure that was wrong by orders of magnitude, triggering it far too late (context overflow) or, after a route change, too early. The [version-one simplification](../simplification/2026-07-29-simplify-web-image-input-v1.md) had deliberately rejected a provider-neutral tile formula and deferred visual pricing until a provider-aware estimator had a concrete consumer.

## Decision

Compaction pressure is now priced by the routed model's own request projection. `LlmAdapter.imageRequestPricing(provider, model)` is an optional synchronous hook returning an `LlmImageRequestPricing` for one exact route, resolved through `ctx.llm.imageRequestPricing()`; the base adapter declares none and unknown providers degrade to `undefined`, never throw. Each ordered image occurrence resolves to an `LlmImageRequestPrice`: the provider's visual tokens for a retained image plus the model-visible text the wire actually carries (request-preview handle, offload placeholder, or text-only substitution), with the text left to the caller's own estimator so no provider fixes a text tokenization.

The DeepSeek adapter implements the hook from its connection snapshot (`request-pricing.ts`): uncatalogued and text-only models price every occurrence as its `textOnlyImageText` substitution; image-capable models reproduce the serializer's first-stage oldest-first offload through the shared `offloadedImagePrefixCount()`, build handle and placeholder text through the same execution-world access resolution the serializer uses, and price retained images at their `requestImageDimensions` projection with `deepSeekImageTokens()` — a verbatim port of the provider's published v4 vision calculator (14px patches, 3:1 downsampling, 384-token cap, minimum-pixel scale-up, 8:1 width clamp), priced at the worst-case pad-to-4 alignment. The pure geometry moved from `attachment-local` to `dsh-attachment` so provider and pricing share it.

The token meter's surface fold stores route-neutral facts per node — the fixed-heuristic price, the image-free price, and the durable image occurrences — and `measure()` prices the surface under the effective envelope's route on every call. The anchor holds its raw materials (surface snapshot, provider-output price, usage) instead of a precomputed baseline, so a matching header reprices both the anchor and the current surface under one route and the signed delta compares like with like; the usage-versus-estimated choice happens per measurement against the route-priced anchor. Public `TokenSurfaceNode` carries both `tokens` (route-priced; read by trigger, retention, range selection, and the summary-shrink comparison) and `heuristicTokens` (fixed; the shadow-price protocol's unit, so `compaction/summary` and `compaction/prune` stay consistent with the O(1) projection fold's own appends). The `contextPressure` and `contextBreakdown` projections deliberately stay on the fixed heuristic.

The test-support replay adapter declares a flat per-model `imageRequestTokens` so keyless assembled scenarios exercise the seam; the `image-compaction` ACP snapshot proves six inline images push the second turn's pre-step measurement over an automatic threshold that the text-only heuristic stays under, and that the triggered compaction shadows the image message at its heuristic price.

## Alternatives considered

**Price images inside the provider-neutral estimator.** Rejected by the [version-one note](../simplification/2026-07-29-simplify-web-image-input-v1.md) and still wrong: visual pricing varies by provider, model, detail mode, and preprocessing, and a hard-coded figure would look authoritative on routes it does not describe. The hook keeps every constant in the adapter that owns the route.

**Correct pressure only from provider usage.** Usage cannot price the first multimodal request, an image added after the anchor, or a changed offload set — exactly the cases that made compaction fire too late. Usage stays the anchor for completed requests; the route projection prices the increment.

**Reproduce the full serialization pipeline, including prepared-version bytes and the base64 fallback budgets.** The second-stage offload depends on encoded request bytes that only exist after asynchronous image preparation. The pricing reproduces the deterministic first stage from durable byte lengths; a fallback request can only offload more and cost less, so the estimate stays conservative without I/O in a synchronous hook.

**Route-price the shadow-price protocol too.** Logged `shadowedTokenCount` feeds the O(1) projection fold, whose appends are priced by the fixed heuristic; pricing replacements by route would make the persisted running total drift. Keeping the protocol on `heuristicTokens` preserves the fold's by-construction agreement.

**Fold route pricing into the meter's replay state.** A fold keyed to one route would have to replay on every route change and could not answer a `requestHeader` override for a different model. Storing route-neutral node facts and pricing at `measure()` keeps replay single-pass and measurement O(surface), which the contract already promises.

## Consequences

Automatic compaction now triggers on the pressure the routed model's next request will actually carry: image-dense DeepSeek sessions compact before overflow instead of after it, text-only routes charge substitution text instead of phantom visual tokens, and offloaded images cost their placeholder. The worst-case alignment pad overprices an image by at most three tokens, and the unreproduced base64-fallback budgets can only overprice — both errors are conservative; an execution-world access path that changes between pricing and the request shifts a descriptor's text price by its own length, and provider usage remains the authoritative anchor once a request completes. The published v4 calculator constants live in `llm-deepseek` alone; if the provider revises its vision projection, that one module and its pinned vectors are the change site. Measurement cost gains one pricing resolution and one image-occurrence walk per call, still O(surface).

## Testing

Formula vectors in `image-tokens.spec.ts` pin the published calculator's outputs, including the aspect-clamp, scale-up floor, one-column solver, odd-grid trim, and second-pass convergence cases, cross-checked against the reference implementation over a dimension grid and 50,000-point fuzz during development. `request-pricing.spec.ts` covers text-only substitution, the low-detail preset, and count- and byte-driven offload boundaries. Token-meter specs cover the first multimodal estimate, post-anchor image deltas over usage, text-only repricing under a header override, pricer-less neutrality, occurrence-count mismatch, and nested tool-result images. Compaction specs prove trigger, retention, range selection, and the summary-shrink comparison read the route price while the logged shadow price stays heuristic, including a summary that only route-priced shrink accepts. Access-resolution threading is covered at the pricing function and the adapter override. The keyless `image-compaction` ACP snapshot exercises the assembled application end to end.
