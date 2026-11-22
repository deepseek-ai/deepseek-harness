---
kind: upgrade-guide
description: "Request-image byte limits are enforced after encoding, and DeepSeek's soft target uses imageTargetBytes."
---
# Request-image byte limits

English | [中文](guide.zh.md)

## Change

Model-request images distinguish `maxImageBytes`, a hard encoded-byte limit, from `imageTargetBytes`, a preferred target. The encoder keeps the 85/75/60 quality ladder and reduces dimensions further only when its smallest output exceeds the hard limit. Each reduction starts from the saved source. A limit that cannot fit even a 1×1 image fails with `IMAGE_REQUEST_TOO_LARGE`; oversized bytes are never returned. Stored attachments are unchanged, and request caches regenerate under a new transform version.

pi exposes only hard limits. `requestImageMaxBytes` keeps its name and now sets a hard cap on the encoded image. `requestImageBudgetCount` defaults to 20. The effective hard limit is the smaller of that cap and `3 × floor(maxRequestImageBytes / (4 × requestImageBudgetCount))`; the internal soft target equals it. Default allocation is 0.75 MiB per image. Width and height follow catalog limits unless `requestImageMaxDimension` overrides both with the same value; unequal local width/height overrides are not supported.

DeepSeek renames the configurable `imageMaxBytes` soft target to `imageTargetBytes`, retaining its 2 MiB default. Its hard cap is fixed at 32 MiB. CUA's fixed `screenshotTarget.maxBytes` also becomes a hard cap. Request-image targets describe maximum dimensions; actual output can be smaller. Aggregate request limits still apply to actual encoded payloads.

## Migration

1. In pi provider profiles, review any explicit `requestImageMaxBytes` value. Images that exceed this value after quality adjustment now shrink further. Set `requestImageBudgetCount` to the desired allocation divisor, independently of the retained-count cap. The aggregate base64 budget must allow at least four bytes per share. For 1 MiB allocations, use a sufficient aggregate budget and divisor, such as 32 MiB and 20 shares, plus `requestImageMaxBytes: 1048576`.
2. In DeepSeek `models` and `modelOverrides`, rename `imageMaxBytes` to `imageTargetBytes`. Keep the value at or below 32 MiB. The retired field is rejected with migration guidance.
3. Consumers of `ImageRequestTarget` replace `maxBytes` with `maxImageBytes` and supply `imageTargetBytes` no greater than it. Read the final width and height from `readImageRequest`, including for coordinate mapping. Direct `readRequestImageFile` and `requestImageVariantId` callers must pass resolved resize controls; DeepSeek helper consumers use `resolveRequestImageTargetBytes` and `DEFAULT_REQUEST_IMAGE_TARGET_BYTES`.
4. Attachment-local deployments may tune `requestImageMinShrinkFactor` (default 1.1, greater than one) and `requestImageByteHeadroom` (default 0.95, in `(0, 1]`). Verify actual encoded bytes stay within the hard limit and coordinate mappings match the returned dimensions.
