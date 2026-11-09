---
kind: upgrade-guide
description: "Update custom Node PTC bootstraps to protocol version 3 before running them with the upgraded Host."
---

# Node PTC bootstrap protocol version 3

English | [中文](guide.zh.md)

## Change

The Node PTC Host requires bootstrap protocol version 3 instead of version 2. It rejects an older bootstrap before dispatching a program, with `bootstrap protocol mismatch; upgrade launch.bootstrapPath with the host`. This affects custom `launch.bootstrapPath` deployments in every execution mode. The bootstrap bundled with DSH updates with the Host and needs no configuration change.

Version 3 carries optional `ProgramBootData.initialization` source. The bootstrap evaluates it separately after installing current bindings and before the model program in the same environment. Initialization failure prevents the model program from running. Host requests currently support initialization only in `persistent-in-memory` mode.

## Migration

1. If your Node PTC configuration sets `launch.bootstrapPath`, deploy the matching version of `@deepseek-ai/dsh-ptc-runtime-node` in its execution environment. Use the package's built `lib/process.js` or REPL-default `lib/persistent-process.js` with its dependencies. Keep the Host and bootstrap versions aligned; changing only the advertised version is insufficient.
2. Update `launch.bootstrapPath` to the matching entry and restart the provider. For local deployments that need no custom bootstrap, remove that override to use the installed default. The [Node runtime documentation](../../../../packages/ptc-runtime/ptc-runtime-node/README.md#persistent-repl) describes retained execution and remote launch.
3. Run a program in each configured execution mode and confirm that it completes without the protocol error. Consumers that provide `PtcRunRequest.initialization` must also verify that it runs before the model program and that an initialization error prevents the model program's effects.
