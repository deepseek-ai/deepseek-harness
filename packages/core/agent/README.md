---
description: "The Agent handle, live registry, process-local initiator scope, and agent/* event vocabulary for plugins, UI, and orchestrators building or extending agents."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent

English | [中文](README.zh.md)

## Summary

Use `dsh-agent` to create or resume live agents, send follow-up or steering input, inject model-facing context, cancel work, and wait for idle completion. Plugins, UI, hooks, and orchestrators can also observe or intercept agent activity and apply capabilities to one agent without affecting others. Choose it when code needs to control or extend live agents through the public `Agent` API. Pair it with an agent driver such as `dsh-agent-loop`; this package does not create model requests by itself. Initiator attribution is process-local and must be carried explicitly across workers, processes, durable queues, and restarts.

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

Mount `dsh-agent` with `dsh-session-projection`: it provides `ctx.agents`, the `Agent` handle, and `turnBoundaryOf(session)` for recorded turn and step positions. Creating or resuming an Agent also requires a driver to register a factory; the shipped driver is `dsh-agent-loop`. [Session model selection](#model-selection) is available on each handle as `agent.model`.

### Create or resume an agent

`ctx.agents.create()` builds a fresh agent and session under one identity; `ctx.agents.resume()` loads a persisted session and rebuilds the agent on it. Both delegate to the registered factory and return an `AgentHandle` — the only object that can tear that agent down. See [`AgentFactory`](src/index.ts) for publication and failure-cleanup timing. Set `parentAgent` in either operation's options to make the result a runtime child; omit it for a runtime root. `get(id)`, `list()`, and `roots()` find live agents, and `isOwnedBy(id, parent)` tests that exact live relation.

```text
const handle = await ctx.agents.create({
  sessionId,
  agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
})
// later:
await handle.dispose()   // stops the loop, unregisters, removes the session, unwinds the scope
```

`AgentOptions` supplies the initial provider/model route, optional adapter-owned `reasoningEffort`, and optional positive `maxTokens` output cap. The loop validates exact-model reasoning support, resolves adapter defaults, records the effective values in the request header, and applies them to each conversation request. An optional `setup(agentCtx, agent)` callback composes the agent's scoped world before it is published: `agentCtx` owns registrations, while the explicit unpublished Agent provides its Session; the Context has no reverse Agent property. Scoped tools, prompt sections, and listeners exist before `agent/created`. Setup is composition-only: drive the agent only after creation resolves. The Session has entered its store and completed `session/created` before setup, so initialization events follow the live event feed.

<a id="model-selection"></a>
### Select a model

`agent.model` implements `Model`, alongside `agent.inbox`. `current()` returns a detached selection: the pending choice, then the latest request's choice, then live `agent.options`; it returns `undefined` when no source supplies both provider and model. Reading does not pin a choice or change a prepared step.

`select({ provider, model, reasoningEffort? })` assigns the complete choice for the next step whose preparation has not begun. Omitted effort uses adapter defaults; selection neither inherits old effort nor queries defaults. An equal recorded choice is a no-op, but a choice equal only to initial options is recorded as `model/selection`. Callers validate availability and capabilities; append failures retain the Session's existing guarantees.

Ordinary resume keeps the recorded choice. An entry point explicitly overriding the model first builds a complete selection, retaining the previous explicit effort only when the configured route is unchanged and omits effort, then calls `select()`. Web and ACP user selections call `select()` directly, so omitted effort means Auto. Selecting a Session model does not change deployment defaults.

For scoped switch notices, call `installModelSelection(agentCtx)` from `dsh-agent` during Agent setup. The scope owns the listener and removes it on disposal.

### Drive an agent's conversation

The handle's methods route identified user-role messages into the agent's inbox. `followup()` queues an ordinary next-turn prompt and wakes the driver; `steer()` submits next-step input and wakes it; `inject()` adds model-facing context without waking the driver, so it lands in the next admitted step. `cancel(cause)` aborts the active activity and, unless `keepInbox` is set, clears pending work; `whenIdle()` resolves after the whole agent reaches quiescence.

```text
handle.agent.followup({
  content: [{ type: 'text', text: 'Summarize this workspace.' }],
  source: { kind: 'user' },
})
handle.agent.steer({
  content: [{ type: 'text', text: 'Focus on the tests.' }],
  source: { kind: 'my-plugin' },
})
await handle.agent.whenIdle()
```

### Scope registrations to one agent

`Agent.ctx` is the agent's scoped context: registrations made through it (tools, prompt sections, variables, event listeners, restrictions) apply to that agent alone and unwind on disposal. The same mechanism is what agent presets use to give one session a different capability set without affecting its neighbors.

### Intercept or observe work in flight

`agent/request` is deprecated and retained for existing listeners. Do not add new listeners. Provider, model, and optional explicit reasoning effort are fixed at step preparation; listeners must preserve all three, including an absent effort. `AgentOptions.maxTokens` sets the output cap. Other per-request control overrides have no replacement API. See the [migration guide](../../../docs/upgrade-guide/v0.2.1-alpha.4/session-model-selection/guide.md) for affected callers.

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

`PreStepDecision` is either `{ kind: 'reject' }` or `{ kind: 'enter', messages, startsRequestSeries? }`. The enter branch contains the complete identified, frozen message batch. Acceptance does not commit it: after assembly and `step/start`, the deprecated `agent/request` hook adjusts controls without changing the step's model selection, and `prepareCall()` binds the adapter before the loop commits the system prompt and user batch. Cancellation during either async phase commits neither. `startsRequestSeries: true` declares a distinct model-message series; a wrapping listener preserves that declaration and the batch unless it intentionally replaces either one. Claiming removes offered messages from the inbox, while messages inserted after the claim remain pending for a later boundary.

### Durable inbox

`Agent.inbox` exposes only the structural `Inbox` interface and the projection vocabulary stays in this package. dsh-agent-loop owns the package-internal `ReactLoopInbox` and the standard `inbox` projection; the loop service acquires one registration for the durable `agent/inbox/spliced` fold and gives each inbox a state-reading callback. The registry remains the sole owner of the live `{ 'next-turn', 'next-step' }` state. Reconstruction rejects unsafe or out-of-range splice coordinates and duplicate `MessageId` values across both pending lists and reports the offending event seq.

`Inbox` exposes pending `nextTurn` and `nextStep` messages and mutates them through `append`, `prepend`, `replace`, `remove`, `clear`, and `splice`. Ordinary removals and `clear()` are durable cancellations. At a step boundary, the loop's internal implementation claims pending input through pure deletion splices. Live notifications are deliberately per-message and minimal: `agent/inbox/inserted { message }`, `agent/inbox/claimed { message, turn }`, and `agent/inbox/discarded { message }`.

### Durable model selection

`Model` and the `modelSelection` projection types live here. The default driver creates each `AgentModel` and owns projection registration alongside its inbox. Each instance binds the Session, live options, and a projection reader; it holds no second copy of the choice. The loop captures a detached selection before step preparation and retains it across retries.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `AgentRegistry`, factory slot, initiator scope, `CreateAgentOptions`/`ResumeAgentOptions` |
| [`src/runtime-types.ts`](src/runtime-types.ts) | `Agent`, structural `Inbox`, `AgentStatus`, and the `agent/*` event declarations |
| [`src/types.ts`](src/types.ts) | `AgentOptions`, cancellation causes, and inbox projection vocabulary |
| [`src/dispatch.ts`](src/dispatch.ts) | `agentEvents` fused dispatcher and `assembleContextFor(agent)` |
| [`src/model-selection.ts`](src/model-selection.ts) | `AgentModel`, its durable projection, and `installModelSelection` switch notices |
| [`src/consumed-work.ts`](src/consumed-work.ts) | `foldConsumedWork(events)`: what the log's consumed work became |
| [`src/archive-admission.ts`](src/archive-admission.ts) | The `turn` family of the Workspace registry's archive admission: a running turn and its user-cause cancel |

### Registry and lifecycle

`AgentRegistry` keeps one entry per live agent with its carrier and creator relation. Await `register()` to finish serial creation listeners with source `startup` before using an already-constructed agent; the async factory uses the split `enter()`/`announce()` pair so setup and initialization stay rollback-covered. A detach requested during creation waits for every awaited listener to settle, and each detach is bound to the exact entry, so a stale disposer cannot remove a later same-id replacement. Teardown stops and drains the loop, unwinds the scope, detaches the agent, then detaches the session; the id becomes reusable after private cleanup.

The registry also answers the Workspace registry's archive admission ([seam](../../workspace/workspace/README.md)) for every Agent it publishes: `workspace/session-activity` reports the `turn` family while the Session's Agent is running, a turn waiting for an approval or an answer included, and `workspace/session-stop` cancels that turn the way the user's own stop does — `agent.cancel({ kind: 'user' })`, but without the stop button's `keepInbox`, so queued input is discarded with a logged inbox splice instead of waking the archived Session later. Nothing is awaited to settlement; a Session without a live Agent has no turn that could run. The `turn` key is merged into `SessionActivityKindMap` from [`src/types.ts`](src/types.ts), so a Client that renders the families imports `@deepseek-ai/dsh-agent/types` for it.

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

`followup`, `steer`, and `inject` feed the owning session as identified user-role messages; accepted content becomes part of the derived history the model reads on later steps. `agent/pre-step` and the other declared events let plugins reject a proposed step or add durable request material. The optional scoped model-switch listener adds the notice described below.

#### Token effect

Accepted content becomes retained history or a repeated session prefix; blocked content contributes no request tokens. Size is caller- and plugin-dependent.

#### KV Cache effect

Accepted history and steering are append-only; a blocked submission sends no request. A session prefix remains stable within its loop instance, while a new or resumed instance may establish a different prefix.

### Agent-scoped request composition

#### What the model sees

Registrations through `agent.ctx` can shadow prompt sections or tools and can install agent-only interceptors during unpublished setup, so one agent sees a different prompt and tool set than its neighbors. Model selection captures one provider/model/effort value before prompt assembly and applies it to the same step's request and retries; a later concurrent change waits for another step.

#### Token effect

Scoped contributions affect only that agent and disappear on disposal.

#### KV Cache effect

Setup or reload that changes prompt sections, tool definitions, or request listeners may invalidate reuse from the first affected request token.

### Optional model-switch notice

#### What the model sees

The scoped listener appends `[model changed: assistant turns above this point were generated by <previous>; the session continues with <next>]` when an accepted step's fixed route differs from the last request. Labels include providers only for cross-provider switches. Initial requests, effort-only changes, rejected steps, and empty no-request decisions add nothing. Failure before header persistence causes the next request step to repeat the notice.

#### Token effect

Each admitted notice adds retained user-message text; selection events themselves add no prompt text.

#### KV Cache effect

Notices append without replacing earlier history. Switching models may prevent reuse of the previous model's cache; cache availability is provider-owned.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this package needs special care. They are current package constraints, not a task backlog.

- **Initiator scope is process-local** — workers, child processes, HTTP, durable queues, and restarts must materialize any required identity explicitly.
- **Ambient identity may outlive liveness** — consumers still check `agent.status`, cancellation, and the owning capability contract before lifecycle-sensitive work.
- **Creation listeners share the initialization lifetime.** An `agent/created` listener must not await `agent.whenIdle()` or its own owner's disposal: those operations wait for creation to finish. Return only after required asynchronous tool and prompt installation completes.
- **`cancel()` clears the inbox by default** — it aborts the in-flight turn plus queued and steering work; `cancel(cause, { keepInbox: true })` aborts only the turn and preserves pending items, and there is no step-only abort that keeps the turn running.
- **Each additional `UserMessage` carries exactly one `MessageSource`** — contributions from several plugins merged onto one message collapse under one source, so the message cannot name several producers.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. Open, undecided directions: inter-agent channels beyond delegation — shared state, streaming child output, and background or poll semantics remain outside the current delegation seam; and the `SessionStartSource` values `'clear'`/`'compact'` are reserved with no emitter yet, pending the driving subsystems.

</details>
