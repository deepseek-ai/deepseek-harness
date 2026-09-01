---
description: "The subagent delegation seam for users and maintainers choosing a provider backend, composing delegation tools, or debugging child-agent runs."
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent

English | [中文](README.zh.md)

## Summary

`dsh-subagent` is the service behind child-agent delegation: an agent hands a task to a named child, collects the finished result, and — for continuable children — keeps sending follow-up work across turns. Multiple providers coexist under one contract, so a single composition can offer in-process children, out-of-process ACP or SDK children, and real Codex or Claude Code children side by side. Children come in two shapes: one-shot runs that settle with a single result, and continuable children whose durable session accepts later messages and can be interrupted. The same service answers discovery questions — which children exist, their mode, activity, and lineage — without loading or resuming them. Mount it with at least one provider backend and a delegation tool; the backends and the model-facing tools live in sibling packages.

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

### One-shot and continuable children

One-shot children run once and settle with a single result, plus an optional structured output and a safe diagnostic on failure. A start request may override the child Agent's provider, model, reasoning effort, and output-token limit through `agentOptions`; every requested option requires the provider's matching capability. Continuable children keep a durable session and accept later messages in order: the caller receives a stable child id, sends adjacent-Agent messages, and can interrupt the current turn without destroying the child. The tool row's `backgroundMode` picks the shape (`one-shot` by default, or `continuable` on providers that support it).

### Messaging, interrupting, and discovering

Every exact live Agent can use `sendMessage()` with a direct continuable child; a resident continuable child can also use it with its direct parent. A working target receives the message through Steer at its nearest step; an idle target starts a turn, and only a direct child can be cold-resumed. The parent can also interrupt a running descendant or list its children at any time. A browser continuation prompt may carry image parts: the Host admits and persists each image batch through the attachment store before the child inbox accepts the message, and refuses delivery when the child's declared model does not accept image input. Discovery covers both shapes: the service lists direct children and the full descendant tree — mode, activity, and lineage — reading live session state and optional persistence, without loading any child.

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
| [`src/continuation.ts`](src/continuation.ts) | Continuable children: identity reservation, Activation residency, adjacent messaging, interrupt, settlement |
| [`src/internal.ts`](src/internal.ts) | Host-only Queue adapter for browser and Team message protocols |
| [`src/types.ts`](src/types.ts) | Public request, result, and provider contracts |
| [`src/descriptor.ts`](src/descriptor.ts) | Versioned `subagent/descriptor` session-event vocabulary |
| [`src/child-agent.ts`](src/child-agent.ts) | Child composition, delegated policy, depth helpers |
| [`src/list-children.ts`](src/list-children.ts) | Discovery over the live session store and optional persistence |
| [`src/control.ts`](src/control.ts) | Browser control assembly: catalog activity sampling, browser-zone validation, failure codes |
| [`src/control-types.ts`](src/control-types.ts) | Client-safe catalog row, control requests, receipts, and failures |

### One-shot flow

A request is validated against the provider's advertised capabilities, a durable descriptor is snapshotted, and the provider builds the child. Both in-process providers advertise `agentOptions`: child creation merges requested fields over the provider, model, and reasoning effort in the parent's latest logged request, falls back to creation options before the first request, and retains the configured token limit. A route change without an explicit effort clears the inherited route-owned effort so the selected model resolves its default. DSH SDK also advertises this capability and publishes immutable `agentRouteDefaults`, which supply its instance provider/model defaults before exact-route preflight; `start()` still owns direct callers and the output cap. ACP, Codex, and Claude Code reject agent-route overrides rather than silently ignoring them. On success the run is published and ownership transfers to the caller; on failure the provider rolls back every unpublished resource. The result carries the child's final output, an optional structured value, a stop reason, and an optional safe diagnostic.

### Continuable flow

The manager reserves a child identity, resolves the durable descriptor, creates (or cold-resumes) the child Agent, installs it in an Activation, and submits the prompt. Model-authored messages cross one parent/child edge through fixed Steer scheduling; host protocols retain an internal Queue adapter for distinct turns. An absent direct-child Activation cold-resumes from the persisted session. When a resident Activation settles, the manager tells the child's direct parent in the parent's own turn stream.

### Ownership and invariants

- **Publication is the boundary** — before it the provider owns the setup and must roll back on failure; after it the caller owns the run and must dispose it.
- **Registration is effect-scoped** — removing a provider blocks new starts but never revokes accepted runs.
- **Agent-message authority is exact adjacency** — `sendMessage()` requires the exact live sender; every sender may target a direct continuable child, while only a sender with a resident continuable Activation may target its direct parent.
- **The descriptor is log-only** — a session event absent from model history and retained across compaction; a continuable descriptor records the resolved child provider, model, and reasoning effort explicitly for cold resume.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared seam to the backends, the model-facing tools, and the design decisions.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — the service contract, provider contract, and terminal result semantics.
- [Subagent capability seam](../../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md) — the design record for the delegation capability family.
- [Continuable background subagents](../../../.agents/notes/implemented/feature/2026-07-21-continuable-background-subagents.md) — durable children that accept follow-up turns.
- [In-process spawn backend](../subagent-spawn-in-process/README.md) — the simplest provider to compose.
- [Out-of-process ACP backend](../subagent-acp/README.md) — children with their own runtime over the Agent Client Protocol.
- [Merged subagent control service](../../../.agents/notes/implemented/simplification/2026-07-26-merge-subagent-control-service.md) — the follow-up, interrupt, and listing surface.

-----

<a id="model-experience"></a>
## Model Experience

### Settlement notice

#### What the model sees

One user-role parent message opening with the outcome — `Background subagent <child-id> finished and will do no further work unless you send it more.`, or the matching line for a child that was stopped, ran out of room, declined, or failed — followed by `Its closing message:` and the child's final assistant content, or `It left no closing message.` when it produced none. This runtime-owned notice is distinct from model-authored parent/child messages, which use `sendMessage()` and `AgentMessageSource`; delegation schemas and model controls belong to the Consumer packages.

#### Token effect

One notice per settled Activation in the parent's request, sized by the child's final message. A child that sends its own message and then settles costs the parent both.

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

- **ACP children remain one-shot and are not trace-enumerable** — an ACP run has no local child session in the parent's session corpus, and remote providers need an Activation ownership contract before they can support continuable children.
- **Adjacent model messaging only** — `sendMessage()` requires an exact live sender; every sender may target a direct continuable child, while only a sender with a resident continuable Activation may target its direct parent. Browser prompts use the separate Queue control path.
- **A direct parent must remain live for child-to-parent delivery** — the service has no durable parent mailbox; a missing parent rejects the message instead of accepting work it cannot wake.
- **Wake gap during cancellation convergence** — a follow-up accepted after an interrupt signal but before the driver becomes idle stays queued until another waking send.
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
