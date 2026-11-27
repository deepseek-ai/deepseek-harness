---
kind: upgrade-guide
description: "Invalid completed tool arguments from pi-ai routes fail with INVALID_TOOL_ARGUMENTS instead of MALFORMED_RESPONSE, and the default retry policy retries them."
---

# Invalid tool arguments error code

English | [中文](guide.zh.md)

## Change

When a pi-ai route returns a tool call whose completed arguments are invalid JSON or not a JSON object, DSH reports `INVALID_TOOL_ARGUMENTS` in the LLM error finish and in the failed turn's `turn/end` error. Previously, it reported `MALFORMED_RESPONSE`.

The default normal retry policy now lists `INVALID_TOOL_ARGUMENTS` in `retryableCodes`, so the request is sent again instead of ending the turn. A `retryPolicy` that sets `retryableCodes` explicitly keeps its list.

## Migration

1. Handle `INVALID_TOOL_ARGUMENTS` in code that classifies LLM error finishes or `turn/end` errors, where it previously matched `MALFORMED_RESPONSE` for invalid tool arguments.
2. If a provider `retryPolicy` sets `retryableCodes` and should retry invalid tool arguments, add `INVALID_TOOL_ARGUMENTS` to that list. To keep the old behavior under the default policy, set `retryableCodes` without it.
3. Check the result with `ctx.llm.providerRetryPolicy(<provider>)`, which lists the codes the route retries.
