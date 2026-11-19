---
kind: upgrade-guide
description: "ForgeFailure.code gains rate-limited, which forge-github returns when GitHub refuses a read under its rate limit, so an exhaustive switch over the code no longer compiles."
---

# `ForgeFailure.code` gains `rate-limited`

English | [中文](guide.zh.md)

## Change

`ForgeFailure['code']` from `@deepseek-ai/dsh-experimental-forge` adds `'rate-limited'`: the host refused the read under its rate limit, and reading again succeeds only after the limit resets. [forge-github](../../../../packages/experimental/forge-github/README.md#use-this-package) now returns it for a GraphQL `RATE_LIMITED` error, HTTP 429, or a message that names a primary or secondary rate limit, which it reported as `unavailable` before. Status polls, check reads, review reads, diffs, file reads, viewer lists, and descriptions can all carry it.

A third-party plugin is affected when it switches exhaustively over `ForgeFailure['code']`, ending in `assertNever` or typing a `Record<ForgeFailure['code'], …>`, which then fails to compile, or when it treats every code other than the documented ones as impossible. A provider that never returns `rate-limited` keeps working unchanged.

## Migration

1. Search for `ForgeFailure['code']`, `failure.code`, and `assertNever(` over forge failures in your plugin, and add a `'rate-limited'` case to each exhaustive switch or record. Read it like `unavailable` when you have no rate-limit handling, or wait before reading again when you do.
2. A provider that detects its host's rate limit may return `{ code: 'rate-limited', message }` from any read that resolves to `ForgeFailure`.
3. Run your typecheck; it passes once every exhaustive switch names the new code.
