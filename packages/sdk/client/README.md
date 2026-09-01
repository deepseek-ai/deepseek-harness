---
description: "The TypeScript SDK client for callers that spawn a DeepSeek Harness runtime subprocess and drive agent turns over stdio JSON-RPC: the DeepSeekHarness run API and the lower-level HarnessClient."
kind: "package-library"
---

# @deepseek-ai/dsh-sdk-client

English | [中文](README.zh.md)

## Summary

`dsh-sdk-client` lets TypeScript programs drive a DeepSeek Harness runtime as a subprocess over stdio JSON-RPC. With `DeepSeekHarness` you can spawn the runtime, open sessions, send prompts, and collect the final response plus the event and notification streams; `HarnessClient` gives explicit control over the protocol layer. It is the design twin of the [Python SDK](../../../python/README.md), which shares the same runtime peer and protocol. The launch spec is explicit — callers may name the runtime executable via `dshBin`, omitted resolves the same-version `@deepseek-ai/dsh` package's bin, and the client constructs the arguments — so this client suits repository-adjacent TypeScript consumers such as the SDK subagent backend and automation that know which runtime they are launching. It is a pure library: it registers nothing on a Cordis context, and the runtime it spawns is a complete harness whose composition its own `cordis.yml` decides.

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

Use this client when TypeScript code must drive a complete Harness runtime from another process and you can name the runtime executable explicitly. The common path is minimal: construct a `DeepSeekHarness` with a launch spec, run prompts, and close it so the child process is always reaped.

### Running agent turns with DeepSeekHarness

```ts
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

await using harness = new DeepSeekHarness({
  profile: 'sdk',
  patches: ['./automation.cordis.yml'],
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: ReasoningEffortId('max'),
  maxTokens: 49_152,
})
const result = await harness.run('say hi')
console.log(result.finalResponse)
```

The subprocess starts lazily on first use and stays owned by the instance across `run()` calls; call `close()` (or use `await using`) so the child is always reaped. `start()` memoizes the bounded `initialize` handshake, which carries the workspace cwd, provider/model route, optional adapter-owned `reasoningEffort`, and optional positive `maxTokens` output cap. The server validates that exact route before it accepts prompts; an omitted effort preserves the model's default. `initializeTimeoutMs` defaults to 10 seconds, and its diagnostic names the selected profile with the retained stderr tail. `run(input, { sessionId?, onNotification? })` accepts text or `SdkPromptContentBlock[]`; an inline raster block carries canonical base64 plus `mimeType` and becomes a durable attachment inside the runtime. The call owns one activity interval: it queues the prompt, waits until its message id appears in a durable inbox receipt, then collects through the next whole-agent `idle`. It returns `RunResult { sessionId, finalResponse, events, notifications }`, where `finalResponse` is the last committed root-session assistant text in that interval — not a response causally assigned to the prompt, because steering, injected context, and other queued work may contribute before idle. `session(id?)` opens a named or fresh session handle. When a failed handshake is cleaned up successfully, the instance installs a fresh client so a later call retries with a new process until terminal `close()`; if initialization and cleanup both fail, `start()` returns an ordered `AggregateError` and retains the failed client instead of spawning beside a process whose exit is unproved. `maxTokens` caps each root-agent request output and is inherited by in-process descendants; compaction plugins own their separate summary limits.

### Lower-level control with HarnessClient

`HarnessClient` is the protocol client under the run API: explicit `start()`, `initialize()`, `prompt()`, `request()`, and `close()`, plus notification subscriptions. `prompt()` returns the queued message id as soon as the runtime accepts it and never waits for agent activity. `subscribe(filter?)` returns a `NotificationSubscription` (awaitable `next()`, non-blocking `tryNext()`, async iteration); `subscribeSessionTree(id)` scopes to one session and the descendants discovered from `subagent.started` lineage edges — the runtime notifies for every session in its context, and scoping is client-side, exactly like the Python SDK.

The client exports typed errors for every failure mode: `JsonRpcResponseError` (a wire error response, code and data preserved), `RequestTimeoutError` (a configured bound elapsed), `SdkProtocolError` (a response outside the documented protocol), and `TransportClosedError` (the runtime is gone — the message carries the exit code and a bounded stderr tail). `close()` requests protocol `shutdown` (bounded by `shutdownTimeoutMs`, default 1000 ms), then walks a stdin-EOF → SIGTERM → SIGKILL ladder until the process has exited; it is idempotent, and a closed client refuses reuse. `HarnessClientOptions.env` replaces the child environment entirely when given (`undefined` inherits the parent's); callers own credential policy — `scrubbedParentEnv` from `dsh-subprocess` is the shared scrub base for isolation-minded launches.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the client; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The client is two layers over one wire: `DeepSeekHarness` (owned runs) over `HarnessClient` (the protocol client), mirroring the Python SDK's layering. It runs outside any harness context, so it spawns the runtime directly rather than through the `dsh-subprocess` service — the seam's documented exception for SDK-managed transports — and its teardown ladder lives in this package. The runtime notifies for every session in its context; session-tree scoping is a client-side filter over `subagent.started` lineage edges.

### Source map

| File | Role |
|---|---|
| [`src/api.ts`](src/api.ts) | `DeepSeekHarness` + `HarnessSession`: owned runs, receipt-to-idle collection, `finalResponse` |
| [`src/client.ts`](src/client.ts) | `HarnessClient`: spawn, handshake, requests, subscription fan-out, typed errors |
| [`src/dispose.ts`](src/dispose.ts) | Private teardown ladder: stdin EOF → SIGTERM → SIGKILL to actual exit |
| [`src/types.ts`](src/types.ts) | Launch and timeout options, notification shapes, `RunResult` |
| [`src/index.ts`](src/index.ts) | Consumer interface: the two client layers and caller-facing types |
| — | No runtime invariant companion is published; this client library runs outside any harness context (its peer is a separate runtime process); the runtime's own packages own the event-stream relations. |

### Owned activity flow

A run subscribes to the session tree, queues the prompt, waits until the prompt's message id appears in a durable `agent/inbox/spliced` receipt, then collects notifications until the whole agent reports `idle`. `finalResponse` is derived from the last `assistant/message` in the collected events. Transport loss, timeout, and protocol violations reject the run; model outcomes remain observable in the event stream without being attributed to one input.

### Errors and teardown

Every failure mode maps to one exported error class — a wire error response, an elapsed request bound, a response outside the documented protocol, or a dead runtime — so callers branch on failure type; the four classes are exported from [src/index.ts](src/index.ts). Teardown is a private, idempotent escalation (stdin EOF → SIGTERM → SIGKILL) in [src/dispose.ts](src/dispose.ts) that ends only at actual process exit.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the client contract is not enough. They move from the wire protocol to the serving plugin and the applications that use this client.

- [SDK wire protocol](../protocol/README.md) — the JSON-RPC methods and payload shapes this client speaks.
- [JSON-RPC serving plugin](../server/README.md) — the runtime plugin that serves this client.
- [Python SDK](../../../python/README.md) — the design twin that shares the same runtime peer and protocol.
- [SDK subagent backend](../../subagent/subagent-dsh-sdk/README.md) — a harness-internal consumer of this client.
- [SDK application bundle](../../bundle/sdk-app/README.md) — the `dsh --profile sdk` runtime application this client launches.

-----

<a id="model-experience"></a>
## Model Experience

None, as this is a client-process library; model-facing behavior lives in the spawned runtime's composed plugins.

#### KV Cache effect

None in the client process. Profile, patch, provider, model, and history choices determine cache reuse in the child.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the client is a poor fit or needs special care. They are current package constraints, not a comparison with other SDK clients or a task backlog.

- **No bundled-runtime resolution** — the client resolves the same-version `@deepseek-ai/dsh` package (or a caller-provided `dshBin`); packaged-executable discovery stays Python-side until a TypeScript distribution consumer exists.
- **No mid-turn cancel** — the wire has no prompt-cancel method; abandoning a turn means closing the runtime (see the [protocol limitations](../protocol/README.md#known-limitations-and-deferred-work)).
- **No per-prompt result** — low-level `prompt()` returns only an enqueue receipt; high-level `run()` owns receipt-to-idle collection, and abandoning it means closing the runtime.
- **Client→server notifications and server→client requests are unimplemented** on both wire ends; the transport carries them for future approval flows.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the code. The launch spec is intentionally fully explicit: no bundled-runtime resolution is planned for TypeScript until a distribution consumer exists. Keep the dispose ladder and the error vocabulary in sync with the Python client, which drives the same runtime. No other unresolved design questions are recorded.

</details>
