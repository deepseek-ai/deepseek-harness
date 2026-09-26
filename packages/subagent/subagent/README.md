---
description: "The subagent delegation seam for users and maintainers choosing a provider backend, composing delegation tools, or debugging child-agent runs."
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent

English | [中文](README.zh.md)

## Summary

Use `dsh-subagent` to delegate work to named child agents, collect their results, and continue supported child conversations across turns. A composition can offer in-process, ACP, SDK, Codex, or Claude Code children side by side. Choose one-shot children for a single result or continuable children for later messages and interruption. You can also inspect available children, their mode, live activity, latest closed-turn completion, and lineage without loading or resuming them. Enable at least one supported child backend and a delegation tool.

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

This package is the contract every delegation setup shares. You enable it by mounting the service together with one or more provider backends and the model-facing delegation tool; from then on, an agent can delegate work and the service routes each request to the named provider.

### Enabling delegation

Mount the service with a provider and the delegation tool. The provider registers under the name you configure (the in-process spawn backend defaults to `spawn`); the tool row names that provider so the model sees a static tool. A minimal one-shot setup:

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
```

An agent that calls the tool gets the child's final answer as the tool result. Mounting the service alone changes nothing: nothing can delegate until a provider and a tool are composed.

### Delegation settings

The limits section on the **Plugins → Subagent** page edits the Host’s `subagent` settings section. User values override this plugin's composition; reset removes the user override. `maxDepth` defaults to `1` and supplies the delegation tools' depth when their own configuration omits it. An explicit tool depth, including `provider-managed`, takes precedence. Depth `0` disables delegation through tools inheriting this setting; depth `1` permits direct children only. Changes apply on the next delegation attempt. Direct service callers continue to supply their own optional request depth.

### Continuable capacity

Set `maxActiveSubagents` on the host `dsh-subagent` plugin to limit live children sharing uninterrupted continuable parent links. It defaults to `8` and accepts positive safe integers. A non-continuable parent starts a separate pool and does not consume a slot; continuable descendants inherit that pool. Fresh creation and cold resume reserve before reconstructing the Agent, and cleanup returns the slot after handle disposal. A waiting parent, pending inbox work, and an Activation being stopped still occupy slots. Messages to a resident child reuse its slot. One-shot and external-provider runs are outside this limit. Pool inheritance does not cross a one-shot parent; its continuable children share a separate pool. Depth remains the delegation tool's separate policy.

The current `maxActiveSubagents` value is sampled before every new or cold-resumed Activation. Raising it admits more children in existing trees; lowering it leaves resident children running and refuses further admissions until usage is below the limit.

At capacity, creation or cold resume rejects with `ACTIVATION_LIMIT_REACHED` (browser prompts receive `subagent/delivery-unavailable`): wait for a child to finish or continue using the existing agents. Admission does not queue, because a parent waiting for descendants must not wait for its own occupied slot. Slots are process-local and do not constrain cumulative Session history or token usage.

### One-shot and continuable children

One-shot children run once and settle with a single result, plus an optional structured output and a safe diagnostic on failure. A start request may override the child Agent's provider, model, reasoning effort, and output-token limit through `agentOptions`; every requested option requires the provider's matching capability. Continuable children keep a durable session and accept later messages in order: the caller receives a stable child id, sends adjacent-Agent messages, and can interrupt the current turn without destroying the child. The tool row's `backgroundMode` picks the shape (`one-shot` by default, or `continuable` on providers that support it).

### Messaging, interrupting, and discovering

Every exact live Agent can use `sendMessage()` with a direct continuable child; a resident continuable child can also use it with its direct parent. A working target receives the Agent message through Steer at its nearest step; an idle target starts a turn, and only a direct child can be cold-resumed. The parent can also interrupt a running descendant or list its children at any time. A browser continuation prompt independently selects Queue or Steer and may carry image parts: the Host admits and persists each image batch through the attachment store before the child inbox accepts the message, and refuses delivery when the child's declared model does not accept image input. Direct-child discovery reads the parent-owned `subagentCatalog` projection. `listChildren(parentSessionId, signal?)` owns a live-preferred Session observation and returns the catalog asynchronously without reading child logs. It forwards cancellation and releases the observation after materialization. Materialization preserves parent event order in O(D) time for D facts. Descendant discovery recursively reads those child catalogs in parent event order, observing each reachable Session once. It skips branches whose catalogs cannot be read and returns diagnostics for them; neither path loads or resumes a child Agent.

### Failure and recovery

Requests that need a capability the chosen provider lacks fail loudly at start rather than being silently ignored. A failed child run returns a stop reason, and provider backends add a safe diagnostic; a cancelled request settles as `aborted`. Children are isolated: a crashed or misbehaving child cannot corrupt the parent's session.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the service is built and where the observable behavior comes from; the full contract lives in [Use this package](#use-this-package).

### Design concept

- **One service, many providers.** The service is a named-provider registry; each backend registers under a unique name and a request picks one by name.
- **Two child shapes.** One-shot runs transfer ownership at publication; continuable children keep a durable Session and at most one process-local Activation.
- **Fulfillment is publication.** A provider's `start()` fulfills only after a real child exists, so the caller always owns a live run or nothing.
- **Trusted same-process values.** Requests, descriptors, and results are borrowed immutable; serialization and hostile-input validation belong at process and wire boundaries.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service entry: provider registry, start and continuation API, lifecycle events |
| [`src/continuation.ts`](src/continuation.ts) | Continuable orchestration: identity reservation, provider preparation, cold resume, authorization, routing |
| [`src/continuation-activation.ts`](src/continuation-activation.ts) | Process-local Activation graph, admission, settlement, and child-first disposal |
| [`src/continuation-messages.ts`](src/continuation-messages.ts) | Adjacent-Agent messages, return guidance, and settlement notices |
| [`src/internal.ts`](src/internal.ts) | Host-only Queue and Steer adapters plus standard adjacent-Agent messaging markers |
| [`src/inbox.ts`](src/inbox.ts) | Activation-local Queue and Steer admission plus the synchronous closing cutoff |
| [`src/types.ts`](src/types.ts) | Public request, result, and provider contracts |
| [`src/descriptor.ts`](src/descriptor.ts) | Versioned `subagent/descriptor` session-event vocabulary |
| [`src/catalog.ts`](src/catalog.ts) | Parent-owned `subagent/catalog` event and chunked host projection |
| [`src/child-agent.ts`](src/child-agent.ts) | Child composition, delegated policy, depth helpers |
| [`src/list-children.ts`](src/list-children.ts) | Direct and recursive parent-catalog reads |
| [`src/control.ts`](src/control.ts) | Browser control request validation and stable failure codes |
| [`src/control-types.ts`](src/control-types.ts) | Client-safe catalog row, control requests, receipts, and failures |
| [`src/archive-admission.ts`](src/archive-admission.ts) | The `subagent` family of the Workspace registry's archive admission: running descendants and their parent-cause cancel |

### One-shot flow

A request is validated against the provider's advertised capabilities, a durable descriptor is snapshotted, and the provider builds the child. Both in-process providers advertise `agentOptions`: child creation merges requested fields over the provider, model, and reasoning effort in the parent's latest logged request, falls back to creation options before the first request, and retains the configured token limit. They also snapshot delegated permission state before the first await: an Auto or Full access parent gives the child the same `permission/preset` identity, while the existing sandbox override and approval-policy pin continue to apply. Recording both identities prevents an older same-bundle fork value from winning. Auto then reviews every supported child call independently: ordinary project-local work is low risk and allowed, medium-risk work requires explicit action, exact-target and scope authorization from the existing creation prompt or an authenticated human/direct-parent message, without conflicting human limits, while high-risk work is always denied. The reviewer derives that context from `parentSession` and existing messages; delegation adds no parent call metadata, delegation records, review receipt, or Session format. A route change without an explicit effort clears the inherited route-owned effort so the selected model resolves its default. DSH SDK also advertises `agentOptions` but runs a separate child runtime, so it does not inherit Auto; ACP, Codex, and Claude Code likewise retain their own permission systems after the parent delegation call passes review. On success the run is published and ownership transfers to the caller; on failure the provider rolls back every unpublished resource. The result carries the child's final output, an optional structured value, a stop reason, and an optional safe diagnostic.

### Continuable flow

The manager reserves a child identity, resolves the durable descriptor, creates (or cold-resumes) the child Agent, installs it in an Activation, and submits the prompt. Model-authored messages cross one parent/child edge through fixed Steer scheduling; browser human prompts choose Queue or best-effort Steer through an internal adapter, while other host protocols may retain Queue for distinct turns. A Session queue command admits a live subagent-owned Agent only from its own continuable descriptor. Settlement waits for Agent activity to finish, an empty Inbox, and no owned children, then flushes final Session state with admission open. Under the child lock, the manager revalidates the wake generation, Session sequence, Inbox, and owned children; the synchronous task entry of `Agent.runMaintenance()` claims the idle phase and closes the private subagent Inbox in the same JavaScript turn before handle disposal. An absent direct-child Activation cold-resumes from the persisted session. When a resident Activation settles, the manager tells the child's direct parent in the parent's own turn stream.

Successful local child creation appends a `subagent/catalog` fact to the parent Session. One-shot creation records it after the provider returns; continuable creation records it after initial inbox admission and before returning the child id. Failure releases the child without publishing a compensating catalog event. A one-shot catalog append failure handles the run’s result rejection and preserves the catalog error; disposal failures are logged separately. The `subagentCatalog` projection excludes fork-inherited facts and exposes a direct-child list through `projections.values.subagentCatalog` in Session observations and client snapshots. Each child's `subagentTiming` projection accumulates post-descriptor duration and records whether its latest closed turn ended with `completed`, clearing that completion when another turn opens. Invalid own catalog payloads, including unsupported versions, reject projection restoration. Projection state-version changes refold cached rows from the durable log. The catalog view preserves parent event order in O(D) time for D facts, and its immutable storage and checkpoint validation use [`dsh-chunked-list`](../../util/chunked-list/README.md). [The parent-catalog decision](../../../.agents/notes/implemented/architecture/2026-09-01-parent-owned-subagent-catalog.md) owns ordering, persistence costs, and alternatives. Catalog payload v0 records known modes; v1 also accepts unknown mode. Readers support both versions. Historical migration appends a v1 `subagent/catalog` from a readable child header when its descriptor is unavailable; normal creation retains v0. Its `mode: 'unknown'` projection keeps the child visible without claiming continuation support; an existing complete entry remains authoritative.

### Ownership and invariants

- **Publication is the boundary** — before it the provider owns the setup and must roll back on failure; after it the caller owns the run and must dispose it.
- **Registration is effect-scoped** — removing a provider blocks new starts but never revokes accepted runs.
- **Agent-message authority is exact adjacency** — `sendMessage()` requires the exact live sender; every sender may target a direct continuable child, while only a sender with a resident continuable Activation may target its direct parent.
- **The descriptor is log-only** — a session event absent from model history and retained across compaction; a continuable descriptor records the resolved child provider, model, and reasoning effort explicitly for cold resume.
- **This runtime answers archive admission for children** ([seam](../../workspace/workspace/README.md)) — `workspace/session-activity` reports the live subagent descendants inside a turn as the `subagent` family, found by the durable lineage this package records (`parentSession` with the subagent origin, any depth, never a fork) and labelled from each child's descriptor through a live Session observation when the Session query service is composed, otherwise by id; `workspace/session-stop` cancels each of them with the parent cause, one at a time, so one child refusing its cancel is logged while its siblings still stop. The parent's own turn, its jobs, and the archived-lineage step gate belong to the API Session Controller.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared seam to the backends, the model-facing tools, and the design decisions.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — the service contract, provider contract, and terminal result semantics.
- [Subagent capability seam](../../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md) — the design record for the delegation capability family.
- [Continuable subagents](../../../.agents/notes/implemented/feature/2026-07-28-continuable-subagent-conversations.md) — durable children that accept follow-up turns.
- [In-process spawn backend](../subagent-spawn-in-process/README.md) — the simplest provider to compose.
- [Auto review](../../experimental/auto-review/README.md) — the current-session authorization mode inherited only by in-process DSH children.
- [Out-of-process ACP backend](../subagent-acp/README.md) — children with their own runtime over the Agent Client Protocol.
- [DeepSeek input conversion](../../llm/llm-deepseek/README.md#model-experience) — provider replay rules for saved settlement notices.
- [tool-subagent-control README](../tool-subagent-control/README.md) — the follow-up, interrupt, and listing surface.

-----

<a id="model-experience"></a>
## Model Experience

### Settlement notice

#### What the model sees

One user-role parent message opening with the outcome — `Background subagent <child-id> finished and will do no further work unless you send it more.`, or the matching line for a child that was stopped, ran out of room, declined, or failed — followed by `Its closing message:` and the nonempty text blocks from the child's final assistant output, preserving their content and order. Reasoning and other nontext blocks are excluded; when no nonempty text remains, the notice says `It left no closing message.` This runtime-owned notice is distinct from model-authored parent/child messages, which use `sendMessage()` and `AgentMessageSource`; delegation schemas and model controls belong to the Consumer packages.

#### Token effect

One notice per settled Activation in the parent's request, sized by the child's final text. A child that sends its own message and then settles costs the parent both.

#### KV Cache effect

Append-only in the parent: the notice follows its reusable request prefix. Reaching an idle parent starts one independent model request; reaching a busy one does not.

### Child delegation-scope statement

#### What the model sees

Every in-process child's runtime-context snapshot carries the `subagent:delegation` statement below, after the sandbox-policy and approval-policy sentences.

##### The delegation-scope statement

```markdown
You are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session — operations that require approval are rejected automatically. When the job needs access beyond that scope, do not retry the denied operation; state the limitation in your reply so the delegating agent can handle it.
```

#### Token effect

One fixed statement in each child's runtime-context snapshot; none in the parent's requests.

#### KV Cache effect

Prefix-stable within a child: the statement never changes during the child's lifetime, so it is written once into the first runtime-context snapshot. Parent-side, no direct invalidation; the named tool consumers own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the seam is a poor fit or needs special operational care. They are current package constraints, not a general delegation comparison or a task backlog.

- **Descendant reads are sequential** — each reachable catalog, including one-shot children, takes one observation. A cold Session without a valid prepared observation requires a full-log read; large cold trees can accumulate storage latency.
- **ACP children remain one-shot and are not trace-enumerable** — an ACP run has no local child session in the parent's session corpus, and remote providers need an Activation ownership contract before they can support continuable children.
- **Adjacent model messaging only** — `sendMessage()` requires an exact live sender; every sender may target a direct continuable child, while only a sender with a resident continuable Activation may target its direct parent. Browser prompts use a separate human Queue-or-Steer control path.
- **A direct parent must remain live for child-to-parent delivery** — the service has no durable parent mailbox; a missing parent rejects the message instead of accepting work it cannot wake.
- **Wake gap during cancellation convergence** — a follow-up accepted after an interrupt signal but before the driver becomes idle stays queued until another waking send.
- **Pending injected context retains an Activation** — settlement conservatively treats every Inbox occurrence as unfinished. Context parked after the Agent becomes idle keeps the child and its live ancestors resident until a waking delivery claims it, a queue mutation removes it, or manager teardown discards it.
- **Process-local residency** — the Activation inbox and ownership graph do not coordinate two harness processes; concurrent access to one persistence store needs a durable mailbox and cross-process lease protocol.
- **No replay of accepted-but-unlogged messages** — a crash can lose an accepted prompt that never reached the child's session log; the lost message is not replayed automatically.
- **No durable parent mailbox** — child-to-parent messages require a resident continuable child and live direct parent, and provide acceptance identity rather than exactly-once delivery.
- **Lifecycle events are observe-only** — a run-affecting `subagent/end` continuation or decision API waits for a concrete consumer.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the package code.

- **Cross-process continuation** — a durable mailbox and lease protocol would let two harness processes share one persistence store.
- **Continuable ACP children** — requires persisting the remote session id and a per-child continuation advertisement.
- **Host-user delivery** — a future host adapter needs a concrete authenticated interaction before the seam gains a user delivery capability.

</details>
