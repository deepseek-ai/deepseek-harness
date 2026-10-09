---
description: "The subagent delegation seam for users and maintainers choosing a provider backend, composing delegation tools, or debugging child-agent runs."
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent

English | [中文](README.zh.md)

## Summary

Use `dsh-subagent` to delegate work through named providers and collect managed activation results. Local spawn and fork children retain durable sessions for later messages; ACP, DSH SDK, Codex, and Claude Code execute once. Every child shares admission, cancellation, ownership, and discovery. Compose the service with a provider and a delegation tool.

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

Each start accepts an optional `cwd`; relative paths resolve against the parent's current working directory, and omission captures that current directory. The child keeps its parent's origin metadata and permission roots. A child-owned directory value follows any inherited history, survives continuation and restart, and is independent of later parent changes.

This package is the contract every delegation setup shares. You enable it by mounting the service together with one or more provider backends and the model-facing delegation tool; from then on, an agent can delegate work and the service routes each request to the named provider.

### Enabling delegation

Mount the service with a provider and the delegation tool. The provider registers under its configured name; each tool row selects one provider. A minimal setup:

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
```

The tool returns a child session id immediately. The parent receives a completion notice when the background activation settles. Mounting the service alone enables no delegation.

### Delegation settings

The limits section on the **Plugins → Subagent** page edits the Host’s `subagent` settings section. User values override this plugin's composition; reset removes the user override. `maxDepth` defaults to `1` and supplies the delegation tools' depth when their own configuration omits it. An explicit tool depth, including `provider-managed`, takes precedence. Depth `0` disables delegation through tools inheriting this setting; depth `1` permits direct children only. Changes apply on the next delegation attempt. Direct service callers continue to supply their own optional request depth.

### Activation capacity

Set `maxActiveSubagents` on the host plugin to limit live and materializing children in each activation tree. It defaults to `8` and accepts positive safe integers. A top-level parent starts a pool shared by its local and external descendants; the root parent consumes no slot. Creation and cold resume reserve before yielding, and disposal returns the slot only after cleanup. Waiting parents, pending inbox work, and stopping activations remain counted. Sending to a resident child reuses its slot. Delegation depth is a separate policy.

The current `maxActiveSubagents` value is sampled before every new or cold-resumed Activation. Raising it admits more children in existing trees; lowering it leaves resident children running and refuses further admissions until usage is below the limit.

At capacity, creation or cold resume rejects with `ACTIVATION_LIMIT_REACHED` (browser prompts receive `subagent/delivery-unavailable`): wait for a child to finish or continue using the existing agents. Admission does not queue, because a parent waiting for descendants must not wait for its own occupied slot. Slots are process-local and do not constrain cumulative Session history or token usage.

### Local and external children

`startActivation({ provider, label, request, signal, delivery })` returns `{ childId, messageId?, result, dispose }`. Supplying `childId` selects a local backend and guarantees `messageId`. Local children accept later messages and can cold-resume; external children expose one execution and reject continuation. `request.agentOptions` overrides supported child model settings. `delivery: 'parent'` supplies the model-facing completion notice; `delivery: 'caller'` lets workflows await the result without a parent notice or initial return guidance. Local parent delivery requires persistence; caller delivery can use an ephemeral local session. Cold resume requires persistence and Session query.

### Messaging, interrupting, and discovering

Every exact live Agent can use `sendMessage()` with a direct continuable child; a resident continuable child can also use it with its direct parent. A working target receives the Agent message through Steer at its nearest step; an idle target starts a turn, and only a direct child can be cold-resumed. The parent can also interrupt a running descendant or list its children at any time. A browser continuation prompt independently selects Queue or Steer and may carry image parts: the Host admits and persists each image batch through the attachment store before the child inbox accepts the message, and refuses delivery when the child's declared model does not accept image input. Direct-child discovery reads the parent-owned `subagentCatalog` projection. `listChildren(parentSessionId, signal?)` owns a live-preferred Session observation and returns the catalog asynchronously without reading child logs. It forwards cancellation and releases the observation after materialization. Materialization preserves parent event order in O(D) time for D facts. External entries are leaves and require no child Session observation. Descendant discovery recursively reads local child catalogs in parent event order, observing each reachable Session once. It skips branches whose catalogs cannot be read and returns diagnostics for them; neither path loads or resumes a child Agent.

### Failure and recovery

Starting without the `agents` service rejects with `CONTINUATION_UNAVAILABLE`; an available runtime rejects a missing or replaced parent with `UNAUTHORIZED`. Providers implementing neither execution method are rejected at registration with `UNSUPPORTED_CAPABILITY`; unsupported requested capabilities reject creation with the same code. The caller signal cancels only unpublished work; after publication, `dispose()` cancels the exact activation and waits for its descendants, including pending startups, and their resource cleanup. `result` settles after teardown and notifications, carrying output, optional structured data, and a stop reason; capture failures reject it after teardown. Cleanup failures reject `dispose()` and mark the lifecycle end as failed; the result promise and parent notification retain the captured execution result.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the service is built and where the observable behavior comes from; the full contract lives in [Use this package](#use-this-package).

### Design concept

- **One service, many providers.** The service is a named-provider registry; each backend registers under a unique name and a request picks one by name.
- **One managed lifetime.** `SubagentManager` owns startup, message admission, capacity, parent relationships, and disposal. Each activation retains a local AgentHandle or external SubagentRun directly; local inbox and idle state belong only to the local variant.
- **Fulfillment is publication.** `startActivation()` returns only after the child is accepted and its handle can cancel that exact execution.
- **Trusted same-process values.** Requests, descriptors, and results are borrowed immutable; serialization and hostile-input validation belong at process and wire boundaries.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service entry: provider registry, start and continuation API, lifecycle events |
| [`src/manager.ts`](src/manager.ts) | Unified startup, message admission, cold resume, parent ownership, settlement, and disposal |
| [`src/activation.ts`](src/activation.ts) | Execution records, capacity slots, child locks, and local output capture |
| [`src/continuation-messages.ts`](src/continuation-messages.ts) | Adjacent-Agent messages, return guidance, and settlement notices |
| [`src/internal.ts`](src/internal.ts) | Host-only Queue and Steer adapters plus standard adjacent-Agent messaging markers |
| [`src/structured.ts`](src/structured.ts) | Activation-scoped structured capture and guards |
| [`src/types.ts`](src/types.ts) | Public request, result, and provider contracts |
| [`src/descriptor.ts`](src/descriptor.ts) | Versioned `subagent/descriptor` session-event vocabulary |
| [`src/catalog.ts`](src/catalog.ts) | Parent-owned `subagent/catalog` event and chunked host projection |
| [`src/child-agent.ts`](src/child-agent.ts) | Child composition, delegated policy, depth helpers |
| [`src/list-children.ts`](src/list-children.ts) | Direct and recursive parent-catalog reads |
| [`src/control.ts`](src/control.ts) | Browser control request validation and stable failure codes |
| [`src/control-types.ts`](src/control-types.ts) | Client-safe catalog row, control requests, receipts, and failures |
| [`src/archive-admission.ts`](src/archive-admission.ts) | The `subagent` family of the Workspace registry's archive admission: running descendants and their parent-cause cancel |

### Provider preparation and structured output

The service validates requested capabilities before creation. Local providers supply only `prepareContinuable()`: spawn returns fresh state and fork returns a completed-turn seed. The manager captures the parent model settings, delegated permissions, and composition before creating the child. External providers retain `start()` as a transport adapter and retain their own permission systems. The common manager owns their published execution. Structured tools, instructions, validation, and terminal guards belong to one local activation; they are not persisted as resume configuration. The child can submit its structured result after consuming accepted input and releasing owned descendants. Staging a result closes further input through tool-result policy and any enclosing PTC execution; a rejected result reopens input, while a committed result keeps it closed. Later cold resume has no structured schema.

External providers mint a fresh `SubagentRun.id` for each execution in the runtime's shared Session id namespace, across all parents and providers. A collision with a resident Agent, Session, or activation rejects startup with `DUPLICATE_CHILD` and disposes the new external handle without replacing the existing execution.

### Activation settlement

The manager reserves child identity and capacity, materializes a local Agent or external execution, and accepts the initial task. Local admission closes after Agent activity, pending input, and owned descendants finish, with activity revalidated after the final Session flush. Both local and external activations deliver their result after handle cleanup, capacity release, and settlement notifications. Host waits join progressing descendants and their cleanup, including failed executions; idle parked subtrees remain resident without delaying host completion. Closing admission and disposing the handle prevent late work from entering a released Agent. Parent delivery emits its notice after settlement; caller delivery leaves collection to the awaiting workflow. Headless hosts repeat `agent.whenIdle()` and `waitForChildren(agent)` until no child work remains and the parent stays idle with an unchanged Session sequence across the child check, so completion notices can produce the final parent answer.

A local Agent failure without a subsequently committed `turn/end` settles as `error` after its owned descendants finish. Unclaimed input cannot keep that failed activation resident. A later committed turn ending supersedes the live failure and supplies the recovered outcome.

Successful local creation appends a `subagent/catalog` fact to the parent Session regardless of result delivery. External creation appends a catalog fact only with `delivery: 'parent'`; caller-owned external executions retain their caller's membership records. External entries use `mode: 'external'` to identify children without a local Session. Catalog entries record membership once at creation and carry no execution status. Complete results go to the caller or the parent completion notice. Projections exclude inherited facts. Direct lists read one parent projection, so completed local workflow children remain discoverable and can be opened or continued. Catalog payload v0 records local modes; v1 also accepts unknown mode; v2 records external executions. Readers support all three versions. Historical migration appends a v1 `subagent/catalog` from a readable child header when its descriptor is unavailable; local creation retains v0. Its `mode: 'unknown'` projection keeps the child visible without claiming continuation support; an existing complete entry remains authoritative.

### Ownership and invariants

- **The manager owns accepted work** — unpublished failures roll back; published handles cancel their exact activation and await child-first disposal.
- **Registration is effect-scoped** — removing a provider blocks new starts but never revokes accepted runs.
- **Agent-message authority is exact adjacency** — `sendMessage()` requires the exact live sender; every sender may target a direct continuable child, while only a sender with a resident continuable Activation may target its direct parent.
- **The descriptor is log-only** — a session event absent from model history and retained across compaction; the writer records the resolved child provider, model, and reasoning effort for cold resume. Historical one-shot descriptors remain readable.
- **This runtime answers archive admission for children** ([seam](../../workspace/workspace/README.md)) — `workspace/session-activity` reports the live subagent descendants inside a turn as the `subagent` family, found by the durable lineage this package records (`parentSession` with the subagent origin, any depth, never a fork) and labelled from each child's descriptor through a live Session observation when the Session query service is composed, otherwise by id; `workspace/session-stop` cancels each of them with the parent cause, one at a time, so one child refusing its cancel is logged while its siblings still stop. The parent's own turn, its jobs, and the archived-lineage step gate belong to the API Session Controller.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared seam to the backends, the model-facing tools, and the design decisions.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — the service contract, provider contract, and terminal result semantics.
- [historical Subagent capability seam](../../../.agents/notes/archived/feature/2026-06-21-subagent-capability-seam.md) — the design record for the delegation capability family.
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

Parent delivery emits a user-role status notice containing the child’s nonempty final text blocks, regardless of `send_message` availability or use. External notices also state that further messages are unsupported. Reasoning and other nontext blocks are excluded. Every parent notice includes available structured output as `Structured result: <JSON>` and the provider’s safe diagnostic as a separate text block. Empty closing text is reported as `It left no closing message.` Caller delivery emits no notice; SDK lifecycle notifications retain complete child output when cleanup succeeds.

#### Token effect

One notice per settled activation using parent delivery. Caller delivery adds no completion message; its consumer owns result presentation.

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
- **External children execute once** — ACP, DSH SDK, Codex, and Claude Code have no local child Session and accept no follow-up input. Their parent-owned records remain discoverable after disposal.
- **Adjacent model messaging only** — `sendMessage()` requires an exact live sender; every sender may target a direct continuable child, while only a sender with a resident continuable Activation may target its direct parent. Browser prompts use a separate human Queue-or-Steer control path.
- **A direct parent must remain live for child-to-parent delivery** — the service has no durable parent mailbox; a missing parent rejects the message instead of accepting work it cannot wake.
- **Wake gap during cancellation convergence** — a follow-up accepted after an interrupt signal but before the Agent becomes idle stays queued until another waking send.
- **Pending injected context retains an Activation** — settlement conservatively treats every Inbox occurrence as unfinished. Context parked after the Agent becomes idle keeps the child and its live ancestors resident until a waking delivery claims it, a queue mutation removes it, or manager teardown discards it. Host completion joins active work, pending child creation, and resource cleanup, but does not wait for a subtree containing only idle parked inboxes; it neither completes those activation results nor discards their messages.
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
