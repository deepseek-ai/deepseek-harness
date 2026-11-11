---
kind: upgrade-guide
description: "`new LlmError` accepts only built-in failure codes; other codes go through `LlmError.fromFailure`."
---

# `new LlmError` accepts only built-in failure codes

English | [中文](guide.zh.md)

## Change

In `@deepseek-ai/dsh-llm`, the `code` parameter of the `LlmError` constructor was `string` and is now `BuiltinLlmFailureCode`: a key of `LLM_FAILURE_CODES` or `HTTP_<status>`. Runtime behavior and `LlmFailure.code` are unchanged. TypeScript code that constructs `LlmError` with any other code, such as an out-of-tree provider adapter or a test double, no longer compiles.

## Migration

1. Replace each `new LlmError(message, code, options)` whose `code` is not built-in with `LlmError.fromFailure({ message, code, ...facts }, { cause })`, where `facts` holds any `status`, `providerRetryAfterMs`, `requestId`, or `offloadImages`.
2. Re-raise a failure received from a stream with `LlmError.fromFailure(finish.failure)` instead of passing `finish.failure.code` to the constructor.
3. Confirm with `tsc` that no `LlmError` construction reports a code that is not assignable to `BuiltinLlmFailureCode`.
