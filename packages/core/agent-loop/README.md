---
description: "The default agent driver for users and maintainers choosing, configuring, or debugging how agents are created and how turns and steps run."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-loop

English | [中文](README.zh.md)

## Summary

`dsh-agent-loop` creates agents — fresh or resumed from persisted history — and runs the turn and step lifecycle that claims prompts, assembles requests, streams model responses, dispatches tool calls, and appends every result back to the session log. As the default driver it implements the `Agent` interface from `dsh-agent` and registers its factory there, so plugins create and drive agents through `ctx.agents` without depending on this package. Declarative config entries start agents automatically at boot, and `maxParallelToolCalls` caps how many parallel-safe tool calls run at once. It is the harness's only concrete loop — everything beyond "call the model, run the tools, repeat" belongs to plugins listening on the event taxonomy. Choose it as the driver for standard compositions; swap it by implementing `Agent` and registering through `ctx.agents`.

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

Mount `dsh-agent-loop` in any composition that should run agents. It supplies the driver behind `ctx.agents` and starts any agents you declare in its config; both [`dsh-base`](../../bundle/base/README.md) and [`dsh-sdk-minimal`](../../bundle/sdk-minimal/README.md) mount it as an explicit row.

### Configure declarative agents

Agents declared in the config start automatically when the plugin loads. Each entry needs an `id` label; a model call additionally requires both `provider` and `model` (`agent/request` may supply a missing pair before dispatch).

```yaml
- name: '@deepseek-ai/dsh-agent-loop'
  config:
    maxParallelToolCalls: 10
    agents:
      - id: 'main'
        provider: deepseek
        model: deepseek-chat
        reasoningEffort: high
        cwd: /workspace
```

| Field | Default | Meaning |
|---|---|---|
| `maxParallelToolCalls` | `10` | Parallel-safe tool calls in flight per step; `1` is serial |
| `agents[].id` | required | Stable label; a fresh session mints `${id}-session-<uuid>` unless `sessionId` is set |
| `agents[].provider` / `agents[].model` | — | Model route; both required before dispatch |
| `agents[].reasoningEffort` | — | Non-empty initial reasoning effort; `agent/request` may override it |
| `agents[].maxTokens` | — | Positive per-request output-token cap |
| `agents[].cwd` | — | Workspace directory for a fresh session |
| `agents[].sessionId` | — | Exact identity: first use creates, a remount resumes materialized history |
| `agents[].resumeSessionId` | — | Load this persisted session instead of creating one; mutually exclusive with `sessionId` |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-agent-loop) is the exhaustive source for every accepted field. The adapter validates the effective reasoning effort and the loop records it in the request header. `maxParallelToolCalls` is also the whole `agent-loop` settings section, so a user layer over this entry caps the next tool group without a restart.

### Create or resume agents programmatically

Plugins and hosts create agents through `ctx.agents.create()` and resume persisted sessions through `ctx.agents.resume()`; both return an `AgentHandle` whose `dispose()` owns exact teardown. The loop runs each created agent to completion — the handle is only needed when the caller must tear the agent down itself.

```text
const handle = await ctx.agents.create({
  sessionId,
  agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
  setup: (agentCtx) => { /* scoped tools, prompt sections, listeners */ },
})
```

### What a step does

Each step sends the agent's rendered system prompt, its visible tool schemas, and the session's derived history; the model's tool calls run through the guarded tool pipeline and every accepted fact is appended to the session log before the next step derives from it. Parallel-safe calls may overlap up to `maxParallelToolCalls`; exclusive calls run alone as ordering barriers. Cancellation is cooperative: `agent.cancel()` aborts the current activity and, unless `keepInbox` is set, clears pending work; a cancelled stream finalizes the text already delivered to the user.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the package realizes the behavior above; the observable contract is covered in [Use this package](#use-this-package).

### Design concept

The package is the one concrete implementation of the public `Agent` contract. It registers itself as the `AgentFactory` on `ctx.agents`, so consumers never import this package; ownership of each created agent lives with the caller fiber and the loop provider, converging on one memoized quiescence boundary. Every observable effect happens through session events and the `agent/*` taxonomy — package internals are never part of the public surface.

### Request headers and adapter defaults

After `agent/request`, `ctx.llm.prepareCall()` validates adapter-owned fields and resolves reasoning-effort and output-token defaults under the active turn signal. The loop retains that exact adapter through resolution, `request/header` logging, and dispatch. It writes a full header for the first request, a changed envelope, an explicit message-series start, a request after surface replacement, and resume; unchanged steps, retries, and ordinary later turns in the same series inherit the latest header. Before the next waterfall, the loop removes adapter-default fields so the current route resolves them again, while explicit settings persist. An unhandled route still fails with `NO_ADAPTER`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `AgentLoop` service, config schema, declarative agent startup, factory registration |
| [`src/agent.ts`](src/agent.ts) | The concrete `ReactLoopAgent` driver: inbox, turn/step machine, cancellation |
| [`src/tool-calls.ts`](src/tool-calls.ts) | Tool scheduling: exclusive barriers and the bounded parallel pool |
| [`src/runtime-context.ts`](src/runtime-context.ts) | Per-step runtime-context snapshot handling |
| [`src/constants.ts`](src/constants.ts) | `DEFAULT_MAX_PARALLEL_TOOL_CALLS` |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: request reconstruction from the session log |

### Creation and teardown

Creation is one rollback-covered transaction: construct a private session, concrete agent, and scoped context; await optional setup; enter both registries; announce `session/created` then `agent/created`; emit `agent/session-start`; only then start the driver. A setup throw, commit failure, or owner disposal rolls the transaction back without publishing either id. Teardown runs stop-and-drain, closes the session's write path, unwinds the scope, detaches the agent, then detaches the session, and every detach is bound to the exact entered object so a stale disposer cannot remove a later same-id replacement.

### Persistence integration

The loop is the production acquisition point for session write handles. When `ctx.sessionPersistence` is mounted, `create`/`createAgent` call `persistence.create(header)` — storing the durable identity and taking write ownership before publication — and append the constructor seed through the handle; `resume` calls `persistence.open(id, 'write')` first (excluding a concurrent resume of the same id), reads the physically valid log through the handle, and appends `interruptedTurnClosers` for a log crashed mid-turn as an ordinary batch — semantic crash repair is the agent layer's job, not a storage entry point. Immediately before publication, `appendUnstoredSuffix` stores any events appended during the setup window (seed markers, delegation policy records), which never re-emit through `session/event`. Once published, the mounted backend routes the session's `session/event` batches, `session/flush` barriers, and `session/disposed` retirement into the active write handle by session id; the loop touches storage only through the handle it owns. The memoized teardown closes the handle — close drains any routed buffer — after the loop commits the session's closing events, provably releasing write ownership. Without a backend, sessions are memory-only and nothing else changes.

### Turn and step flow

The driver owns one agent for its lifetime and runs inside `ctx.agents.withInitiator(agent, ...)`. At a turn boundary it opens the durable turn, then atomically claims pending next-step input plus one queued prompt; between steps it claims only next-step input. `agent/pre-step` decides what enters the step. An entered decision appends its complete `user/message` batch before the driver can claim again, while a rejected decision appends none. Each successful model call appends one `assistant/message` anchor citing its chunk seqs, and a cancelled stream appends an `interrupted: true` anchor with the delivered prefix so the next request contains what the user saw. Within a step, exclusive calls form barriers and parallel-safe calls use the bounded rolling pool; policy, durable results, and result context remain model-ordered.

### Failure and cancellation

Final adapter selection, dispatch, and iteration failures arrive as terminal finishes and enter `agent/request-error`; a handling listener returns `{ kind: 'retry' }` without calling `next()`, while an unhandled failure is terminal. Middleware, result-processing, tool, and other extension failures remain thrown and close the turn directly — plugin failure ends the turn, not the loop. Undispatched model tool calls after cancellation receive synthetic `tool/call` plus `ABORTED_BEFORE_DISPATCH` result pairs. The [explicit-cancellation decision](../../../.agents/notes/implemented/architecture/2026-07-16-explicit-turn-cancellation.md) owns the signal lifecycle.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The package-level contract is enough for most consumers; read these when you need the surrounding domain and the design rationale.

- [agent package](../agent/README.md) — the `Agent` handle, registry, and `agent/*` events this loop implements.
- [Core subsystem](../../../docs/subsystems/core.md) — the turn flow and interception decisions.
- [Session subsystem](../../../docs/subsystems/session.md) — the durable log the loop writes and derives from.
- [Tools subsystem](../../../docs/subsystems/tools.md) — the pipeline the loop dispatches through.
- [Explicit-cancellation Agent Note](../../../.agents/notes/implemented/architecture/2026-07-16-explicit-turn-cancellation.md) — signal lifetime and cancellation races.
- [Core group map](../README.md) — how the core packages compose.

-----

<a id="model-experience"></a>
## Model Experience

### Complete conversation request

#### What the model sees

For each step, the loop sends the rendered per-agent system prompt, the visible tool schemas, and the session's derived messages. It supplies `provider`, `model`, and `cwd` variable values but no additional fixed prose.

#### Token effect

System text and schemas are paid again on every step. Per-agent scoping chooses the contributions, while the authoritative assembly waterfall can alter the final request and makes its listener responsible for protocol coherence.

#### KV Cache effect

Append-only only while system text, schemas, and earlier history remain byte-identical under the same provider and model route. A token-bearing assembly rewrite or composition change may invalidate reuse from the first altered request token.

### Retained message history

#### What the model sees

Accepted user messages, assistant messages, tool calls and results, injected context, and steering are logged and sent on later steps. Raw stream chunks, lifecycle boundaries, and other log-only events are excluded.

#### Token effect

Input grows with every surface message until a compaction replacement shadows older nodes; a multi-step tool turn resends the accumulated history each step.

#### KV Cache effect

Ordinary history growth is append-only and preserves reusable entries. A surface replacement or compaction invalidates reuse from the first shadowed history token.

### Undispatched calls after cancellation

#### What the model sees

If a later request replays an aborted step, each tool call that cancellation prevented from dispatching has error code `ABORTED_BEFORE_DISPATCH` and result text `Error: tool call aborted before dispatch`.

#### Token effect

One fixed error result per skipped call remains in history until compaction shadows it.

#### KV Cache effect

Append-only; each synthetic result follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the loop needs special care. They are current package constraints, not a task backlog.

- **Classification is unary** — calls whose safety depends on comparing siblings or resources must remain exclusive ([rationale](../../../.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md)).
- **Config labels are fresh by default** — omitting `sessionId` creates a fresh `${id}-session-<uuid>` on every startup; exact resume-or-create behavior requires an explicit stable `sessionId`, while `resumeSessionId` requires existing persisted history.
- **Config agents have no per-agent persona field or setup hook** — they use the deployment persona; scoped persona and tool composition are available only through the programmatic `ctx.agents.create()` / `resume()` factory options.
- **No built-in turn budget** — tool calls or steering continue the current turn; a policy that bounds runaway turns must cancel from an existing lifecycle extension point such as `agent/turn-stopping`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
