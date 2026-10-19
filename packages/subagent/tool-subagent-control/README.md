---
description: "Discover and coordinate a subagent tree through messaging, interruption, inbox waiting, and durable runtime identity."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-subagent-control

English | [中文](README.zh.md)

## Summary

`dsh-tool-subagent-control` lets agents discover and message their subagent tree by Session id, interrupt descendants, and wait for their own next-step inbox. It supplies shared collaboration guidance and required runtime identity, including without experimental Team mode. One plugin instance registers all four tools; members inherit the same definitions and ordering.

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

This package takes no configuration. Its main entry registers `send_message`, `interrupt_agent`, `list_agents`, and `wait_agent`; existing tool restrictions can hide individual tools.

### send_message

Sends a message to another Team member by `agent_id`. The caller must be the live root or a resident continuable subagent. A working target receives Steer input at its next step; an inactive target starts or resumes a turn. Only the target resumes; its creation ancestors stay offline. Success returns inbox acceptance (`messageId`), never a reply. Self, unrelated trees, unsupported targets, unknown ids, unavailable history, and rejected admission return errors.

### interrupt_agent

`agent_id` identifies a descendant by Session id. External executions stop permanently and cannot receive follow-ups. Local targets stop only their current turn: queued messages stay parked until a later `send_message`, descendants keep running, and the child stays available for follow-ups. The call returns when the stop request is accepted, not when the target is quiet; interrupting an already-finished agent is an accepted no-op, and self, sibling, stale, and non-ancestor callers get errored results.

<a id="wait_agent"></a>
### wait_agent

Waits for the exact caller’s next-step inbox. Pending input returns immediately; later input, including messages, completion notifications, user steering, and task-board notices, ends the wait. Queued next-turn messages, unrelated inboxes, and Agent status changes do not end it. The tool neither consumes input nor starts an Agent. `timeout_ms` defaults to 30000 and must be an integer from 10000 through 3600000. Results contain only `timedOut`; cancellation, caller disposal, or plugin unload rejects the wait.

### list_agents

Lists the root and all reachable continuable descendants, including the caller, in stable pre-order. Descendant rows carry their direct parent id and depth from the root. Live status is `running` or `inactive`. External entries are omitted without reading child Sessions; readable one-shot children remain traversal nodes. Unknown modes and unreadable catalogs produce diagnostics. Ordinary Session forks lead separate Teams.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains what the tools delegate to the subagent service; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

Messaging, interruption, and discovery delegate to `ctx.subagents`; residency, cold resume, and authorization belong to that service. The wait tool subscribes to the exact caller’s inbox before checking pending next-step input, and removes its listeners and timer on every settlement.

### Delivery and signal ownership

The execution signal owns work only until inbox acceptance. Accepted messages cannot be cancelled through this tool. Every message is framed as `Agent <sender-id> sent a message:` and recorded with `{ kind: 'agent-message', form: 'relay', senderSessionId: sender.id }`. Tree membership authorizes communication; the Team root owns runtime instances and capacity.

### Listing projection

`list_agents` resolves the caller’s live root and traverses its catalogs without a cursor, refining activity through the live Agent registry. Unknown modes remain traversable with diagnostics; unreadable catalogs stop that branch. Sessions absent from reachable catalogs cannot be discovered.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Shared control-tool and prompt registration |
| [`src/list-agents.ts`](src/list-agents.ts) | Whole-Team discovery and activity projection |
| [`src/wait-agent.ts`](src/wait-agent.ts) | Exact-caller inbox wait and cleanup |
| [`src/collaboration-prompt.ts`](src/collaboration-prompt.ts) | Shared policy and required Agent identity |

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

### Collaboration policy and identity

#### What the model sees

The shared `subagent:policy` section supplies the policy below. Required `subagent:identity` context starts with `Your agent id is <id>. Your Team root agent id is <root>.` A root adds `You are the root agent.`; a descendant adds its parent id. If root resolution is unavailable, it explicitly reports that fact and permits independent work. Ordinary Session forks receive their own root identity. Optional-context suppression cannot remove identity; runtime-context assembly restores it after compaction.

##### Collaboration policy

```markdown
Your Team is the subagent tree rooted at the root agent. Use list_agents to discover agents and send_message with an agent id to contact another listed agent. A working agent receives the message at its next step; an idle agent starts a new turn. Successful delivery does not mean the recipient has processed the message. A delegated agent's final answer is returned automatically while its parent is online.

Continue independent work while other agents run. When you need more input, use wait_agent to wait for your own inbox. Pending input returns immediately; new messages, completion notifications, and user steering end the wait. The tool does not consume messages or start agents, and queued next-turn messages stay queued. After a wakeup or timeout, assess what work remains. Obtain the results needed for your assigned work before answering; unrelated agents need not finish.

Agents may share files even when their working directories differ. Coordinate overlapping edits. If a file operation returns FS_STALE_VERSION, read the current file, apply your intended change to the updated content, and retry. Coordinate formatters, generators, and shell writes explicitly, then review the combined diff and run relevant checks.
```

#### Token effect

The shared policy has a fixed cost. Identity is part of the full runtime-context snapshot; stable retained context adds no new message.

#### KV Cache effect

Policy text stays identical across members. Identity is appended through runtime context rather than changing shared system text; actual provider cache reuse remains best-effort.

### Tool schema

#### What the model sees

The generated [schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent-control) define id-addressed messaging and interruption, whole-tree discovery, and inbox waiting with `timeout_ms`. `wait_agent` returns `{ "timedOut": false }` for available input or `{ "timedOut": true }` on timeout. It returns no message body or peer-activity diagnosis.

#### Token effect

Fixed schema cost per request, independent of the number or descriptions of children.

#### KV Cache effect

Prefix-stable; the schemas do not change at runtime, and a parent and its continuable children, including fork children, receive identical definitions.

### Interrupt result

#### What the model sees

`interrupt requested for agent <agent_id>` on acceptance. An unauthorized caller — self, sibling, stale, or non-ancestor — is an errored result naming the rejection; an absent or settled target still renders the acceptance line.

#### Token effect

One short acknowledgement per call; the interrupted turn's abort is visible only in the child's own transcript.

#### KV Cache effect

Append-only; each result follows the reusable request prefix.

### Delivery result

#### What the model sees

`message delivered to agent <id>` on acceptance; canonical output carries the accepted `messageId`. A target outside the caller’s Team or rejected admission produces an errored result.

#### Token effect

One short acknowledgement per call; replies arrive as separately addressed messages. Use ids from `list_agents` for follow-ups across the Team.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Listing result

#### What the model sees

The first row is `<id> [<status>] — team lead`. Each continuable descendant follows as `<id> [<status>] parent=<id> depth=<n> — <label>`. The root has `kind: root`; descendants have `kind: child` relative to that root. Diagnostics render `<id> [diagnostic: <reason>] parent=<id> depth=<n>`. Status describes turn activity, not task completion.

#### Token effect

Grows linearly with the whole Team’s listed rows. There is no cursor or cap.

#### KV Cache effect

Append-only; each result follows the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the control tools cannot observe or steer; they are current package constraints.

- **A delivered message has no independent result** — acceptance returns only its inbox `messageId`; later target work lands in that target's durable Session and is never collected through this tool. A reply is another explicitly addressed `send_message`, not this call's result.
- **Messaging requires a live Team root** — intermediate creators may be offline. Only the target resumes, consuming one shared capacity slot. Unrelated trees and external or one-shot targets cannot receive messages.
- **Listing is a snapshot, not a delivery promise** — it may race publication, disposal, or a later message, and another process may activate a child this process reports as `inactive`; cross-process accuracy requires a shared lease. `interrupt_agent` performs the authoritative live-lineage check itself, so discovery staleness cannot grant authority.
- **No pagination or deletion** — the complete stably ordered set is returned, and persisted children remain listed for as long as their sessions remain in persistence; a service-level bound or delete operation is a later product decision.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
