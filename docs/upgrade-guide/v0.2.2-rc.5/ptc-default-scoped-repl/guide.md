---
kind: upgrade-guide
description: "Node PTC defaults to persistent-in-memory execution with the scoped REPL instead of per-call function bodies."
---

# Node PTC runs the scoped REPL by default

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-ptc-runtime-node` previously defaulted `executionMode` to `per-call`: each `run_code` program was an async function body in a fresh Node process, with top-level `return` and no state between calls. The default is now `persistent-in-memory`, which with the default `replScoped` runs the scoped REPL and reports program format `scoped-repl`. Each live Agent keeps one Node process whose top-level bindings carry into later calls; top-level `return` is rejected, and the last top-level expression statement is the completion value. The model guidance describes the new syntax.

This affects every `ptc-runtime` entry that omits `executionMode`, including the default profile's PTC mode, workflow-ptc scripts that run on that runtime, and direct runtime consumers that mount the provider without configuration. Entries that set `executionMode` explicitly are unchanged. For profiles that omit it, the Computer Use detail page reports the shared PTC runtime as already persistent and its **Use persistent mode** action is disabled.

## Migration

1. To keep function bodies in fresh processes, set the mode in `$DSH_HOME/profiles/<profile>/cordis.patch.yml`. The patch replaces the entry's whole `config`, so copy its existing fields into it:

   ```yaml
   - id: ptc-runtime
     config:
       executionMode: per-call
   ```

2. Programs written for the scoped REPL replace a final `return value` with a final `value` expression statement and use `await import(...)` instead of `require`.
3. Restart the profile, run `var probe = 1` in one call and `inspect(typeof probe)` in the next call of the same Session. The scoped REPL prints `number`; `per-call` prints `undefined`.
