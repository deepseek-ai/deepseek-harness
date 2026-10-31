---
kind: upgrade-guide
description: "pi-ai routes now offload the oldest history images once a request carries more than 50 retained images."
---

# pi-ai request image count

English | [中文](guide.zh.md)

## Change

`llm-pi-ai` previously bounded request images only by `maxRequestImageBytes`, so every retained image was resent until that byte bound was reached. Each provider route now also has `maxRequestImages` (default 50) and `imageOffloadCountQuantum` (default 10). When a request carries more retained images than `maxRequestImages`, `dsh-compaction-image-offload` replaces the oldest `imageOffloadCountQuantum` images with placeholder text and retries. The omission is recorded in the Session and does not revert. This affects Sessions with more than 50 images on any pi-ai route, including providers that accept more images per request.

## Migration

1. Check the per-request image limit of each pi-ai provider. In the `llm-pi-ai` configuration in `cordis.patch.yml`, set `providers.<provider>.maxRequestImages` to that limit when it is higher than 50.
2. To change how many images one overflow offloads, set `providers.<provider>.imageOffloadCountQuantum`; it must not exceed `maxRequestImages`.
3. Reopen the profile configuration and confirm the saved values. See the [provider configuration reference](../../../../packages/llm/llm-pi-ai/README.md).
