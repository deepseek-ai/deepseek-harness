---
description: "The out-of-process SDK subagent backend for users and maintainers choosing a delegation provider, configuring a child Harness runtime command, or debugging remote child runs."
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-dsh-sdk

English | [中文](README.zh.md)

## Summary

`dsh-subagent-dsh-sdk` runs each delegated child as a complete DeepSeek Harness runtime in a fresh subprocess, driven over stdio JSON-RPC through the TypeScript SDK client. It is the second out-of-process backend beside the ACP provider, differing in the wire and the child contract: the child is a full peer harness with its own `cordis.yml`-decided composition, session persistence, model route, and tools. Each run spawns the child runtime (the resolved `@deepseek-ai/dsh` CLI under Node, or the configured `dshBin`), completes an `initialize` handshake with the configured provider and model route, submits the task, and reads the answer from the child's session events. The parent receives only the child's final assistant text or a safe error — no intermediate messages or tool traffic crosses the boundary. Choose it when the child should be a genuine Harness runtime, fully isolated from the parent harness.

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

Mount this provider when a delegation should run as a complete Harness runtime in its own process. The common path is explicit: mount the seam, mount this provider, and give it a command that starts an SDK runtime with its own `cordis.yml`.

### When to choose it

Choose this backend when the child must be a full harness peer — its own composition, session persistence, model route, and tools — rather than an agent that shares the parent's process. Choose an in-process backend when the child must share the parent's composition or honor parent-enforced non-route capabilities: this provider accepts agent route options but rejects structured output, depth caps, tool filters, and personas rather than silently omitting them.

The provider advertises `agentOptions: true`, with `outputSchema`/`depthLimit`/`toolFilter`/`persona` false, and `inheritsParentContext: false`. Its immutable `agentRouteDefaults` publish the configured provider/model baseline to `dsh-tool-subagent` before model overrides and exact-route preflight; `start()` independently applies the same configuration defaults for direct callers and `maxTokens`. Agent route values cross the SDK wire as an explicit whitelist; the child remains a fresh runtime in another process, and the only value derived from the parent agent itself is the workspace cwd. `dsh-tool-subagent` deployments over this provider set `maxDepth: 'provider-managed'` — the child harness owns its own recursion budget.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `dsh-sdk` | Registry name on `ctx.subagents` |
| `dshBin` | SDK dependency | Explicit dsh CLI module, resolved and checked at plugin load; omission uses the SDK dependency |
| `profile` | `sdk` | Named child profile |
| `patches` | `[]` | Ordered per-launch profile patch files, resolved and checked at plugin load |
| `dshHome` | required | Absolute isolated Harness home for every nested child process |
| `cwd` | parent session cwd | Working-directory override for the child process and its SDK session |
| `provider` | `deepseek-official` | Provider route sent in the child's `initialize` |
| `model` | `deepseek-v4-flash` | Model sent in the child's `initialize` |
| `maxTokens` | adapter/provider route default | Per-request output-token cap sent in the child's `initialize` |
| `env` | `{}` | Explicit child environment layered over the credential-scrubbed parent environment |
| `shutdownTimeoutMs` | `1000` | Bound on the protocol `shutdown` exchange during dispose |
| `disposeEofGraceMs` | `6000` | Grace after stdin EOF before platform termination |
| `disposeGraceMs` | `3000` | Exit-confirmation grace after termination |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-dsh-sdk) is the exhaustive source for every accepted field and its JSDoc.

Request `agentOptions` override `provider`, `model`, and `maxTokens` independently. `reasoningEffort` has no provider-instance default: an omitted request leaves it absent so the selected child model resolves its own default. The model-facing subagent tool can select provider/model/reasoning per call; `maxTokens` remains deployment-controlled through tool config or this provider's default.

```yaml
- id: subagent-dsh-sdk
  name: '@deepseek-ai/dsh-subagent-dsh-sdk'
  config:
    providerName: dsh-sdk
    profile: sdk
    patches: ['./profiles/research-child.cordis.yml']
    dshHome: !!js dshHomePath('children')
    maxTokens: 49152
    env:
      DEEPSEEK_API_KEY: !!js process.env.DEEPSEEK_API_KEY
- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config: { provider: dsh-sdk, toolName: subagent, maxDepth: 'provider-managed' }
```

### What you get

A successful run returns the child's final assistant text (or accumulated partial text after cancellation) as result output. The child's model route, tools, and session come from the child runtime itself — the parent supplies the task, working directory, and `initialize` route. The child's last durable `turn/end` maps into the seam vocabulary: `completed` and `max-tokens` pass through, `blocked` becomes `refusal`, and an unexpected or missing terminal becomes `error`. An `aborted` result stays aborted; only a child-side `disposed` cause adds a `child-disposed` diagnostic.

### Failure and recovery

An already-aborted request fails before path resolution or spawn. A route, spawn, handshake, or pre-publication cancellation failure ordinarily rejects only after the subprocess is reaped. If initialization and cleanup both fail, the ordered safe facts preserve both failures without claiming quiescence. A child runtime that fails after publication settles through the run rather than rejecting it; partial output stays separate from the safe diagnostic. Diagnostics expose only the provider plus `initialize`, `session-run`, or `shutdown` stage and a fixed category. They never copy SDK messages, stderr, paths, task content, environment values, credentials, or protocol payloads.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the backend drives a child Harness runtime and where the observable behavior comes from; the full contract lives in [Use this package](#use-this-package).

### Design concept

- **Full harness peer.** Each child is a complete Harness runtime in its own process — own composition, session, model route, and tools; only the resolved working directory and the `initialize` route cross from the parent.
- **One runtime per run.** Every run spawns a fresh runtime process; there is no pooling.
- **The JSON-RPC wire is the serialization boundary.** Same-process subagent values are not defensively cloned; the protocol is where hostile input is validated.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, provider registration |
| [`src/run.ts`](src/run.ts) | The SDK run lifecycle, answer extraction, and stop-reason mapping |

### Run flow

A start resolves the child's working directory and one process-wide SDK route before spawning. Each declared `request.agentOptions` field (`provider`, `model`, `reasoningEffort`, or `maxTokens`) overrides the matching provider-instance default; omission preserves the configured provider/model and optional cap, while reasoning effort remains absent unless the request supplies it. The provider spawns the runtime through the SDK client and completes the `initialize` handshake, including exact-model and effort validation, before it fulfills. A route, spawn, handshake, or pre-publication cancellation failure rejects only after the subprocess is reaped; a working-directory resolution failure rejects before spawning. After publication the provider owns one SDK activity and reads the child's answer from its session events: the last complete non-empty `assistant/message` (an empty-content message that records usage is skipped), or the accumulated `text-delta` stream when no such message exists. Disposal is idempotent: it settles the result locally as `aborted`, sends a bounded protocol `shutdown` request, then escalates through stdin EOF → SIGTERM → SIGKILL to actual exit.

### Stop-reason mapping

The child's last `turn/end` reason maps into the shared stop-reason vocabulary in [`src/run.ts`](src/run.ts).

### Process boundary

The child environment is the subprocess seam's credential-scrubbed parent environment with explicit `config.env` values merged after the scrub. The child is spawned by the SDK client rather than through `ctx.subprocess` — the documented exception for SDK-managed transports — which is why this backend applies the scrub itself.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from this backend to the seam it plugs into and the SDK it drives.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — the service contract, provider contract, and terminal result semantics.
- [dsh-subagent seam](../subagent/README.md) — the registry and start API this provider registers on.
- [ACP subagent backend](../subagent-acp/README.md) — the sibling out-of-process provider over the Agent Client Protocol.
- [TypeScript SDK client](../../sdk/client/README.md) — the stdio JSON-RPC client this backend drives the child through.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-dsh-sdk) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Child-agent request

#### What the model sees

The child runtime's model receives the standalone task as its user message plus that runtime's own configured system prompt, tools, and fresh session. It receives no parent conversation. A parent tool call may choose the child provider, model, and reasoning effort for this run; the selected route and any deployment-owned output cap are fixed for the new child process. Persona, tool filtering, depth enforcement, and structured output remain unsupported and are rejected instead of silently omitted.

#### Token effect

The child pays for an independent full context and its own multi-step history. These tokens never enter the parent's context.

#### KV Cache effect

Independent of the parent request cache. Each SDK child can reuse only prefixes identical under its own provider, model, composition, and history; child steps otherwise grow append-only.

### Parent tool result, indirectly

#### What the model sees

Through `dsh-tool-subagent`, the parent receives only the child's final assistant text (or accumulated partial text) or that consumer's exact stop-reason error, not intermediate messages or tool traffic. A diagnostic-bearing non-completed result presents the safe diagnostic before separately preserved partial assistant output; startup and shutdown errors expose the same fixed facts without raw SDK text.

#### Token effect

Parent input grows only by the final result or error, which is data-dependent and retained until compaction. This provider adds no parent schema itself.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this backend is a poor fit or needs special operational care. They are current package constraints, not a general SDK comparison or a task backlog.

- **A fresh runtime process per run** — no pooling; a harness runtime boots a full plugin tree, so per-run spawn cost is higher than the ACP backend's typical child.
- **No non-route start-time capabilities** — the parent can select the child agent route but cannot enforce `outputSchema`, depth, tool filters, or persona inside the child process; configure the selected child profile and its ordered patches instead.
- **The child's transcript stays in the child's own session root** — the parent log records only the delegation tool call and result; the streamed `session.event` channel is consumed for output extraction, not bridged into the parent log.
- **Local child processes only** — the resolved working directory is a local path; a remote runtime would need its own backend.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the package code.

- **Spawn cost** — the full plugin tree per run is the price of full isolation; pooling would change that trade-off.
- **Remote runtimes** — a remote runtime would need its own backend and workspace mapping.

</details>

**Runtime invariant:** No companion is published. Run lifecycle pairing is owned and checked by the subagent seam's invariant; this backend's own state lives in the child process beyond this context's event streams.
