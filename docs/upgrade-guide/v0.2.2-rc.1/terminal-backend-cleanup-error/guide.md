---
kind: upgrade-guide
description: "TerminalBackendCleanupError extends TerminalError instead of AggregateError and carries the CLEANUP_FAILED code."
---

# `TerminalBackendCleanupError` extends `TerminalError`

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-terminal` exports `TerminalBackendCleanupError`, which a PTY backend throws when startup failed and cleaning its partial resources also failed. It previously extended `AggregateError`. It now extends `TerminalError`, so it is a `HarnessError` with code `CLEANUP_FAILED`, and a tool result that carries it records `error.name` `TerminalBackendCleanupError` and `error.code` `CLEANUP_FAILED`. The constructor, the `name`, `spawnError`, `cleanupError`, and the `errors` list in that order are unchanged; `errors` is typed `readonly unknown[]` instead of `any[]`. `cause` is a new `AggregateError` of the same two failures. `error instanceof AggregateError` is now `false`.

Backends and consumers that only construct the error, read `spawnError` or `cleanupError`, or test `instanceof TerminalBackendCleanupError` are unaffected.

## Migration

1. Replace `error instanceof AggregateError` checks meant for this error with `error instanceof TerminalBackendCleanupError`, or with `error.code === 'CLEANUP_FAILED'` on a `TerminalError`.
2. Where TypeScript code reads members of `error.errors` without narrowing, narrow each `unknown` element before use, or read `spawnError` and `cleanupError`.
3. Confirm with `pnpm exec tsc --noEmit` in the consuming project, and check that a startup cleanup failure still reaches the handling path.
