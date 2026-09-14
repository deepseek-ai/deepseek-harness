# Agent Note: DeepSeek image-token estimator on the v41 calculator

Status: implemented

English | [中文](2026-09-10-deepseek-image-token-calculator-v41.zh.md)

## Problem

`deepSeekImageTokens()` in `llm-deepseek` ported the provider's published image-token calculator in its `v4` configuration: a 384×384 scale-up floor, a 384-token cap, an 8:1 width clamp, a grid layout that adds a row for odd row counts and parity corrections, and a pad-to-4 alignment charged at its worst case. The provider's Vision guide now documents a different projection for the current Flash model: images below roughly 544×544 total pixels scale up, larger images scale down to roughly 1300×1300 total pixels, and one image costs at most 1024 tokens. The published calculator carries this as a `v41` configuration and the docs page instantiates that one. The old port underprices an 800×800 request image by 73 tokens, which can delay automatic compaction in sessions containing these images. The error depends on dimensions: a 640×480 image is overestimated by 3 tokens.

## Decision

`image-tokens.ts` is rewritten as a verbatim port of the `v41` configuration. The constants are a 14px patch, 3:1 per-axis downsampling, a 544×544 total-pixel floor, and a 1024-token cap. The grid formula is `rows × (cols + 1) + 2` with no odd-row extra row, no parity correction, and no even-row trimming in the solver. There is no alignment pad, so the estimate is exact rather than a worst-case upper bound, and there is no aspect-ratio clamp, so extreme aspect ratios reach the cap through the solver's one-row and one-column branches. The over-budget path is a single closed-form solve followed by the published assertion; the decrementing retry loop existed only for the odd-row layout. The provider's fixpoint iteration over the projected dimensions is unchanged.

The test vectors are re-pinned from the published calculator. The request-pricing tests, package README, and this note carry the new numbers. This change left the 640,000 total-pixel projection the harness applied before pricing and the catalog model ids as they were; the [successor](2026-09-10-deepseek-v41-request-image-projection.md) later replaced that projection with the same grid, so omitting `imagePixelBudget` now projects onto the token grid while a positive integer or `low` keeps a total-pixel budget.

## Alternatives considered

**Keep both configurations and select by model id.** The provider states that requests to the retired `deepseek-v4-flash-vision-exp` id are served by the current Flash model, so no reachable route prices under the old configuration. Two configurations would keep dead branches and their tests alive.

**Keep the generic class with the `isNLayout`, pad, and ratio-clamp switches.** A one-configuration port has fewer unreachable branches to exclude from coverage and states the shipped rule directly; a future provider revision changes this one module and its pinned vectors either way.

**Raise the harness pixel budget in the same change.** The provider now accepts roughly 1300×1300 total pixels per image, so the harness's 640,000-pixel projection discards detail the model could use. That is a request-content change with its own snapshot impact, separate from pricing what is actually sent.

## Consequences

An 800×800 request image costs 422 tokens instead of 349, while a 640×480 image costs 206 instead of 209 and a low-budget 512×512 image costs 184 instead of 201. Compaction pressure changes with the retained image dimensions. The request projection later moved onto the same grid ([successor](2026-09-10-deepseek-v41-request-image-projection.md)), so the 640,000-pixel budget that made a square request image cost 422 tokens no longer applies. The estimate no longer carries a three-token conservative margin; provider usage remains the authoritative anchor once a request completes. Sessions replayed through `llm-replay` use their fixture's `imageRequestTokens` and are unaffected.
