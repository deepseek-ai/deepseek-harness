---
description: "The stdio JSON-RPC serving plugin for deployments that let out-of-process SDK clients open sessions and drive agents in a DeepSeek Harness runtime."
kind: "package-reference"
---

# @deepseek-ai/dsh-sdk-jsonrpc-server

English | [中文](README.zh.md)

## Summary

`dsh-sdk-jsonrpc-server` serves the SDK wire protocol over stdio so out-of-process clients can drive harness agents: it opens one session per `sessionId`, queues user prompts, and streams every session event and agent status transition back to the client. Mount it as the `jsonrpc` plugin in a Loader composition; the surrounding tree supplies everything else — agents, model adapters, persistence, and tools. Stdout carries only JSON-RPC frames, so a deployment must not compose a stdout logger. It answers `shutdown` by disposing the root runtime and exiting 0; the app bin owns EOF and signal exits.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when a runtime must serve SDK clients: add it to a `cordis.yml` that composes the agent service, boot the runtime, and clients connect over stdio. The common path is explicit — the plugin needs the `agents` service; every other capability comes from the surrounding tree.

### Wiring

The plugin creates one agent per `sessionId` on first use. A registered model adapter wins the route; an unowned `deepseek-official` route mounts the DeepSeek adapter, and any other unowned provider fails initialization. The selected adapter resolves the exact model and optional reasoning effort before initialization succeeds.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxTokensAsSuccess` | `false` | Report max-token turn/subagent termination as a successful SDK result |

The profile composition owns each root agent's tools. `input`, `output`, and `exit` are runtime-only transport hooks for tests; production uses process stdio and `process.exit`. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-sdk-jsonrpc-server) is the exhaustive source for every accepted field.

### stdout is the protocol

Stdout carries only JSON-RPC frames, so clients can parse every byte; diagnostics belong on stderr. Keep stdout loggers out of the composed tree.

### What SDK clients can do

`initialize` is the runtime-readiness boundary: when the server is mounted by a Loader composition, it waits for the current plugin tree to settle before replying, so async sibling capabilities such as initial MCP tool discovery are visible to the first prompt. The handshake returns the wire-stable identity `deepseek-harness-sdk-runtime`. The server validates the provider/model route and optional non-empty `reasoningEffort` through the selected adapter before it stores them; omission stores no effort, so the model retains its own default. An optional positive `maxTokens` becomes the request output cap of each SDK-created agent and its in-process descendants, while omission applies the selected adapter or provider route default. JSON-RPC requests may dispatch concurrently, so `session/prompt` rejects until one `initialize` has completed successfully; clients must await the handshake before sending prompts. An accepted prompt queues one identified user message and immediately returns `{ messageId }`; the server then streams every durable fact as `session.event` and every whole-agent lifecycle transition as `session.status`. It does not assign an assistant message or `turn/end` to a prompt, and independent requests may enqueue more work on the same session. Persistence roots and persona come from the surrounding composition.

### Shutdown and exit

The plugin answers `shutdown`, flushes the response, disposes the root context so SDK-owned agents, subscriptions, and persistence reach quiescence, then exits 0. EOF and signal exits belong to the app bin, which also disposes the root context. Unloading only this plugin stops serving without exiting the process.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the serving plugin; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The plugin is a thin presentation adapter: [`HarnessSdkJsonRpcServer`](src/server.ts) owns the protocol methods and notifications, while the transport and the named wire types come from `dsh-sdk-protocol`, shared with the client SDKs. It subscribes to session, agent, and subagent lifecycle events and forwards them as wire notifications; subagent completions are forwarded only when the service-snapshotted lifecycle `local` flag is true — provider names, child ids, and durable lineage never establish locality.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, stdio wiring, request dispatch, shared shutdown/exit task |
| [`src/server.ts`](src/server.ts) | `HarnessSdkJsonRpcServer`: protocol methods, per-session agent creation, lifecycle subscriptions, teardown |
| — | No runtime invariant companion is published; this presentation adapter owns no durable package-local event stream; boundary and replay tests cover its protocol mapping. |

### Request flow

Each protocol method validates its inputs and resolves the owning state before acting — `initialize` stores the SDK route, `session/prompt` resolves the live agent+session pair and queues the message, and `shutdown` disposes server-owned state to quiescence before flushing the response and exiting 0 — and a shared exit task guarantees that racing `shutdown` requests never dispose or exit twice. The dispatch lives in [src/index.ts](src/index.ts) and [src/server.ts](src/server.ts).

### Teardown

`server.shutdown()` disposes only what the server owns — the surrounding context stays running when just this plugin is unloaded. Protocol `shutdown` instead disposes the root fiber so persistence and the whole runtime reach quiescence before the process exits.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the plugin contract is not enough. They move from the wire protocol to the clients and the runnable application.

- [SDK wire protocol](../protocol/README.md) — the methods and payload shapes this plugin serves.
- [TypeScript SDK client](../client/README.md) — the client that drives this plugin.
- [SDK application bundle](../../bundle/sdk-app/README.md) — the `dsh --profile sdk` application that boots this plugin.
- [Python SDK](../../../python/README.md) — the Python client that drives the same server.
- [SDK runtime distribution decision](../../../.agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md) — why the packaged runtime serves a closed plugin tree.

-----

<a id="model-experience"></a>
## Model Experience

### SDK user message

#### What the model sees

For each accepted `session/prompt`, text and durable content references enter one user message verbatim. Inline `SdkEncodedImageBlock` values are validated and committed through the composition's attachment store first, so the session log retains content-addressed image references rather than base64 bytes. This package adds no system-prompt prose or tool schema; those come from the other plugins in the composition.

#### Token effect

Data-dependent user-message tokens enter retained session history and are resent on later turns until another package compacts them. The JSON-RPC frames, session notifications, and server bookkeeping add zero model-context tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the plugin needs special operational care. They are current package constraints, not a comparison with other serving approaches or a task backlog.

- **The wire has no per-session close or prompt-cancel method** — SDK-created agents remain live until process shutdown.
- **There is no per-prompt result** — `MessageId` identifies inbox admission only; clients that own an automation interval must define and observe that interval themselves.
- **stdout purity is deployment-enforced** — a surrounding config can still load a stdout logger and corrupt the JSON-RPC channel; this plugin does not inspect or veto sibling loggers.
- **Automatic adapter mounting is DeepSeek-specific** — `initialize` can reuse any pre-registered model adapter, but its only fallback mounts the DeepSeek adapter.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the code. The single-executable runtime distribution pairs this plugin with the packaged `jsonrpc-demo` bin; keep the shutdown/exit contract consistent with the app bin, which owns EOF and signal exits. No other unresolved design questions are recorded.

</details>
