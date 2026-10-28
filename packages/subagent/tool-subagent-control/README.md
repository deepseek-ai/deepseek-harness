---
description: "Discover and coordinate a subagent tree through messaging, interruption, and inbox waiting."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-subagent-control

English | [中文](README.zh.md)

## Summary

`dsh-tool-subagent-control` lets agents discover and message their subagent tree by path or Session id, interrupt descendants, and wait for their own next-step inbox. By default, one plugin instance registers all four tools; members inherit the same definitions and ordering.

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

Mount this package once per tool scope. It requires `tools`, `subagents`, `subagentNames`, `agents`, and `systemPrompt`. The [subagent-names](../subagent-names/README.md) plugin resolves names and Session ids through the fixed `name` argument. Cordis removes these tools when the naming service unloads and restores them when it returns.

### Minimal configuration

With the required services available, load the subagent service, a backend, the delegation tool, and this package to expose all four control and discovery tools:

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-names'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
- name: '@deepseek-ai/dsh-tool-subagent-control'
```

Set `config.interrupt: false` to omit `interrupt_agent`. The default is `true`. The other three tools and `ctx.subagents.interrupt()` remain available. See the generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-subagent-control).

### send_message

`name` selects a full path or Session id of another agent in the same subagent tree. The caller must be the live root or a resident continuable subagent. A working target receives Steer input at its next step; an inactive target starts or resumes a turn. Only the target resumes; its creation ancestors stay offline. Success returns inbox acceptance (`messageId`), never a reply. Self, unrelated trees, unsupported targets, unknown ids, unavailable history, and rejected admission return errors.

### interrupt_agent

`name` identifies a descendant by full path or Session id. External executions stop permanently and cannot receive follow-ups. Local targets stop only their current turn: queued messages stay parked until a later `send_message`, descendants keep running, and the child stays available for follow-ups. The call returns when the stop request is accepted, not when the target is quiet; interrupting an already-finished agent is an accepted no-op, and self, sibling, stale, and non-ancestor callers get errored results.

<a id="wait_agent"></a>
### wait_agent

Waits for the exact caller’s next-step inbox. Pending input returns immediately; later input, including messages, completion notifications, and user steering, ends the wait. Queued next-turn messages, unrelated inboxes, and Agent status changes do not end it. A tree-wide in-memory signal also ends current waits whose captured root is the same live Agent instance; signals are not retained for future waits. Unmanaged delegated Agents can still wait for their own inbox. The tool neither consumes input nor starts an Agent. `timeout_ms` defaults to 30000 and must be an integer from 10000 through 3600000. Results contain only `timedOut`; cancellation, caller disposal, or plugin unload rejects the wait.

### list_agents

Lists the root and all reachable continuable descendants, including the caller, in stable pre-order. Rows retain Session ids, parent ids, and depth from the root. The naming plugin adds `name` and `parentName` when a mapping is available; the root is named `lead`. Unnamed children retain their ids. Each child’s label comes from the `description` supplied at creation. Live status is `running` or `inactive`. External entries are omitted without reading child Sessions; readable one-shot children remain traversal nodes. Unknown modes and unreadable catalogs produce diagnostics. Ordinary Session forks lead separate subagent trees.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains what the tools delegate to the subagent service; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

`ctx.subagentNames` resolves names synchronously; messaging, interruption, and catalog traversal delegate to `ctx.subagents`; residency, cold resume, and authorization belong to that service. The wait tool resolves tree membership once at entry, subscribes to the exact caller’s inbox and tree-wait signals before starting the timer and checking pending next-step input, and removes its listeners and timer on every settlement. Unexpected root lookup failures reject before subscribing.

### Delivery and signal ownership

The execution signal owns work only until inbox acceptance. Accepted messages cannot be cancelled through this tool. Every message is framed as `Agent <sender-name-or-id> sent a message:` and recorded with `{ kind: 'agent-message', form: 'relay', senderSessionId: sender.id }`. Tree membership authorizes communication; the subagent tree root owns runtime instances and capacity.

### Listing projection

`list_agents` resolves the caller’s live root and traverses its catalogs without a cursor, refining activity through the live Agent registry. Unknown modes remain traversable with diagnostics; unreadable catalogs stop that branch. Sessions absent from reachable catalogs cannot be discovered.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Shared control-tool registration |
| [`src/list-agents.ts`](src/list-agents.ts) | Whole-tree discovery and activity projection |
| [`src/wait-agent.ts`](src/wait-agent.ts) | Exact-caller inbox wait and cleanup |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the tool schemas to the continuation service behind them.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — continuable children, activations, inbox, interrupt, and follow-up authority.
- [dsh-tool-subagent](../tool-subagent/README.md) — the delegation tool that starts continuable children.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent-control) — the tool schemas.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The generated [schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent-control) define path- or id-addressed messaging and interruption, whole-tree discovery, and inbox waiting with `timeout_ms`. `wait_agent` returns `{ "timedOut": false }` for available input or a wait signal, and `{ "timedOut": true }` on timeout. It returns no message body or peer-activity diagnosis.

#### Token effect

Fixed schema cost per request, independent of the number or descriptions of children; disabling interruption removes its schema and discovery guidance.

#### KV Cache effect

The schema prefix stays stable while these tools are available. A parent and its continuable children, including fork children, inherit the same definitions.

### Identity and communication context

#### What the model sees

Required `subagent:identity` runtime context identifies the root as `lead`, and each delegated child by its full name, direct parent, and root. It is independent of Team mode and tool filtering. Before a name is bound, it explicitly uses the Session id as the agent address; a missing live root is reported without preventing independent work. Required `subagent:communication` context explains discovery and messaging only when their standard tools are admitted. Delegated children also receive guidance to message their parent when a finding changes its next action. Automatic result delivery remains owned by the subagent service.

#### Token effect

Two short context entries per agent, independent of tree size.

#### KV Cache effect

Identity and communication guidance follow inherited history as logged runtime context, leaving the shared system prompt and tool definitions unchanged. Names come from the root mapping; a later binding updates the next request. Required context survives optional-context suppression and is restored after compaction. Team mode changes neither entry.

### Interrupt result

#### What the model sees

`interrupt requested for agent <address>` on acceptance. An unauthorized caller — self, sibling, stale, or non-ancestor — is an errored result naming the rejection; a known settled target still renders the acceptance line. Unknown name paths are rejected; an absent raw Session id retains an accepted no-op.

#### Token effect

One short acknowledgement per call; the interrupted turn's abort is visible only in the child's own transcript.

#### KV Cache effect

Append-only; each result follows the reusable request prefix.

### Delivery result

#### What the model sees

`message delivered to agent <address>` on acceptance; canonical output carries the accepted `messageId`. A target outside the caller’s subagent tree or rejected admission produces an errored result.

#### Token effect

One short acknowledgement per call; replies arrive as separately addressed messages. Use addresses from `list_agents` for follow-ups across the subagent tree.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Listing result

#### What the model sees

The first row is `<id> [<status>] — lead: root agent`. Each continuable descendant follows as `<id> [<status>] parent=<parent-id> depth=<n> — <label>`. When a name is available, the text prefixes the label with `<name>: `; canonical rows retain the original `label` and add `name` separately. The root has `kind: root`; descendants have `kind: child` relative to that root. Diagnostics retain the id, reason, parent, and depth, with an optional name after ` — `. Status describes turn activity, not task completion, success, or failure.

#### Token effect

Grows linearly with the whole subagent tree’s listed rows. There is no cursor or cap.

#### KV Cache effect

Append-only; each result follows the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the control tools cannot observe or steer; they are current package constraints.

- **A delivered message has no independent result** — acceptance returns only its inbox `messageId`; later target work lands in that target's durable Session and is never collected through this tool. A reply is another explicitly addressed `send_message`, not this call's result.
- **Messaging requires a live subagent tree root** — intermediate creators may be offline. Only the target resumes, consuming one shared capacity slot. Unrelated trees and external or one-shot targets cannot receive messages.
- **Listing is a snapshot, not a delivery promise** — it may race publication, disposal, or a later message, and another process may activate a child this process reports as `inactive`; cross-process accuracy requires a shared lease. `interrupt_agent` performs the authoritative live-lineage check itself, so discovery staleness cannot grant authority.
- **No pagination or deletion** — the complete stably ordered set is returned, and persisted children remain listed for as long as their sessions remain in persistence; a service-level bound or delete operation is a later product decision.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
