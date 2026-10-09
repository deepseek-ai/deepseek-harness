# Agent Note: Continuable subagents

Status: implemented

English | [中文](2026-07-28-continuable-subagent-conversations.zh.md)

This record replaces the Task-backed continuation manager from [Continuable background subagents](../../archived/feature/2026-07-21-continuable-background-subagents.md). It retains the single `ctx.subagents` service from [Merge subagent control into the subagent service](../../archived/simplification/2026-07-26-merge-subagent-control-service.md).

## Problem

The previous continuation manager made one Task, one provider execution, and one result boundary the same object lifetime. Task settlement disposed the child Agent, Task completion injected the completion notice, and later input reconstructed another Agent. That coupled a generic background-work abstraction to conversation delivery even though a continuable subagent already has a Session and an Agent inbox.

Giving queued continuation requests to the manager while the Agent retained its own inbox would create two FIFOs with no single ordering authority. Giving all messages to Jobs instead duplicated the Agent loop's admission, cancellation, and quiescence machinery. `Agent.whenIdle()` cannot recover a per-request Task result because one running interval may drain multiple queued turns, and broad `Agent.cancel()` cannot remove one queued request exactly.

The runtime lifetime is also wider than one turn. A subagent can finish its own turn while a child it created is still running. Disposing the parent runtime at that point removes the Agent that still owns descendant teardown. Keeping every historical subagent resident instead would make memory use unbounded.

Parent Agents need to send later work to the same live child without changing its current turn. Queueing every continuation message as a follow-up preserves one ordering rule.

## Decision

The shared activation entry point, external execution ownership, and caller-versus-parent result delivery are governed by [Unified subagent activations](../simplification/2026-09-17-unified-subagent-activations.md). This record retains the independent rationale described below.

A continuable subagent has one durable Session and at most one process-local Activation:

```text
persisted Session
  -> optional live Activation
       -> one retained AgentHandle
       -> Agent inbox as the only turn FIFO
       -> zero or more owned child Activations
```

An Activation is one residency epoch for a reconstructed child Agent. It may execute multiple FIFO turns and remain resident while waiting for descendants. Its receipt owns the result and cancellation of that exact residency; it does not assign a separate result or Task to each accepted message.

The continuation manager owns activation admission, authority checks, the live ownership graph, cold resume, and child-first disposal. The Agent loop owns all turn ordering and execution. No continuable subagent has a Task, an Activation FIFO, or queued Activation state.

### Materialization and public operations

The named subagent provider participates only in preparing the initial creation spec, where `spawn` and `fork` differ. Its optional `prepareContinuable(request): Promise<ContinuableCreateSpec>` method is the continuable-creation capability. The returned spec contains only detached provider-specific creation inputs such as the optional parent-history seed; it contains no Agent, `AgentHandle`, prompt delivery, result, disposal, or resume operation. The manager reserves the child identity, resolves the durable descriptor and common Agent setup, calls `ctx.agents.create()` through a private activation-owner scope, installs the returned `AgentHandle` into the Activation, establishes any continuable-parent ownership, and then calls `Agent.followup(initialPrompt)`. Inbox acceptance yields a `MessageId`; at that boundary `ctx.subagents.startActivation()` returns a receipt containing `childId`, `messageId`, `result`, and `dispose()` without waiting for the turn to start or for the message to enter the Session log.

Any failure before inbox acceptance rejects without returning either id. Agent creation provides rollback before handle transfer; after transfer, the manager keeps one closing transaction visible to concurrent delivery and drain, disposes the created handle, removes the Activation, and rolls back any parent `ownedChildren` membership before rejecting. Failure before the residency start edge publishes no terminal edge, while failure after a published start closes the lifecycle pair through normal disposal.

Provider method presence selects execution: `prepareContinuable()` creates a local activation; otherwise `start()` starts external execution. `delivery` chooses the result recipient without changing the local lifecycle.

Cold resume does not dispatch through a subagent provider. The continuation manager folds the generic in-process descriptor, calls `ctx.agents.resume()` through the same activation-owner scope, installs the returned `AgentHandle`, and submits the waiting `next-turn`. `SubagentProvider.resume?()` and `SubagentProviderResumeRequest` are absent. The descriptor retains the initial provider name after that provider unregisters; the name does not grant a recovery capability or require the provider for later residency. External executions do not support cold resume.

`SubagentProvider.start()` and `SubagentRun` belong to external execution. A local Activation directly owns its `AgentHandle`; both kinds share manager-owned capacity, settlement, and disposal.

`ctx.subagents.sendMessage(sender, targetId, content, { signal })` is the sole model-authored continuation-message operation. The exact live sender authorizes delivery to its direct parent or direct continuable child; cold resume checks direct-child authority before reconstruction and every path checks again in the final no-await inbox-admission span, so an Agent unregistered or replaced during materialization cannot authorize delivery. The service derives a durable `agent-message` source from that sender. The model-facing `send_message` tool keeps only `agent_id` and `message` and uses fixed Steer scheduling. Local start returns an activation receipt containing the accepted `MessageId`; send returns the `MessageId` directly. Neither exposes whether materialization created or resumed the Agent.

For start and follow-up, the caller signal owns lookup, materialization, and admission only until inbox acceptance. After inbox acceptance, the manager owns the Activation independently; later caller cancellation does not cancel the accepted turn or dispose the child.

### Durable Session and live Activation

The Session owns the stable child identity, transcript, direct-parent lineage, delegation depth, and versioned continuation descriptor. `SessionHeader.parentSession` records the direct parent and is an authorization input; it is not a live routing capability and does not imply that the recorded parent is resident.

An idle historical Session has no `AgentHandle`. The first authorized `next-turn` delivery resumes an Activation from the persisted Session and submits the message to its inbox. Cold resume uses the exact live parent Agent for authorization and, when that parent has an Activation, ownership; it never uses the parent for reconstruction.

A local Activation directly owns the published `AgentHandle` until settlement; the private activation-owner scope is its structural Cordis owner. It creates no intermediate `SubagentRun`. The unified manager also owns external executions through their provider handles. Historical Sessions retain no Agent resources after disposal.

### Activation lifecycle

The internal residency lifecycle has three conditions and no separate `queued` state:

```text
running
  | Agent quiescent with pending inbox or live children
  v
waiting
  | waking delivery
  +--------------------------> running

running or waiting
  | Agent quiescent, empty inbox, and no live children
  v
settled
  | AgentHandle.dispose completes
  v
no Activation
```

`running` means the Agent has an active admission or turn. `waiting` means the Agent is quiescent but its Inbox is nonempty or the Activation still owns at least one child Activation that has not completed disposal. `settled` means the Agent is quiescent, its Inbox is empty, and every owned child is disposed; the manager then disposes the `AgentHandle` and removes the Activation.

The manager derives these states from Agent quiescence, the Inbox's pending state, and the owned-child set rather than maintaining a second execution state machine. A `next-turn` delivered while `running` joins the Agent inbox. A waking delivery while `waiting` wakes the same Agent and returns the Activation to `running`. Delivery after disposal cold-resumes a new Activation.

The manager linearizes manager-owned delivery, child release, and disposal for each durable child. Private manager delivery delegates Queue and Steer to the Agent inbox and checks the Activation closing promise. If manager delivery races with final disposal, exactly one side wins this admission cutoff: delivery either enters the still-live Agent inbox, or observes closing and follows its operation-specific rejection or cold-resume path. Direct Agent work does not use this wrapper, so natural settlement uses short maintenance claims to validate the idle phase before the final flush and final disposal decision, then revalidates the Session sequence, Inbox pending state, wake generation, and owned-child set under the child lock. Accepted work that remains active or changes Session, Inbox, or ownership state invalidates that settlement attempt instead of being cancelled by it; maintenance that starts and finishes entirely during the flush has completed before the cutoff.

### One inbox and follow-up delivery

The Agent inbox is the only queue. Agent messages use Steer; human prompts choose Queue or Steer. Every pending Inbox occurrence keeps the current Activation live until claimed or discarded, including quiet injected context. Neither the manager nor the host maintains a second message queue.

Routing depends only on Activation residency:

| Activation state | Waking message delivery |
|---|---|
| `running` | enqueue in the same Activation |
| `waiting` | wake the same Activation |
| no Activation | cold-resume a new Activation |

Successful `sendMessage()` returns the accepted `MessageId`; failed delivery throws. Inbox events remain the message-lifecycle observations. The service exposes no separate started/queued/resumed routing result.

### Child ownership

Every Activation owns its `AgentHandle` and an `ownedChildren: Set<SessionId>`. Because one Session has at most one live Activation, the child Session id identifies the live child without another runtime-incarnation reference. `SessionHeader.parentSession` records the durable direct-parent identity, while membership in `ownedChildren` records the process-local ownership relationship.

When the authenticated parent is itself a continuation-managed Activation, starting a child or submitting parent-originated work adds the child Session id to that parent's `ownedChildren` before the child can run or the message can enter its inbox. That parent cannot settle or dispose while this set is non-empty. A top-level or other non-continuation Agent has no Activation and does not join this waiting graph.

Child release occurs only after the child Agent is quiescent, its Inbox is empty, every child of that child is disposed, the best-effort final session flush settles, the same settlement facts survive a child-lock revalidation, and the child's `AgentHandle` completes disposal. The manager awaits `ctx.sessions.flush(child.session)` before closing admission but does not interpret its participation boolean: an arbitrary listener cannot prove that the selected persistence backend stored the state. A rejection is logged without preventing revalidation, handle disposal, or ownership release, because retaining a child would permanently pin its ancestors in `waiting`. If the child is owned, the manager then resolves the live parent through `SessionHeader.parentSession` and removes the child Session id from its `ownedChildren`. Manager teardown uses the same child-first order but closes admission and stops work immediately rather than performing natural-settlement revalidation.

Ownership is retained until the child Activation is disposed. A later refinement may release a request-scoped lease earlier, but it would require an exact turn-completion correlation that this Task-free design deliberately does not add.

Top-level teardown is host-owned rather than represented as another Activation. Manager unload invokes its internal manager-wide drain to close admission synchronously, await every admitted materialization through publication or rollback, stop the stable live forest, and release it child-first. A host that owns selected top-level Agents uses `drainDescendants(parents)`: exact Agent identities close admission only below those roots until each leaves the registry, while unrelated forests and manager-wide admission remain live; the manager stops their visible descendants before its first await, waits only materializations admitted below those roots, and releases only the selected branches. Every materialized start and live delivery rechecks caller cancellation, the applicable draining scope, Activation disposal, and exact parent authority in the same synchronous span as inbox submission, so teardown or parent replacement that wins before acceptance prevents delivery to the closing handle. Only after the applicable drain settles may the host dispose its top-level Agents; only manager-wide drain precedes manager-scope disposal.

The activation-owner scope exists because ordinary Cordis owner effects unwind in reverse registration order, which cannot express the dynamic child graph. Manager initialization registers the private scope's structural disposer first and its drain disposer afterward, so reverse unwind invokes the drain before releasing that scope; merely registering a cleanup effect on the same scope as later Agent handles would allow structural handle disposal to bypass child-first ordering. Each materialization registers its barrier participant and snapshots its exact live ancestry before starting the inner transaction, then remains tracked until it installs an Activation or fully rolls back. The Activation retains weak membership of that ancestry, so an intermediate Agent may leave the registry without hiding a still-live descendant from its host root. The manager installs one memoized closing promise before cancellation or recursive callbacks, allowing scoped host shutdown, global manager unload, child release, and normal settlement to converge without double release. Cancellation propagates top-down before slow descendant cleanup; handle release remains child-first. Sibling branches drain independently; one disposal failure is recorded but does not prevent the manager from attempting the remaining selected handles, and the aggregate drain reports failure after all selected branches settle. Durable child Sessions survive this process-local teardown.

### Adjacent-Agent messaging

The shared `sendMessage(sender, targetId, content, options)` service operation adds no second queue. It accepts an exact live sender, permits only its direct parent or direct continuable child, and uses fixed Steer scheduling through the Agent inbox. The global `send_message({ agent_id, message })` tool exposes that same operation in both directions; the child's initial task identifies its direct parent when the tool is visible. The [adjacent-Agent messaging Agent Note](../architecture/2026-08-27-adjacent-agent-steer-messaging.md) owns its schema, authority, attribution, and prompt placement.

### Agent and human scheduling

Every accepted Agent message uses `Agent.steer()`. A running target claims it at the nearest step boundary; an idle or cold-resumed target starts a turn. Browser-authored human input separately carries `delivery: 'queue' | 'steer'` through `subagent.prompt`: Queue opens a later FIFO turn, while Steer uses the same best-effort nearest-step scheduling without changing the message's human source. The public service exposes no caller-selectable scheduling mode for Agent messages.

### Authority and recorded sender identity

Authority is supplied by an exact live Agent tool context. After admission, `MessageSource` and `senderSessionId` record who supplied the message; callers cannot use those fields as authority.

This version authorizes only the durable child's direct parent. The manager checks `SessionHeader.parentSession` against the exact live parent Agent at the final no-await inbox-admission boundary before registering the child in that parent's `ownedChildren`; cold resume also performs an earlier check before reconstruction for fail-fast rejection. Other Agents, ancestors, hosts, teams, and workflows remain rejected until a concrete consumer justifies another authority protocol.

Parent-originated delivery requires the parent to be live when admitted and keeps it live through the ownership relationship.

### Durability, disposal, and recovery

An activation receipt exposes `result` and `dispose()` without Jobs. The caller signal owns unpublished work; receipt disposal cancels the exact activation and awaits descendant startup rollback and child-first release. The [current-turn interrupt](../../../../packages/subagent/subagent/README.md) cancels only the live target turn with `keepInbox`, preserving residency, pending work, and descendants.

Host and manager teardown remains the lifecycle stop path. Manager unload applies it globally; a host applies it only below the exact top-level Agents it owns. Each form closes the applicable admission scope, stops the selected visible Activations, awaits admitted materializations in that scope, releases child-first, and preserves the durable Sessions.

Each turn requests the Session durability checkpoint, while final Activation settlement additionally awaits `ctx.sessions.flush()` as a best-effort barrier before closing admission. The manager then revalidates that no Agent, Inbox, Session, or owned-child state changed during the await; a changed observation retries settlement and flushes the newer state. The manager deliberately ignores the flush boolean because listener participation cannot identify a persistence backend. A rejection is logged without changing the lifecycle result or host-drain outcome; the manager still performs the final revalidation, disposes the handle when it succeeds, and releases ownership, while the persisted child state may be missing or stale on a later resume.

Only messages written to the child Session log are reconstructable with the source that supplied them; inbox acceptance alone provides no restart guarantee.

Session and descriptor persistence survive restart. Activation state, Agent inbox contents, and the ownership graph are process-local. A process crash may lose an accepted initial prompt or follow-up that remained in the inbox without reaching the Session log. The Session and descriptor may survive so a later authorized message can cold-resume the child, but the lost message is not replayed automatically. Recovering accepted unfinished or unlogged messages requires a durable inbox protocol and is not implied here.

### Scope

Local continuable control and external execution share activation ownership. Only local children support later messages and cold resume.

Human Queue/Steer delivery and [current-turn interruption](../../../../packages/subagent/subagent/README.md) use this lifecycle; receipt disposal stops its exact activation and owned descendants. Durable mailboxes, cross-process leases, automatic replay of interrupted inbox work, team authority, workflow authority, public residency queries, and runtime caches remain outside this capability. Delegation-depth policy and adjacent-Agent message authorization retain their own owners.

## Alternatives considered

**Keep Task-backed Activations.** Jobs provide generic status, result collection, and cancellation, but using them for conversation delivery creates a second queue and duplicates turn ownership. This design gives up those generic Task controls so the Agent inbox remains the only execution order.

**Create one Activation per `next-turn`.** This restores independent result and cancellation boundaries, but it requires a manager FIFO beside the Agent inbox and makes a retained Agent cross artificial Activation boundaries. One Activation per residency epoch is smaller and follows the `AgentHandle` lifetime directly.

**Dispose the Agent while waiting.** Reconstructing a parent while its child still belongs to the previous process-local ownership graph would require a durable ownership and teardown protocol. Retaining the `AgentHandle` only for the unfinished graph preserves child-first teardown without keeping settled history resident.

**Let the provider create, resume, or deliver through an Agent handle.** Initial providers own only `prepareContinuable()` and its detached creation-spec distinction: whether a child begins fresh or with a parent prefix. The manager must call `ctx.agents.create()` through its private activation-owner scope so that scope is a structural owner of every handle. A persisted in-process Session already contains the initial prefix and generic reconstruction descriptor, while delivery belongs to the Agent inbox. Giving providers any later handle, `SubagentRun`, or message ownership would retain provider ownership with no shipped behavior to justify it.

**Make child-authored reporting part of residency.** Adjacent-Agent messaging is separately composed through `send_message`; its authority and scheduling are independent of residency. Parent-result delivery belongs to the manager and includes a runtime settlement notice even when the child sends no message.

**Treat `SessionHeader.parentSession` as live ownership.** Durable lineage does not prove that the recorded parent currently owns the child. Membership in the live parent's `ownedChildren` records the process-local relationship without changing the durable parent id.

**Retain the exact parent Agent in a separate link.** The parent Activation already owns its `AgentHandle`, and `ownedChildren` prevents that Activation from disposing while the child remains live. Resolving the parent by Session id is therefore sufficient and avoids a redundant runtime reference.

**Maintain a separate queue for continuation messages.** A second FIFO creates ambiguous ordering against messages already accepted by the Agent. A single Agent inbox gives every accepted turn one observable order.

**Expose subagent steering now.** Parent steering needs current-turn controller state and a separate admission policy from follow-up delivery. Queueing every first-version continuation avoids that state and its admission race.

**Expose host-user follow-up without a host consumer.** A public authority-minting method and user branch would make cold resume possible without the historical parent, but no production host adapter calls that operation. The continuation API accepts only the exact live parent until a concrete authenticated host interaction can receive a private capability.

**Return a subagent-specific delivery route.** Labels such as `started`, `queued`, and `resumed` duplicate Activation and inbox state without giving the caller an independent result. Reusing `MessageId` and the existing inbox events keeps delivery correlation on the Agent contract that owns it.

**Use a child reference count.** A count cannot identify which child still owns teardown work and permits duplicate decrement errors. An identity set retains cancellation and disposal obligations explicitly.

## Consequences

The implementation pins these behaviors:

- A continuable child has at most one live Activation and one Agent inbox; the continuation manager has no Activation FIFO or queued Activation state.
- `SubagentProvider.prepareContinuable?()` returns detached local creation inputs; `start()` establishes external execution.
- The manager calls `ctx.agents.create()` through its private activation-owner scope, installs the returned `AgentHandle` and parent ownership, calls `Agent.followup(initialPrompt)`, and returns a receipt containing `childId`, `messageId`, `result`, and `dispose()` when inbox acceptance yields the `MessageId`, without waiting for turn start or a Session-log write.
- Every failure before initial-prompt inbox acceptance rejects without ids and rolls back any created handle, Activation, and parent `ownedChildren` membership through a closing transaction visible to concurrent delivery and drain; lifecycle publication failure emits no unmatched terminal edge.
- Cold resume calls `ctx.agents.resume()` from the continuation manager and never dispatches through or requires the initial subagent provider; the descriptor retains the initial provider name after provider removal, while `SubagentProvider.resume?()` and `SubagentProviderResumeRequest` are absent.
- A local Activation directly owns `AgentHandle`; an external Activation owns `SubagentRun`.
- `sendMessage()` accepts only an exact live adjacent Agent and rechecks authority at final inbox admission after materialization; recorded source fields cannot authorize delivery.
- Agent messages use Steer; human Queue prompts retain FIFO turn ordering.
- `ctx.subagents.sendMessage()` returns the accepted `MessageId` without exposing materialization routing.
- Caller signals stop unpublished work; activation receipts and host drains own child-first teardown. The [current-turn interrupt](../../../../packages/subagent/subagent/README.md) preserves pending work and residency.
- Human prompt delivery and current-turn interruption retain their separate authorization checks.
- An idle Agent with live owned children yields a `waiting` Activation whose `AgentHandle` remains retained.
- A `next-turn` delivered to `waiting` wakes the same Activation; delivery after completed disposal cold-resumes a new Activation.
- Every continuation-managed parent Activation disposes only after all directly owned child Activations complete `AgentHandle` disposal; top-level Agents do not join the waiting graph.
- Final Activation settlement awaits `ctx.sessions.flush(child.session)` with admission open, logs rejection without interpreting listener participation as durability proof, revalidates the final state under the child lock, then closes admission, disposes the child handle, and releases parent ownership so a flush failure cannot leak a `waiting` Activation.
- Manager teardown closes admission globally; a host owning selected top-level Agents instead closes admission only below their exact identities until those roots leave the registry. Both track admitted materializations by exact ancestry, install one memoized disposal cutoff per selected visible Activation, propagate cancellation top-down, release handles child-first, await every selected branch despite individual failures, and only then dispose the corresponding top-level Agents or manager scope.
- Parent delivery emits runtime settlement notices independently of child-authored messages.
- Session logs reconstruct only messages that were actually written, with the source that supplied each message; inbox-accepted but unlogged messages have no restart guarantee.
- No continuable-subagent path creates or depends on a Task, `JobId`, Task completion notice, Task cancellation, or intermediate result-bearing execution wrapper.
- Unit coverage pins the `startActivation()` inbox-acceptance return boundary, complete rollback for each pre-acceptance and lifecycle-publication failure, global and parent-scoped drain quiescence for materialization caught between Agent publication and Activation registration, sibling-forest isolation, exact ancestry after an intermediate Agent leaves the registry, provider-independent cold resume, final exact-parent reauthorization after cold-resume materialization, caller-signal and teardown ownership on both sides of acceptance, and the absence of automatic replay for accepted-but-unlogged messages.
- Unit coverage pins the residency-only routing table, single-inbox ordering, `MessageId` correlation through inbox events, follow-up during an open turn, waiting wakeup, cold resume, ownership registration and release, child-first disposal, send-versus-dispose races, direct Agent turns, Session-only work, and maintenance accepted during the final-flush await, best-effort final flush with absent and failing listeners, and separately authorized human prompt delivery and interruption.
- Adjacent-Agent tests cover direct-parent authority, tool visibility, cold resume, and delivery during settlement.
- Keyless assembled-app snapshots cover delegation, adjacent-Agent messaging, runtime settlement notices, and child-first disposal.

### Accepted costs

Removing Jobs gives up generic background-work inspection, result collection, and exact Task cancellation. If those product features become requirements, they need a request ticket or inbox capability that does not reintroduce a second execution queue.

Retaining an Activation while descendants run consumes Agent resources proportional to the unfinished ownership graph. The existing delegation-depth policy still bounds nesting, and [shared Activation capacity](../../../../packages/subagent/subagent/README.md) bounds live continuable descendants; settled historical Sessions retain no `AgentHandle`.

The process-local inbox and ownership graph do not coordinate two harness processes. Deployments allowing concurrent access to one persistence store still require a durable lease and mailbox protocol.

Child-authored `send_message` calls and manager-authored settlement notices remain distinct in the parent log. The detailed local child transcript remains in its own durable Session.

Steer delivery reaches the next available step boundary; it does not preempt an executing tool. Queue delivery retains later-turn ordering.

A failed best-effort final flush is logged while the runtime ownership graph continues draining; the persisted child state may be missing or stale. Retry and repair require a separate recovery design.
