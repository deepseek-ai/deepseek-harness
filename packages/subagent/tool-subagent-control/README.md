---
description: "Discover and coordinate a subagent tree through messaging, interruption, and inbox waiting."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-subagent-control

English | [中文](README.zh.md)

## Summary

`dsh-tool-subagent-control` lets agents discover and message their subagent tree by Session id, interrupt descendants, and wait for their own next-step inbox. By default, one plugin instance registers all four tools; members inherit the same definitions and ordering.

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

Mount this package once per tool scope. It requires `tools`, `subagents`, `agents`, and `systemPrompt`.

### Minimal configuration

With the required services available, load the subagent service, a backend, the delegation tool, and this package to expose all four control and discovery tools:

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
- name: '@deepseek-ai/dsh-tool-subagent-control'
```

Set `config.interrupt: false` to omit `interrupt_agent`. The default is `true`. The other three tools and `ctx.subagents.interrupt()` remain available. See the generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-subagent-control).

### send_message

Sends a message to another agent in the same subagent tree by `agent_id`. The caller must be the live root or a resident continuable subagent. A working target receives Steer input at its next step; an inactive target starts or resumes a turn. Only the target resumes; its creation ancestors stay offline. Success returns inbox acceptance (`messageId`), never a reply. Self, unrelated trees, unsupported targets, unknown ids, unavailable history, and rejected admission return errors.

### interrupt_agent

`agent_id` identifies a descendant by Session id. External executions stop permanently and cannot receive follow-ups. Local targets stop only their current turn: queued messages stay parked until a later `send_message`, descendants keep running, and the child stays available for follow-ups. The call returns when the stop request is accepted, not when the target is quiet; interrupting an already-finished agent is an accepted no-op, and self, sibling, stale, and non-ancestor callers get errored results.

<a id="wait_agent"></a>
### wait_agent

Waits for the exact caller’s next-step inbox. Pending input returns immediately; later input, including messages, completion notifications, and user steering, ends the wait. Queued next-turn messages, unrelated inboxes, and Agent status changes do not end it. Task changes do not end the wait. The tool neither consumes input nor starts an Agent. `timeout_ms` defaults to 30000 and must be an integer from 10000 through 3600000. Results contain only `timedOut`; cancellation, caller disposal, or plugin unload rejects the wait.

### list_agents

Lists the root and all reachable continuable descendants, including the caller, in stable pre-order. Descendant rows carry their direct parent id and depth from the root. Live status is `running` or `inactive`. External entries are omitted without reading child Sessions; readable one-shot children remain traversal nodes. Unknown modes and unreadable catalogs produce diagnostics. Ordinary Session forks lead separate subagent trees.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains what the tools delegate to the subagent service; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

Messaging, interruption, and discovery delegate to `ctx.subagents`; residency, cold resume, and authorization belong to that service. The wait tool subscribes to the exact caller’s inbox events before starting the timer and checking pending next-step input, and removes its listeners and timer on every settlement.

### Delivery and signal ownership

The execution signal owns work only until inbox acceptance. Accepted messages cannot be cancelled through this tool. Every message is framed as `Agent <sender-id> sent a message:` and recorded with `{ kind: 'agent-message', form: 'relay', senderSessionId: sender.id }`. Tree membership authorizes communication; the subagent tree root owns runtime instances and capacity.

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

The generated [schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent-control) define id-addressed messaging and interruption, whole-tree discovery, and inbox waiting with `timeout_ms`. `wait_agent` returns `{ "timedOut": false }` for available input, and `{ "timedOut": true }` on timeout. It returns no message body or peer-activity diagnosis.

#### Token effect

Fixed schema cost per request, independent of the number or descriptions of children; disabling interruption removes its schema and discovery guidance.

#### KV Cache effect

Prefix-stable; the schemas do not change at runtime, and a parent and its continuable children, including fork children, receive identical definitions.

### Identity and communication context

#### What the model sees

Required `subagent:identity` runtime context identifies each agent by its Session id. Delegated children are identified as subagents and receive their direct parent and root ids. It is independent of Team mode and tool filtering; a missing live root is reported without preventing independent work. When the live root is available, identity context includes messaging and discovery instructions independently for each admitted standard tool. Automatic result delivery remains owned by the subagent service.

#### Token effect

One short context entry per agent, independent of tree size.

#### KV Cache effect

Identity and communication guidance follow inherited history as logged runtime context, leaving the shared system prompt and tool definitions unchanged. This required context remains available with `includeRuntimeContext: false` and is restored after compaction. Team mode does not change it.

### Interrupt result

#### What the model sees

`interrupt requested for agent <agent_id>` on acceptance. An unauthorized caller — self, sibling, stale, or non-ancestor — is an errored result naming the rejection; an absent or settled target still renders the acceptance line.

#### Token effect

One short acknowledgement per call; the interrupted turn's abort is visible only in the child's own transcript.

#### KV Cache effect

Append-only; each result follows the reusable request prefix.

### Delivery result

#### What the model sees

`message delivered to agent <id>` on acceptance; canonical output carries the accepted `messageId`. A target outside the caller’s subagent tree or rejected admission produces an errored result.

#### Token effect

One short acknowledgement per call; replies arrive as separately addressed messages. Use ids from `list_agents` for follow-ups across the subagent tree.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Listing result

#### What the model sees

The first row is `<id> [<status>] — root agent`. Each continuable descendant follows as `<id> [<status>] parent=<id> depth=<n> — <label>`. The root has `kind: root`; descendants have `kind: child` relative to that root. Diagnostics render `<id> [diagnostic: <reason>] parent=<id> depth=<n>`. Status describes turn activity, not task completion, success, or failure.

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
