---
description: "Package map for the SDK family: JSON-RPC protocol plus the TypeScript client and server used by out-of-process SDKs."
kind: "package-group"
---

# sdk/ — drive a Harness runtime from another process

English | [中文](README.zh.md)

## Summary

The SDK family lets another process drive a complete DeepSeek Harness runtime over newline-delimited JSON-RPC. Its protocol package defines the public messages, the TypeScript client launches `dsh` with a named profile and ordered patches, and the server accepts SDK requests over stdio. Clients can open sessions, send prompts, and observe session events, agent status changes, and subagent completions. The TypeScript client and [Python SDK](../../python/README.md) use the same protocol, and these packages do not create developer projects or define another application.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Each package README describes what you can do with its part of the stack.

| Package | Role |
|---|---|
| [`protocol/`](protocol/README.md) | Wire protocol: the newline-delimited JSON-RPC transport and the named request, result, and notification types |
| [`client/`](client/README.md) | TypeScript client that spawns a runtime subprocess and drives agent turns through the high-level and protocol-level APIs |
| [`server/`](server/README.md) | `jsonrpc` plugin that serves out-of-process SDK clients over stdio |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the Python SDK (the sibling implementation of the client contract), then the runnable application and the decision records behind the group's boundary.

- [Python SDK](../../python/README.md) — the Python counterpart that speaks the same protocol and ships a bundled runtime.
- [SDK application bundle](../bundle/sdk-app/README.md) — the `dsh --profile sdk` application that boots the JSON-RPC server.
- [Architecture](../../docs/architecture.md) — why the packaged Python client launches the same named profiles.
- [SDK project toolchain removal](../../.agents/notes/archived/simplification/2026-08-11-remove-sdk-project-toolchain.md) — why this group never creates, configures, or builds developer projects.
- [SDK subagent provider](../subagent/subagent-dsh-sdk/README.md) — a harness-internal consumer of the TypeScript client.

<a id="dev-note"></a>
## Dev Note

None.
