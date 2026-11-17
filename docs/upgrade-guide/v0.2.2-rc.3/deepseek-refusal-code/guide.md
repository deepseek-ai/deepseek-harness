---
kind: upgrade-guide
description: "The DeepSeek streamed content refusal code changes from MALFORMED_RESPONSE to CONTENT_REFUSED."
---

# DeepSeek content refusal error code

English | [中文](guide.zh.md)

## Change

When DeepSeek ends a model stream with `stop_reason: "refusal"`, DSH reports `CONTENT_REFUSED` in the LLM error finish and in the failed turn's `turn/end` error. Previously, the adapter reported `MALFORMED_RESPONSE` for this stop reason.

## Migration

1. Handle `CONTENT_REFUSED` in code that classifies LLM error finishes or `turn/end` errors. Tell the user that the provider refused the request.
2. Replay a Messages stream ending in `refusal` and check that your handler takes the refusal path.
