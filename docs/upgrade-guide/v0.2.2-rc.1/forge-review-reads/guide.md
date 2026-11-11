---
kind: upgrade-guide
description: "ForgeFailure gains the unsupported code, which ctx.forge.readReview returns for a provider without review reads."
---

# Forge failures report unsupported reads

English | [中文](guide.zh.md)

## Change

`ForgeFailure['code']` gains `unsupported`. `ctx.forge.readReview(ref, headSha, signal)`, new beside the optional `ForgeProvider.readReview`, returns it when the provider of the change request does not read review threads. Other reads keep their codes: a provider without `fetchChecks` still makes `ctx.forge.fetchChecks` return `unavailable`.

This affects code that switches exhaustively over `ForgeFailure['code']`, such as a `Record<ForgeFailure['code'], …>` lookup or a `switch` that ends in `assertNever`. All types come from `@deepseek-ai/dsh-experimental-forge`. Providers need no change: `readReview` is optional.

## Migration

1. Handle `unsupported` wherever code switches exhaustively over `ForgeFailure['code']`; treat it as a capability the provider lacks, not as a failed read to retry.
2. Run your type check; it succeeds when no `ForgeFailure` code is unhandled.
