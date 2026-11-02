---
kind: upgrade-guide
description: "PTC programFormat includes Script syntax, and consumers read retainsState for cross-call memory."
---

# Handle Script programs and explicit state retention

English | [中文](guide.zh.md)

## Change

The published `@deepseek-ai/dsh-ptc-runtime` service widens `PtcRuntime.programFormat` from `'function-body' | 'repl'` to include `'script'`. External consumers that exhaustively match the old union must handle the new value. `retainsState` reports whether a provider preserves memory for a `stateOwner`; its base implementation returns `false`, so custom retained providers must override it.

Node keeps `per-call` as its default. The opt-in `executionMode: vm-script` accepts Script statements and top-level await, with `scriptPersistence` selecting cross-call memory independently. Existing Node function-body and REPL configurations remain valid.

## Migration

1. Import the exported `PtcProgramFormat` from `@deepseek-ai/dsh-ptc-runtime` instead of copying its union literals. Update `programFormat` switches in custom tool or workflow adapters. Handle `'script'` using statements or a final expression, without top-level `return`; consult the [Node syntax reference](../../../../packages/ptc-runtime/ptc-runtime-node/README.md#use-this-package).
2. Replace checks that infer memory retention from `programFormat === 'repl'` with `runtime.retainsState`. If a custom `PtcRuntime` provider retains owner-scoped memory, override `retainsState` to return `true` and continue implementing `release(owner)`.
3. Rebuild external consumers against the new package declarations. Confirm that each supported format compiles and that persistence controls follow `retainsState` for both REPL and Script providers.
