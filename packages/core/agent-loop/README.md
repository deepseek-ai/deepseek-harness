---
description: "The default agent driver for users and maintainers choosing, configuring, or debugging how agents are created and how turns and steps run."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-loop

English | [中文](README.zh.md)

## Summary

`dsh-agent-loop` creates fresh agents or resumes persisted sessions, then drives each turn through model requests, streamed responses, tool execution, and durable session history. Mount it for standard agent compositions; declarative entries start agents at boot, while the public `ctx.agents` API supports programmatic creation and resume. The selected tool executor owns dispatch, concurrency, cancellation, and tool logging. Cancellation preserves streamed text already delivered to the user. Choose a custom `Agent` implementation only when the standard "call model, run tools, repeat" lifecycle is insufficient.

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

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-agent-loop) lists every accepted field. `maxParallelToolCalls` remains a volatile positive-integer Config field with default `10`; `1` selects serial execution. The loop passes its current value to each batch's `execute()` call, taking precedence over executor configuration. Live edits apply to the next batch; `agents` remains startup configuration.

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

Each step sends the session's derived history — with the latest non-empty `system/message` node as the effective prompt, or no system messages when the rendered prompt is empty — and its visible tool schemas; the model's tool calls run through the guarded tool pipeline and every accepted fact is appended to the session log before the next step derives from it. The loop passes the complete raw call batch to `ctx.tools.execute()`; built-in executors preserve model-order results and exclusive barriers. Cancellation is cooperative: `agent.cancel()` aborts the current activity and, unless `keepInbox` is set, clears pending work; a cancelled stream finalizes the text already delivered to the user.

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
| [`src/inbox.ts`](src/inbox.ts) | Package-internal `ReactLoopInbox`: durable projection, structural commands, and loop-only claim state |
| [`src/runtime-context.ts`](src/runtime-context.ts) | Per-step runtime-context snapshot handling |

### Creation and teardown

Fresh creation and resume share one rollback-covered initialization: construct the concrete agent and scoped context around the acquired Session; store constructor history, enter the SessionStore, and complete `session/created`; await optional setup and its commit; enter the AgentRegistry; await serial `agent/created` listeners; then release queued input. A caller creating a runtime child sets `options.parentAgent`; the caller Context separately owns the transaction and live handle. Setup, commit, or listener failure and owner disposal roll back the prepared resources. The Session is writable during setup, and every removal emits `session/disposed`, including setup failure before Agent creation is announced. Failed initialization preserves restored inbox input and any events already stored; it rejects only after releasing its scope and acquired write handle. Cancellation while persistence is still creating a write handle can reject earlier; that handle closes when creation settles. Announcements already delivered remain observable and receive matching disposal notifications. Teardown stops and drains the driver, unwinds the scope, closes the session's write path, detaches the agent, then detaches the session. Every detach binds the exact entered object, so a stale disposer cannot remove a later same-id replacement.

The loop awaits inbox and turn-boundary registration before publishing its factory and passes those handles into synchronous Agent construction. During factory unload, global registrations may disappear before teardown finishes; retained handles remain readable through scope cleanup, including cancellation from scoped abort listeners. Caller unload, factory unload, and handle disposal await the same teardown.

### Persistence integration

The loop is the production acquisition point for session write handles. When `ctx.sessionPersistence` is mounted, `create`/`createAgent` call `persistence.create(header)` — storing the durable identity and taking write ownership before publication — and append the constructor seed through the handle; `resume` calls `persistence.open(id, 'write')` first (excluding a concurrent resume of the same id), reads the physically valid log through the handle, and appends `interruptedTurnClosers` for a log crashed mid-turn as an ordinary batch — semantic crash repair is the agent layer's job, not a storage entry point. Before store entry, `appendUnstoredSuffix` stores constructor history, including seed markers. Setup then appends through the live event feed. From store entry onward, the mounted backend routes the session's `session/event` batches, `session/flush` barriers, and `session/disposed` retirement into the active write handle by session id; the loop touches storage only through the handle it owns. With the backend still mounted, teardown closes the handle after the driver commits its closing events; close drains the routed buffer and releases write ownership. Without a backend, sessions are memory-only and nothing else changes.

### Turn and step flow

The driver owns one agent for its lifetime and runs inside `ctx.agents.withInitiator(agent, ...)`. `AgentLoop` registers the standard `inbox` projection for its service lifetime, so cold reads work before any Agent exists and after all Agents unload. It also owns `modelSelection` and constructs an `AgentModel` for each Agent, with the public [Model API](../agent/README.md#model-selection). Its package-internal `ReactLoopInbox` uses that shared projection for structural commands and loop-only claims. At a turn boundary it opens the durable turn, then atomically claims pending next-step input plus one queued prompt; between steps it claims only next-step input. The driver assembles the prompt and tools and runs `agent/pre-step`; the fallback projects runtime context after listeners run. A rejected decision or empty first batch opens no step. On the first attempt after acceptance, `step/start` precedes the `agent/request` waterfall and `prepareCall()`; neither async phase sees the pending system prompt or accepted users committed to history, and cancellation during either commits neither. For every attempt, the loop then synchronously reconciles the rendered prompt against the surviving `system/message` nodes using the prepared call capability, refreshes registered runtime facts without reassembling the bound prompt or tools, appends the accepted `user/message` batch only on the first attempt with its owned context candidate replaced in place, and restores removed runtime context, logs the header and context as needed, and derives and freezes the request before streaming through that bound prepared call. Retries reuse the same rendered assembly without repeating assembly, `agent/pre-step`, or user admission. Reconciliation sees pre-step and retry compaction; a broken series consolidates the prompt at the head rather than appending an update after already-committed users. The request is `header.config`, `deriveMessages()`, and `header.tools`; it carries no `system` field. Each model attempt emits one process-local `start`, emits every `chunk` only after the matching durable assistant-frame settlement, and emits exactly one terminal `end`; final assembly or message-append failure settles it as `aborted`, while `committed` follows the durable `assistant/message`. Each successful model call appends one message anchor, and a cancelled stream appends an `interrupted: true` anchor with the delivered prefix so the next request contains what the user saw. Within a step, exclusive calls form barriers and parallel-safe calls use the bounded rolling pool; policy, durable results... (line truncated to 2000 chars)

Prompt admission uses the actual `prepareCall()` result, not the preceding `request/context`. With no system node, even an empty prompt is appended (reserving node 0 without a wire message). On an incapable route, or at a new request series whose effective text differs, a non-empty rendering is consolidated at the first system node: each non-empty later system node receives a logged per-node empty replacement, then the head is rewritten if needed. Dormant empty tails need no replacement and do not determine the effective text. A series start whose latest surviving node already holds the rendering produces no system event, so the request keeps the prefix it had. On a continuing `in-history` series, an unchanged effective prompt produces no event and a non-empty change appends. An empty rendering clears every non-empty later system node through a logged per-node empty replacement, then empties the head if needed, regardless of route or series state. No older instructions remain model-visible. An empty head with no active later system node means no prompt; repeated clears and resume leave it empty. A restored non-empty prompt follows the same route/series rule: a continuing capable route may append it, while an incapable route or a new series whose effective text differs refills the head. A step starts a series when the pre-step decision declares `startsRequestSeries` or `session.surface.contentGeneration` changed since attachment or the last request (a replacement or image-offload decision). Visible tool-schema changes force prompt consolidation only when the prepared route lacks `toolUpdate`. Routes supporting both tool and system-prompt updates can append a changed prompt and activate added tools without rewriting earlier messages. If another admission condition replaces a system node, the request starts a new series with current tool declarations. Resume and a provider or model swap alone continue the series; the prepared route still governs admission. Per-node empty replacements preserve intervening history without a surface delete operation.

### Failure and cancellation

`turn/end` declares `TurnEndCancelCause`; cancellation records a fresh `AgentCancelCause` there, retaining the caller's `kind` and the hook's `reason` text. The live `AbortSignal.reason` remains the caller's object, which a transport may extend — Node's fetch assigns a `stack` onto it — so the copy keeps that trace out of the log and keeps the ending appendable.

Final adapter selection, dispatch, and iteration failures arrive as terminal finishes and enter `agent/request-error`; a handling listener returns `{ kind: 'retry' }` without calling `next()`, while an unhandled failure is terminal. Middleware, result-processing, tool, and other extension failures remain thrown and close the turn directly — plugin failure ends the turn, not the loop. Undispatched model tool calls after cancellation receive synthetic `tool/call` plus `ABORTED_BEFORE_DISPATCH` result pairs.

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

For each step, the loop sends the session's derived messages and visible tool schemas. Non-empty `system/message` nodes carry the prompt, with the latest as the effective version; an empty rendering clears all prompt versions from derived history. It supplies `provider` and `model` variable values but no additional fixed prose. The working-directory service contributes the active directory as user context. The request header always records active tools. Comparing their names with the preceding header emits one `developer/message` for additions and removals, independently of model capability; additions reference the new header. Requests also carry `Session.toolHistory()` for the LLM runtime to construct provider declarations.

#### Token effect

System text and schemas are paid again on every step, and on an `in-history` route every retained prompt version is paid until compaction shadows it or prompt reconciliation empties it. Per-agent scoping chooses the contributions, while the authoritative assembly waterfall can alter the final request and makes its listener responsible for protocol coherence.

#### KV Cache effect

Prefix reuse requires earlier messages and declarations to stay byte-identical under the same provider and model route. An unchanged rendered prompt keeps the cached prefix: a capable route leaves retained in-history system nodes in place even when a new series starts, and only an incapable route, or a series start whose effective text differs, consolidates them. A prompt change that replaces a system node in place makes the request differ from that node's first token — in full when the node is node 0 — so the provider prefix cache misses from there; when the prepared call declares `systemPromptUpdate: 'in-history'`, a non-empty prompt change inside a continuing request series is appended after the cached history, so the prefix through that history stays reusable. Changing a retained tool definition or rebuilding declarations invalidates reuse from the first altered request token.

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
