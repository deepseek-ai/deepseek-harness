# Agent Note: DeepSeek request images on the published token grid

Status: implemented

English | [中文](2026-09-10-deepseek-v41-request-image-projection.zh.md)

## Problem

The harness projected every DeepSeek request image under a 640,000 total-pixel budget, a value chosen for the retired V4 vision model and kept unchanged when the [token estimator moved to the `v41` calculator](2026-09-10-deepseek-image-token-calculator-v41.md). The current Flash model retains far more: it pads each edge to whole 14px patches, groups 3×3 patches into one token cell, and keeps the largest aspect-preserving grid whose token count `rows × (columns + 1) + 2` fits 1024. A square image keeps 1302×1302 pixels, a 16:9 image keeps a 1708×966 grid, and extreme aspect ratios keep up to about 1.8 million pixels. The 640,000-pixel projection therefore sent a 2000×2000 screenshot as 800×800, roughly 38% of the pixels the model would have used, and the estimator priced that reduced version at 422 tokens instead of the 994 the model charges for the full grid. The Vision guide's "about 1300×1300 total pixels" describes only the square case; the exact rule is the token grid.

Two smaller gaps sat beside it. The request version had no per-side cap: the provider rejects any image over 4096 pixels per side once a request carries 15 or more images, while normalization admits an 8192-pixel long edge, so a many-image session could fail on one thin image. The 1 MiB encoded-byte target was sized for 640,000-pixel outputs and would push a 1302×1302 photograph down the JPEG quality ladder.

## Decision

The route chooses each request image's dimensions; the attachment provider only resizes and encodes to them. `ImageRequestPolicy` in `dsh-attachment` becomes `ImageRequestTarget`: a width, a height, and the byte target for one attachment. `readImageRequest` resizes by the source long edge alone without enlargement, so the encoder derives the short edge as the route predicted, and keys its cache by the attachment id, target dimensions, byte target, encoder settings, and the new `request-image-v6` transform version, so no earlier cache entry or upload mapping is reused. `dsh-attachment` keeps two provider-neutral geometry exports: `requestImageDimensions` for a total-pixel budget and `longEdgeDimensions` for an exact long edge with a rounded short edge.

`llm-deepseek` owns the provider rule. `image-tokens.ts` keeps the verbatim `v41` solver and adds `deepSeekRequestImageDimensions`: the source itself when its patch-padded grid fits the cap, otherwise the source aspect ratio at the solved grid's long edge, so a 3840×2160 source is sent as 1708×961 and the provider pads it to its 1708×966 grid. `resolveRequestImageTarget` applies that solver when `imagePixelBudget` is omitted, `requestImageDimensions` for a positive integer or the 512×512 `low` preset, then a 4096-pixel per-side cap on every request image so the image count never changes a target, and the route's 2 MiB byte target. Pricing prices `deepSeekImageTokens` of the same target, so the estimator and the sent image come from one solver. The pi-ai route derives its targets from its unchanged 2048×2048 pixel budget. Small images are never enlarged because the provider scales up below 544×544 pixels itself.

## Alternatives considered

**Raise the pixel budget to 1302×1302.** A total-pixel budget is right only for squares: a 16:9 source would be sent at 1.69 million pixels when the grid keeps 1.65 million, and a 4:1 source when it keeps 1.59 million, while extreme ratios would lose detail the grid keeps. One rule that reproduces the provider removes the guesswork.

**A `token-grid` projection kind on the attachment policy, with the solver in `dsh-attachment`.** This was built first: the policy became a closed union of `pixel-budget` and `token-grid`, the solver moved into `request-projection.ts`, and `deepSeekImageTokens` imported it back. It put one provider's layout formula and patch constants into the provider-neutral package under a generic-looking name, needed an `unscaled` flag so the store could tell "send the source" from "send the solved size", and would grow a new union member for every provider rule. Handing the store a finished target keeps the provider rule beside the provider's pricing and leaves the store with no projection vocabulary at all.

**Send the solver's exact grid dimensions with a fill resize.** The solved grid edges are whole patches and differ from the source aspect ratio by under one patch. Filling that box would distort the image slightly even though the provider does the same on its side; preserving the source aspect ratio can change how many token cells the rounded short edge covers. A 1224×1429 source is sent as 1187×1386: the published calculator gives 959 tokens for the source and 992 for the sent dimensions. Request generation and pricing share the target dimensions, and pricing applies the published calculator to that target.

**Keep the 1 MiB target.** The target is not a cap: an output over it is still sent at the smallest ladder quality. At 1302×1302 a JPEG photograph at quality 85 lands between 400 KB and 1.2 MB, so 2 MiB keeps most images at the top quality and lets more PNG screenshots pass through losslessly, while the inline base64 fallback still holds about seven such images under its 20 MiB bound.

## Consequences

A square source now reaches the model at up to 1302×1302 pixels and 994 tokens instead of 800×800 and 422, so image-heavy sessions reach compaction pressure sooner and the estimator applies the published token rules to the sent target dimensions. Every existing request-image cache entry and DeepSeek Files API mapping is regenerated on the next request. Thin images keep their full grid until the per-side cap applies: an 8192×78 source costs 396 tokens under the grid but is sent as 4096×39. `llm-replay` does not project images, so keyless snapshots cannot record the sent dimensions; the `llm-deepseek` adapter tests pin the resolved targets and the projected handle text against a mock server, and the local store tests resize real images to targets.
