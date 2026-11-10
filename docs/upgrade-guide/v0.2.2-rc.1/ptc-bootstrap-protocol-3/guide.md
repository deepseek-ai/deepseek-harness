---
kind: upgrade-guide
description: "Preinstalled Node PTC bootstraps must speak control protocol 3, and PtcProgramFormat gains 'scoped-repl'."
---

# Node PTC bootstrap protocol 3 and the scoped-repl format

English | [中文](guide.zh.md)

## Change

The Node PTC host and its child bootstrap now speak control protocol version 3, which adds the `scoped-repl` program format. In every execution mode, a host refuses a bootstrap that reports another version before running any program, and the call fails with `bootstrap protocol mismatch; upgrade launch.bootstrapPath with the host`. The default local and embedded launches use the bootstrap shipped with the host and are unaffected. Deployments that point `launch.bootstrapPath` at a separately installed bootstrap are affected, including `@deepseek-ai/dsh-ssh` hosts with a `node-script` launch that set `launch.bootstrapPath` and `launch.bootstrapHash`.

`PtcProgramFormat` in `@deepseek-ai/dsh-ptc-runtime` now includes `'scoped-repl'`, which `@deepseek-ai/dsh-ptc-runtime-node` reports as `PtcRuntime.programFormat` when `replScoped: true` is set with `executionMode: persistent-in-memory`. Code that matches the union exhaustively stops compiling until it handles the new value.

## Migration

1. Wherever a separate bootstrap runs, install the `@deepseek-ai/dsh-ptc-runtime-node` release that matches the host, and point `launch.bootstrapPath` in the `ptc-runtime` entry at that release's `lib/persistent-process.js`.
2. For `@deepseek-ai/dsh-ssh` with a `node-script` launch, copy the new bootstrap to the remote `launch.bootstrapPath` and set `launch.bootstrapHash` to its lowercase SHA-256, for example from `sha256sum`.
3. Handle `'scoped-repl'` wherever code switches over `PtcProgramFormat` or keys a record by it. A `scoped-repl` program is REPL statements whose final expression is the result; top-level `return` is not supported, and a final Promise is not awaited.
4. Run one `run_code` call and confirm that it no longer reports `bootstrap protocol mismatch`, then typecheck the code that uses `PtcProgramFormat`.
