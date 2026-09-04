---
description: "The Agent handle, live registry, process-local initiator scope, and agent/* event vocabulary for plugins, UI, and orchestrators building or extending agents."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent

English | [中文](README.zh.md)

## Summary

With `dsh-agent` you can create or resume an agent, send a follow-up prompt, steer the current step, inject model-facing context, cancel an activity, and wait until the agent is idle — all through the `Agent` handle every plugin programs against and the live registry (`ctx.agents`) that tracks running agents. The package also carries the process-local initiator scope, which attributes asynchronous work to the agent that started it, and declares the `agent/*` event vocabulary plugins use to observe or intercept work in flight. It has zero loop dependency: concrete creation and driving live in `dsh-agent-loop`, which registers its factory here, so the driver stays swappable. Choose this package when you build UI, hooks, orchestrators, or extension plugins that touch live agents; the interface itself runs no model calls.

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

Mount `dsh-agent` wherever live agents exist: it provides `ctx.agents` and the `Agent` handle that plugins, UI, hooks, and orchestrators work against. The service is inert until a driver registers a factory — the shipped driver is `dsh-agent-loop`, so the smallest useful composition loads both.

### Create or resume an agent

`ctx.agents.create()` builds a fresh agent and session under one identity; `ctx.agents.resume()` loads a persisted session and rebuilds the agent on it. Both delegate to the registered factory and return an `AgentHandle` — the only object that can tear that agent down. `get(id)`, `list()`, and `roots()` find live agents, and `isOwnedBy(id, owner)` tells whether one agent was created through another's scoped context.

```text
const handle = await ctx.agents.create({
  sessionId,
  agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
})
// later:
await handle.dispose()   // stops the loop, unregisters, removes the session, unwinds the scope
```

`AgentOptions` supplies the initial provider/model route, optional adapter-owned `reasoningEffort`, and optional positive `maxTokens` output cap. The loop validates exact-model reasoning support, resolves adapter defaults, records the effective values in the request header, and applies them to each conversation request. An optional `setup(agentCtx)` callback composes the agent's scoped world before it is published — scoped tools, prompt sections, and listeners exist before any creation announcement. Setup is composition-only: drive the agent only after creation resolves.

### Drive an agent's conversation

The handle's methods route identified user-role messages into the agent's inbox. `followup()` queues an ordinary next-turn prompt and wakes the driver; `steer()` submits next-step input and wakes it; `inject()` adds model-facing context without waking the driver, so it lands in the next admitted step. `cancel(cause)` aborts the active activity and, unless `keepInbox` is set, clears pending work; `whenIdle()` resolves after the whole agent reaches quiescence.

```text
handle.agent.followup({
  content: [{ type: 'text', text: 'Summarize this workspace.' }],
  source: { kind: 'user' },
})
handle.agent.steer({
  content: [{ type: 'text', text: 'Focus on the tests.' }],
  source: { kind: 'plugin', plugin: 'my-plugin' },
})
await handle.agent.whenIdle()
```

### Scope registrations to one agent

`Agent.ctx` is the agent's scoped context: registrations made through it (tools, prompt sections, variables, event listeners, restrictions) apply to that agent alone and unwind on disposal. The same mechanism is what agent presets use to give one session a different capability set without affecting its neighbors.

### Intercept or observe work in flight

The `agent/*` events let plugins act on live work without depending on the loop package. `agent/pre-step` can reject a proposed step or replace the messages entering it; `agent/request-error` lets a listener retry a failed model request; `agent/turn-stopping` runs before an otherwise completed turn closes and can steer to keep it open. `agent/assistant-stream` carries one process-local Assistant attempt's ordered start, transient chunk, and end frames. Start names the attempt's turn and step, chunk indexes are dense from zero, and `end.index` is the next chunk position. The loop commits the complete compact stream as one `assistant/message` or `assistant/attempt` before a committed end frame, so the live event remains presentation data rather than the replay source. `agent/status`, `agent/created`, and `agent/disposed` drive UI and coordination state, and the per-message `agent/inbox/*` notifications keep inbox projections in sync. Exact signatures, dispatch modes, and payload contracts live in the generated region of the [core subsystem page](../../../docs/subsystems/core.md#cordis-surface).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the package realizes the behavior above; the observable contract is covered in [Use this package](#use-this-package).

### Design concept

The package is built on one separation: the public `Agent` surface and registry live here, while construction and driving live in the loop package behind a registered factory. Consumers therefore depend on `dsh-agent` and never on `dsh-agent-loop`, keeping the driver swappable. The second idea is the initiator scope: an `AsyncLocalStorage` chain that carries the exact live `Agent` through the asynchronous driver work it starts, so helpers below a driver can attribute their work without forwarding the agent through every call.

### Step admission

`PreStepDecision` is either `{ kind: 'reject' }` or `{ kind: 'enter', messages, startsRequestSeries? }`. The enter branch contains the complete identified, frozen message batch. `startsRequestSeries: true` declares a distinct model-message series; a wrapping listener preserves that declaration and the batch unless it intentionally replaces either one. Claiming removes offered messages from the inbox, while messages inserted after the claim remain pending for a later boundary.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `AgentRegistry`, factory slot, initiator scope, `CreateAgentOptions`/`ResumeAgentOptions` |
| [`src/runtime-types.ts`](src/runtime-types.ts) | `Agent`, `AgentStatus`, and the `agent/*` event declarations |
| [`src/types.ts`](src/types.ts) | `AgentOptions`, cancellation causes, and inbox vocabulary |
| [`src/inbox.ts`](src/inbox.ts) | The `Inbox` projection over durable `agent/inbox/spliced` events |
| [`src/dispatch.ts`](src/dispatch.ts) | `agentEvents` fused dispatcher and `assembleContextFor(agent)` |
| [`src/consumed-work.ts`](src/consumed-work.ts) | `foldConsumedWork(events)`: what the log's consumed work became |
| [`src/model-selection.ts`](src/model-selection.ts) | `installModelSelection`: coupling one selection to assembly and routing |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: no-op `agent/status` transitions fail |

### Registry and lifecycle

`AgentRegistry` keeps one entry per live agent with its carrier and creator relation. `register()` records an already-constructed agent; the async factory uses the split `enter()`/`announce()` pair so setup and publication stay rollback-covered. A detach requested during a creation dispatch waits for that dispatch to unwind, and each detach is bound to the exact entry, so a stale disposer cannot remove a later same-id replacement. Teardown order is stop-and-drain the loop, unwind the scope, detach the agent, detach the session; the id becomes reusable after private cleanup.

### Initiator scope

Each driver runs its complete lifetime inside `ctx.agents.withInitiator(agent, ...)`, so inherited async chains observe that agent; `withoutInitiator()` hides it for unrelated process-local work such as shared timers. The boundary is process-local attribution only — ambient presence is neither liveness proof nor authorization, and explicit identity stays authoritative at worker, process, persistence, and wire boundaries. Teardown rejects new boundaries, lets returned-Promise boundaries drain, then disables the underlying storage. The [initiator-scope decision](../../../.agents/notes/implemented/architecture/2026-07-15-agent-initiator-scope.md) owns the detailed contract.

### Ownership invariants

The `AgentHandle` disposer is a capability: among consumers, only its holder can tear the agent down. The registered factory provider is a structural co-owner, because scoped agents depend on that provider's service API; provider unload stops and drains every live handle it made. `ctx.agents.get(id)` still returns a bare `Agent` — the handle is exposed only to the consumer that created it.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The package-level contract is enough for most consumers; read these when you need the surrounding domain and the design rationale.

- [Core subsystem](../../../docs/subsystems/core.md) — the loop map, `Agent` handle, interception decisions, and generated service API.
- [agent-loop package](../agent-loop/README.md) — the default driver that creates, drives, and disposes agents.
- [Session subsystem](../../../docs/subsystems/session.md) — the durable log and derived history behind the handle.
- [Initiator-scope Agent Note](../../../.agents/notes/implemented/architecture/2026-07-15-agent-initiator-scope.md) — the boundary and teardown contract.
- [Core group map](../README.md) — how the core packages compose.

-----

<a id="model-experience"></a>
## Model Experience

### User, steering, and injected messages

#### What the model sees

`followup`, `steer`, and `inject` feed the owning session as identified user-role messages; accepted content becomes part of the derived history the model reads on later steps. `agent/pre-step` and the other declared events let plugins reject a proposed step or add durable request material; this interface contributes no fixed prose itself.

#### Token effect

Accepted content becomes retained history or a repeated session prefix; blocked content contributes no request tokens. Size is caller- and plugin-dependent.

#### KV Cache effect

Accepted history and steering are append-only; a blocked submission sends no request. A session prefix remains stable within its loop instance, while a new or resumed instance may establish a different prefix.

### Agent-scoped request composition

#### What the model sees

Registrations through `agent.ctx` can shadow prompt sections or tools and can install agent-only interceptors during unpublished setup, so one agent sees a different prompt and tool set than its neighbors.

#### Token effect

The package adds zero tokens itself; scoped contributions affect only that agent and disappear on disposal.

#### KV Cache effect

Prefix-stable while an agent's scoped registrations are unchanged. Setup or reload that changes prompt sections, tool definitions, or request listeners may invalidate reuse from the first affected request token.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this package needs special care. They are current package constraints, not a task backlog.

- **Initiator scope is process-local** — workers, child processes, HTTP, durable queues, and restarts must materialize any required identity explicitly.
- **Ambient identity may outlive liveness** — consumers still check `agent.status`, cancellation, and the owning capability contract before lifecycle-sensitive work.
- **`agent/session-start` cannot gate startup** — it remains a synchronous, veto-less notification; async composition that must finish before publication belongs in the factory's `setup(agentCtx)` transaction instead.
- **`cancel()` clears the inbox by default** — it aborts the in-flight turn plus queued and steering work; `cancel(cause, { keepInbox: true })` aborts only the turn and preserves pending items, and there is no step-only abort that keeps the turn running.
- **Each additional `UserMessage` carries exactly one `MessageSource`** — contributions from several plugins merged onto one message collapse under one source, so the message cannot name several producers.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. Open, undecided directions: inter-agent channels beyond delegation — shared state, streaming child output, and background or poll semantics remain outside the current delegation seam; and the `SessionStartSource` values `'clear'`/`'compact'` are reserved with no emitter yet, pending the driving subsystems.

</details>
