# Agent Note: Alpha-routed image quality ladders replace colour-count codec routing

Status: implemented
Archived: 2026-09-30

English | [中文](2026-08-24-alpha-routed-image-quality-ladders.zh.md)

## Problem

Image normalization and request-image encoding in `@deepseek-ai/dsh-attachment-local` chose their codec by a 5-bit colour-count sample: images whose 128×128 nearest-neighbour sample stayed within 256 quantized colours went to palette PNG (libimagequant) before WebP, other alpha images to WebP, and other opaque images to JPEG. High-frequency photographic JPEGs routinely quantize below the threshold — issue #2885's 8000×8000 reproduction images measure 175 and 184 sampled colours against 2145 and 4077 real colours — and palette PNG is the slowest encoder in the pipeline while producing files about four times larger than JPEG on such content (measured 2657ms/3.95MiB versus 26ms/0.95MiB at the 2048px master size). The sample itself forces a full decode (`fastShrinkOnLoad: false`), costing 86 to 192ms on 64MP sources for every image. When every candidate exceeded the byte cap, both encoders also entered a proportional-downscale retry loop ending in an `IMAGE_TOO_LARGE` error, although measured worst-case inputs (uniform noise) fit the default budgets at the first quality.

## Decision

Both encoders route by one decoded fact only: sources with an alpha channel encode as lossy WebP at effort 0, opaque sources as JPEG (libjpeg-turbo), each down a shared quality ladder of 85, 75, 60 (`IMAGE_ENCODING_QUALITIES` / `WEBP_ENCODING_EFFORT` / `encodingLadder` in `encoding.ts`). The colour-count classifier and the palette PNG branch are deleted, not repaired, so the misclassification bug class cannot recur and no image pays the classification decode. `normalizedImageMaxBytes` and the route `maxBytes` become ladder targets rather than caps: the ladder still stops at the first quality that fits, but when every quality exceeds the target the smallest output is kept and the downscale retry loop is gone. Provider byte limits (DeepSeek 32MiB per image, inline budgets) remain enforced where the bytes are transmitted. Master dimensions move from a long-edge rule to a total-pixel budget: `normalizedImageMaxPixels` (default 2048x2048) scales the raster proportionally and `normalizedImageMaxDimension` (default 8192, matching the admission per-side cap) clamps the long edge afterwards, so extreme aspect ratios such as tall page screenshots keep their short-edge resolution (a 2000x20000 source keeps about 647px of width instead of 204px) while square sources normalize exactly as before. The request transform version moves to `request-image-v5`, so existing cached variants regenerate by identity; content-addressed masters stay valid without migration. The request cache read no longer rejects entries above the byte target, since a ladder-exhausted output is the deterministic result for its variant id.

Pareto measurements over the issue #2885 reproduction set (PR #2989 appendices) back the choice: on photographic content JPEG is one to two orders of magnitude faster than every alternative, and WebP at effort 0 matches palette PNG's size on graphics content while never being misrouted; uniform-noise worst cases fit the default 4MiB/1MiB targets at quality 85 for opaque sources, and only an adversarial random-alpha plane exhausts the WebP ladder (about 6.3MiB, five times under the provider cap).

This decision partially supersedes the [unified image request pipeline note](../feature/2026-08-20-unified-image-request-pipeline.md), whose normalization and request-encoding sections now describe this routing; its durable-version split, Files lifecycle, and offload projection stand unchanged.

## Alternatives considered

**Repair the classifier (higher-resolution sampling, gradient statistics) and keep palette PNG.** Rejected: any content classifier retains a misrouting class and the per-image classification decode; palette PNG's only frontier niche (graphics) is matched by WebP at a fraction of the encode time.

**A single WebP ladder for everything.** Rejected: JPEG is four to six times faster on opaque photographic content, the dominant real workload, and the alpha probe is a metadata read costing nothing.

**Keep the downscale retry loop for ladder-exhausted outputs.** Rejected: measured worst cases show the loop is dead code within default budgets, and its only reachable effect was degrading adversarial inputs to 1×1 before erroring.

## Consequences

- Opaque low-colour graphics (charts, text screenshots) now store as JPEG: two to three times larger than palette PNG in the hundreds-of-kilobytes range, with JPEG ringing on hard edges; the model-visible request version was already dominated by pixel-budget downscaling, so legibility impact is marginal. Reintroducing a graphics codec would add a WebP step to the opaque ladder, not restore classification.
- GIF sources decode with an alpha plane under gifload, so still-frame GIFs normalize onto the WebP ladder.
- `IMAGE_TOO_LARGE` no longer arises from encoding; it remains the admission error for oversized sources.
- A ladder-exhausted attachment can exceed its byte target on disk and on the wire until a provider cap rejects it; measured reachable only with adversarial random-alpha input. Re-submitting such an over-target master as a new upload fails the pass-through byte check and re-encodes it down the lossy ladder again, so normalization is not idempotent for this adversarial-only class and each round adds generation loss.
- Test evidence: `packages/attachment/attachment-local/tests` pins the routing, ladder-exhaustion, and readable-text behavior against real encoders, including the issue #2885 misrouting characteristics (high-frequency photographic content leaving the slow path).
