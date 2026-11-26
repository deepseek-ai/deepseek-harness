---
description: "The default agent driver for users and maintainers choosing, configuring, or debugging how agents are created and how turns and steps run."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-loop

English | [中文](README.zh.md)

## Summary

`dsh-agent-loop` creates fresh agents or resumes persisted sessions, then drives each turn through model requests, streamed responses, tool execution, and durable session history. Mount it for standard agent compositions; declarative entries start agents at boot, while the public `ctx.agents` API supports programmatic creation and resume. The Agent's selected root tool registry owns dispatch, concurrency, cancellation, and tool logging. Cancellation preserves streamed text already delivered to the user. Choose a custom `Agent` implementation only when the standard "call model, run tools, repeat" lifecycle is insufficient.

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

Agents declared in config start automatically when the plugin loads. Each entry needs an `id` label; a model step also needs both `provider` and `model` in the Session selection or initial options before prompt assembly.

```yaml
- name: '@deepseek-ai/dsh-agent-loop'
  config:
    agents:
      - id: 'main'
        provider: deepseek
        model: deepseek-chat
        reasoningEffort: high
        cwd: /workspace
```

| Field | Default | Meaning |
|---|---|---|
| `agents[].id` | required | Stable label; a fresh session mints `${id}-session-<uuid>` unless `sessionId` is set |
| `agents[].provider` / `agents[].model` | — | Model route; both required before step preparation |
| `agents[].reasoningEffort` | — | Non-empty initial reasoning effort; later choices are recorded in the Session |
| `agents[].maxTokens` | — | Positive per-request output-token cap |
| `agents[].cwd` | — | Workspace directory for a fresh session |
| `agents[].sessionId` | — | Exact identity: first use creates, a remount resumes materialized history |
| `agents[].resumeSessionId` | — | Load this persisted session instead of creating one; mutually exclusive with `sessionId` |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-agent-loop) lists every accepted field. `maxParallelToolCalls` remains a volatile positive-integer Config field with default `10`; `1` selects serial execution. The loop passes its current value to each batch's `execute()` call, taking precedence over the root registry's own limit. Live edits apply to the next batch; `agents` remains startup configuration.

A configured resume records the declared route as the Session selection before publication. Programmatic resume preserves the Session choice unless its setup explicitly records another route; initial `agentOptions` alone do not override saved history.

### Create or resume agents programmatically

Plugins and hosts create agents through `ctx.agents.create()` and resume persisted sessions through `ctx.agents.resume()`; both return an `AgentHandle` whose `dispose()` owns exact teardown. The loop runs each created agent to completion — the handle is only needed when the caller must tear the agent down itself.

```text
const handle = await ctx.agents.create({
  sessionId,
  agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
  setup: (agentCtx, agent) => { /* scoped registrations plus explicit unpublished Agent */ },
})
```

Every inbox mutation commits one normalized `agent/inbox/spliced` event. The projection registry folds that event synchronously, so the live projection reflects the splice when `Session.append()` returns. Insertions, edits, removals, claiming, and cancellation replay through the same standard splice coordinates. Ordinary removals carry `outcome: 'canceled'` and emit `agent/inbox/discarded { message }`; claiming uses pure deletions with no outcome and emits `agent/inbox/claimed`. Every insertion emits `agent/inbox/inserted { message }`. `MessageId` stays unique across both pending lists. Consumers that need a removed message use the claimed or discarded notification instead of depending on a pre-splice `session/event` view.

### What a step does

Each step sends derived Session history and its visible tool schemas. System messages contain the initial instructions and subsequent section updates. Tool calls run through the guarded pipeline, and every model-visible fact is logged before the request is derived. The loop passes the complete raw call batch to `ctx.tools.execute()`; built-in root registries preserve model-order results and exclusive barriers. Cancellation aborts current activity and, unless `keepInbox` is set, clears pending work; an interrupted stream finalizes the text already delivered.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the package realizes the behavior above; the observable contract is covered in [Use this package](#use-this-package).

### Design concept

The package is the one concrete implementation of the public `Agent` contract. It registers itself as the `AgentFactory` on `ctx.agents`, so consumers never import this package; ownership of each created agent lives with the caller fiber and the loop provider, converging on one memoized quiescence boundary. Every observable effect happens through session events and the `agent/*` taxonomy — package internals are never part of the public surface.

### Request headers and adapter defaults

Before prompt assembly, the loop calls `agent.model.current()` and captures provider, model, and optional explicit reasoning effort for the step and its retries. `AssembleContext.modelSelection` and `agent/pre-step.modelSelection` carry that selection; prompt variables use its route, and omitted effort uses adapter defaults. The deprecated `agent/request` hook remains available to existing listeners and may replace other controls such as sampling. Changing provider or model, or adding, changing, or clearing reasoning effort rejects the step before input is committed. A later recorded choice applies to the next step, including a tool continuation in the same turn.

After `agent/request`, `ctx.llm.prepareCall()` validates adapter-owned fields and resolves reasoning-effort and output-token defaults under the active turn signal. The loop retains that exact adapter through resolution, `request/header` logging, and dispatch. It writes a full header for the first request, a changed envelope (config or tools — the prompt is not part of the header), an explicit message-series start, a request after a surface replacement or image-offload decision, and resume; unchanged steps, retries, and ordinary later turns in the same series inherit the latest header, and an in-history prompt append is not a replacement, so the request that follows it inherits the header too. Beside the header, the loop logs `request/context` — provider, model, `contextWindow`, and the route's `systemPromptUpdate` mode from `prepareCall()` — only when one of those differs from the latest snapshot. Before the next waterfall, the loop removes adapter-default fields so the current route resolves them again, while explicit settings persist. An unhandled route still fails with `NO_ADAPTER`.

The loop deep-freezes each derived message identity on its first request and reuses that proof only within the same agent. Restored messages keep their identity; request construction does not freeze their containing event wrappers. Each request freezes its local canonical header, fresh message array, and envelope while leaving the cancellation signal live. The [archived request-freeze decision](../../../.agents/notes/archived/simplification/2026-09-06-agent-request-freeze-evidence.md) explains ownership and measurement.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `AgentLoop` service, config schema, declarative agent startup, factory registration |
| [`src/agent.ts`](src/agent.ts) | The concrete `ReactLoopAgent` driver: inbox, turn/step machine, cancellation |
| [`src/inbox.ts`](src/inbox.ts) | `ReactLoopInbox` and the shared projection for queues and claim settlement |
| [`src/runtime-context.ts`](src/runtime-context.ts) | Per-step runtime-context snapshot handling |

### Creation and teardown

Fork creation prepares the caller's `seed` exactly like direct replay and does not open or flush the parent; `parentSource` only names the parent and the cut. A backend that shares the stored prefix drains the parent writer itself before referencing it.

Fresh creation and resume share one rollback-covered initialization: construct the concrete agent and scoped context around the acquired Session; store constructor history, enter the SessionStore, and complete `session/created`; await optional setup and its commit; enter the AgentRegistry; await serial `agent/created` listeners; then release queued input. The caller Context owns the transaction and live handle; delegation services bind their runtime relationships during setup. Setup, commit, or listener failure and owner disposal roll back the prepared resources. The Session is writable during setup, and every removal emits `session/disposed`, including setup failure before Agent creation is announced. Failed initialization preserves restored inbox input and any events already stored; it rejects only after releasing its scope and acquired write handle. Cancellation while persistence is still creating a write handle can reject earlier; that handle closes when creation settles. Announcements already delivered remain observable and receive matching disposal notifications. Teardown stops and drains the driver, unwinds the scope, closes the session's write path, detaches the agent, then detaches the session. Every detach binds the exact entered object, so a stale disposer cannot remove a later same-id replacement.

The loop awaits its required registrations before publishing its factory. It calls `readerFor(session)` on its model-selection and inbox handles and passes the callbacks to the driver in one typed object; the model and inbox collaborators receive their respective callbacks. During factory unload, global registrations may disappear before teardown finishes; retained handles remain readable through scope cleanup, including cancellation from scoped abort listeners. Caller unload, factory unload, and handle disposal await the same teardown. Queue-clear errors do not skip cancellation or the wait for admitted work, and resources remain available until that work settles.

### Persistence integration

The loop is the production acquisition point for Session write handles. Fresh creation stores constructor history through the acquired handle; fork creation passes the parent reference, the cut, and the constructed log to `persistence.create()`, which stores that history before returning. SQLite owns prefix sharing, parent draining, and Segment creation; JSONL copies the log. Setup then appends through the live event feed. Resume acquires a write handle before reading history and appends interrupted-tail repair as ordinary events. The backend routes published Session events, flush barriers, and retirement into the active handle. Teardown closes the handle after the driver commits its closing events; close drains the routed buffer and releases ownership. Without a backend, Sessions are memory-only.

### Turn and step flow

The driver owns one agent for its lifetime and runs inside `ctx.agents.withInitiator(agent, ...)`. `AgentLoop` registers the standard `inbox` projection for its service lifetime, so cold reads work before any Agent exists and after all Agents unload. It also owns `modelSelection` and constructs an `AgentModel` for each Agent, with the public [Model API](../agent/README.md#model-selection). Its package-internal `ReactLoopInbox` uses that shared projection for structural commands and loop-only claims. At a turn boundary it opens the durable turn, then atomically claims pending next-step input plus one queued prompt; between steps it claims only next-step input. The driver captures the selected root's entries as the step's `ToolStep`, assembles the prompt with that step, and runs `agent/pre-step`; the fallback projects runtime context after listeners run. A rejected decision or empty first batch opens no step. On the first attempt after acceptance, `step/start` precedes the `agent/request` waterfall and `prepareCall()`; neither async phase sees the pending system prompt or accepted users committed to history, and cancellation during either commits neither. Every attempt refreshes registered runtime facts and retains the step’s `ToolStep` and model selection. The first attempt appends the writes returned by the assembly’s `systemUpdates()` and commits the accepted `user/message` batch, with its owned context candidate replaced in place. The loop restores removed runtime context, logs the header and context as needed, and derives and freezes the request before streaming through that bound prepared call. Retries reuse committed history without capturing tools again or repeating assembly, `agent/pre-step`, or user admission. After a logged compaction summary, the next attempt, including a retry, appends the rebuild that `systemUpdates()` returns from the same captured sections. Source changes after assembly wait for the next assembly. The request is `header.config`, `deriveMessages()`, and `header.tools`; it carries no `system` field. Each model attempt emits one process-local `start`, emits every `chunk` only after the matching durable assistant-frame settlement, and emits exactly one terminal `end`; final assembly or message-append failure settles it as `aborted`, while `committed` follows the durable `assistant/message`. Each successful model call appends one message anchor, and a cancelled stream appends an `interrupted: true` anchor with the delivered prefix so the next request contains what the user saw. Within a step, exclusive calls form barriers and parallel-safe calls use the bounded rolling pool; policy, durable results, and result context remain model-ordered.

System-prompt assembly belongs to the system service. It captures source text and lifecycle; the assembly’s `systemUpdates()` compares them with the Session’s committed admissions when called. The loop appends the returned writes before newly accepted users on the first attempt. The initial commitment includes a system head even without instructions; an empty head stays logged but is omitted from derived model messages. Rejection or cancellation before commitment writes no head. After compaction, the next accepted model attempt clears retained system additions and then replaces the initial system node with the full prompt from its assembly. These ordinary `system/message` replacements belong to that open step. The head reset completes the pending rebuild; rejection or cancellation before it leaves rebuilding pending across restart. Idle compaction therefore leaves the retained system display unchanged until another model attempt. The [system-prompt package](../system-prompt/README.md) owns contributor and admission semantics.

The runtime-context projection compares the ordered names and text in committed `source.sections`, independently of reminder wording. Uncommitted proposals do not advance its state. Closing `system-reminder` tags, including case and trailing-whitespace variants, are escaped in message text while recorded sections retain their original text; this framing is a formatting convention, not a security boundary.

### Failure and cancellation

`turn/end` declares `TurnEndCancelCause`; cancellation records a fresh `AgentCancelCause` there, retaining the caller's `kind` and the hook's `reason` text. The live `AbortSignal.reason` remains the caller's object, which a transport may extend — Node's fetch assigns a `stack` onto it — so the copy keeps that trace out of the log and keeps the ending appendable.

Final adapter selection, dispatch, and iteration failures arrive as terminal finishes and enter `agent/request-error`; a handling listener returns `{ kind: 'retry' }` without calling `next()`, while an unhandled failure is terminal. Middleware, result-processing, tool, and other extension failures remain thrown and close the turn directly — plugin failure ends the turn, not the loop. Undispatched model tool calls after cancellation receive synthetic `tool/call` plus `ABORTED_BEFORE_DISPATCH` result pairs.

<a id="returned-input"></a>

The `inbox` projection derives queues and claims from the same splices. The Host checkpoint stores the queues and claims for unopened steps. Those claims come from the current turn or from the most recent closed turn if it ended as interrupted. The client view exposes the queues.

If a turn ends before `step/start` because of a failure or a Stop that keeps the queue, the inbox returns the entire claimed batch to the head of next-turn in claim order before the loop records `turn/end`; the inbox decides from its own `clear()` and `claim()` calls, and the loop keeps no return state. Returned input waits for a normal wake. Starting the step, finishing or blocking the turn, or clearing the queue settles the claims. When a Session resumes after an interrupted turn, the inbox restores claims for an unopened step before `agent/created`; a fork keeps its parent's queue but never restores a claim the parent's turn left unopened. A message that fails before step start on every wake stays at the queue head until its cause is fixed or its owner removes it.

If the Goal driver rejects a returned round at the queue head, that wake ends with the remaining input still queued.

Before closing a failed step, the driver records an error result for each unanswered assistant tool call. A recorded `tool/call` without a committed result receives `TOOL_OUTCOME_UNKNOWN`; a request without a call record receives `TOOL_NOT_STARTED`. Committed results remain intact, started dispatches settle before recovery, and the turn retains the original failure. These results let later requests use paired tool history without automatically retrying uncertain operations.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The package-level contract is enough for most consumers; read these when you need the surrounding domain and the design rationale.

- [agent package](../agent/README.md) — the `Agent` handle, registry, and `agent/*` events this loop implements.
- [Core subsystem](../../../docs/subsystems/core.md) — the turn flow and interception decisions.
- [Session subsystem](../../../docs/subsystems/session.md) — the durable log the loop writes and derives from.
- [Tools subsystem](../../../docs/subsystems/tools.md) — the pipeline the loop dispatches through.
- [Core group map](../README.md) — how the core packages compose.

-----

<a id="model-experience"></a>
## Model Experience

### Complete conversation request

#### What the model sees

The model receives derived messages, including initial system instructions and additive section updates, plus visible tool schemas. The loop supplies `provider` and `model` variables; working-directory contributes required user context. Request headers record active tools, and name changes emit a `developer/message` independently of model capability. Requests carry `Session.toolHistory()` for adapter-owned declarations.

#### Token effect

System text and schemas are paid again on every step, and retained system additions remain until the next model attempt after compaction consolidates them at the head. Per-agent scoping chooses contributions, while the assembly waterfall can alter their presentation.

#### KV Cache effect

Changed sections append without rewriting earlier messages. Compaction replaces the selected range with a summary; the next model attempt consolidates current instructions at the head. Adapter serialization determines whether the wire prefix remains identical; native in-history updates and pi-ai reminders preserve it, while a combined top-level system field changes it. Tool declaration changes have their own cache effects.

### Runtime context reminders

#### What the model sees

Runtime context is a `<system-reminder>` user message. Its first snapshot starts with `The following information describes your current session:`; later snapshots start with `The following information describes your current session. It replaces earlier versions of this context, including any retained in conversation summaries.` Unchanged contributions emit nothing; compaction removing the retained snapshot causes a new reminder, including after resume. An empty active set emits `Current runtime context: none. Earlier runtime-context snapshots no longer apply.` inside the same wrapper and records empty sections.

#### Token effect

Each retained reminder adds its wrapper, introduction, and contributions; later snapshots also include the supersession statement. A legacy snapshot or clear marker without `source.sections` is refreshed once on the next admitted request, even when its text already describes the current state.

#### KV Cache effect

Runtime reminders, including a legacy refresh, append after existing messages and preserve that prefix. Structured contributions prevent a wording-only refresh of an unchanged snapshot; compaction itself changes the replaced prefix.

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

Append-only; each synthetic result follows the reusable request prefix and does not invalidate existing KV Cache entries.

### Unanswered calls after step failure

#### What the model sees

Each unanswered tool call receives an error result in later history. For a recorded call, the result states `Its outcome is unknown.` and permits retries only for read-only or idempotent operations; possible side effects require checking external state or asking the user first. A call without a start record states `The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.`

#### Token effect

One recovery result per unanswered call remains in history until compaction shadows it.

#### KV Cache effect

Recovery results append after the existing history and preserve its reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the loop needs special care. They are current package constraints, not a task backlog.

- **Classification is unary** — calls whose safety depends on comparing siblings or resources must remain exclusive ([rationale](../../../.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md)).
- **Root shutdown persistence** — shutting down the root context with an active Agent can leave its final `turn/end` in memory but absent from the persisted log. Agent teardown completing does not guarantee that this event was saved.
- **Previously closed inconsistent history** — failed-step recovery does not rewrite unanswered calls in already-closed historical turns.
- **Config labels are fresh by default** — omitting `sessionId` creates a fresh `${id}-session-<uuid>` on every startup; exact resume-or-create behavior requires an explicit stable `sessionId`, while `resumeSessionId` requires existing persisted history.
- **Config agents have no per-agent persona field or setup hook** — they use the deployment persona; scoped persona and tool composition are available only through the programmatic `ctx.agents.create()` / `resume()` factory options.
- **No built-in turn budget** — tool calls or steering continue the current turn; a policy that bounds runaway turns must cancel from an existing lifecycle extension point such as `agent/turn-stopping`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
