---
kind: upgrade-guide
description: "Node PTC persistent-in-memory execution runs the scoped REPL unless replScoped is false."
---

# Retained Node PTC runs the scoped REPL by default

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-ptc-runtime-node` previously ran `executionMode: persistent-in-memory` programs in Node's REPL evaluator when `replScoped` was omitted. It now runs them as scoped REPL statements and reports program format `scoped-repl`. Each call is a separate strict-mode script that starts with copies of the top-level bindings left by earlier calls, so a later call may declare a `let`, `const`, or `class` name again. `require`, `_`, `_error`, and globals created by assigning an undeclared name are unavailable. The model guidance describes this behavior; the package README lists its [known limitations](../../../../packages/ptc-runtime/ptc-runtime-node/README.md#known-limitations-and-deferred-work).

This affects:

- profiles whose `ptc-runtime` entry sets `executionMode: persistent-in-memory` without `replScoped`, including workflow-ptc scripts that run on that runtime;
- persistent PTC enabled from the Computer Use detail page, which now writes `replScoped: true`;
- the Computer Use `cua_run_code` tool, whose dedicated runtime omits `replScoped` unless `standaloneRunCode.runtime.replScoped` is set;
- profile editors that merge `resolvePersistentExecution` from `@deepseek-ai/dsh-ptc-runtime-node/configuration`, which now returns `replScoped: true` for function bodies and REPL statements.

`per-call` and `vm-script` execution, including the default profile, are unchanged, and entries that set `replScoped: false` keep Node's REPL evaluator.

## Migration

1. To keep the scoped REPL, replace REPL-only code: use `await import(...)` instead of `require`, assign `globalThis.name` for an intentional global, and use a new name instead of reading a name's earlier value in its own `let` or `const` initializer.
2. To restore Node's REPL evaluator, set `replScoped: false` in `$DSH_HOME/profiles/<profile>/cordis.patch.yml`; to move an entry that sets `false` to the scoped REPL, delete the key or set `true`. Each patch below replaces that entry's whole `config`, so copy the entry's existing fields into it, for the `cua` entry including `agentPreset`, `allowedApps`, and the other `standaloneRunCode` fields:

   ```yaml
   - id: ptc-runtime
     config:
       executionMode: persistent-in-memory
       replScoped: false
   ```

   For `cua_run_code`, set it on the Computer Use provider entry:

   ```yaml
   - id: cua
     config:
       standaloneRunCode:
         runtime:
           replScoped: false
   ```

3. Restart the profile and run `const probe = 1` in two consecutive calls. The scoped REPL accepts both calls; Node's REPL evaluator reports that `probe` has already been declared in the second.
