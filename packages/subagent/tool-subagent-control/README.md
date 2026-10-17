---
description: "Global send_message, interrupt_agent, and list_agents tools for users and maintainers composing or debugging continuable-child control."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-subagent-control

English | [中文](README.zh.md)

## Summary

`dsh-tool-subagent-control` lets agents discover and message every member of their Team by name. `interrupt_agent` stops only the caller’s descendants, retaining their inboxes and children. The separately loadable `list-agents` plugin lists the whole tree with descriptions, parent names, depth, and activity. All members inherit the same tool definitions and ordering.

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

Mount this package in any composition with continuable children the model should message, interrupt, or list. The root plugin needs only the subagent service; the list tool is a separate plugin a deployment can omit.

### Minimal configuration

Load the subagent service, a backend, the delegation tool, and this package. Adding the separate list plugin exposes all three tools:

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
- name: '@deepseek-ai/dsh-tool-subagent-control'
- name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'
```

This package takes no configuration: the root plugin provides `send_message` and `interrupt_agent`, and the list plugin provides `list_agents`.

### send_message

Sends a message to another Team member by `name`. The caller must be the live root or a resident continuable subagent. A working target receives Steer input at its next step; an inactive target starts or resumes a turn. Cold ancestors resume under their recorded parents without receiving the target’s message. Success returns inbox acceptance (`messageId`), never a reply. Self, unrelated trees, unsupported targets, unknown names, unavailable history, and rejected admission return errors.

### interrupt_agent

`name` identifies a descendant. External executions stop permanently and cannot receive follow-ups. Local targets stop only their current turn: queued messages stay parked until a later `send_message`, descendants keep running, and the child stays available for follow-ups. The call returns when the stop request is accepted, not when the target is quiet; interrupting an already-finished agent is an accepted no-op, and self, sibling, stale, and non-ancestor callers get errored results.

### list_agents

Lists the root and all reachable continuable descendants, including the caller, in stable pre-order. Descendant rows carry their direct parent id and depth from the root. Live status is `running` or `inactive`. External entries are omitted without reading child Sessions; readable one-shot children remain traversal nodes. Unknown modes and unreadable catalogs produce diagnostics. Ordinary Session forks lead separate Teams.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains what the tools delegate to the subagent service; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

Thin adapters resolve names through `ctx.subagents.resolveName()` before calling `sendMessage()` or `interrupt()`. Residency, cold resume, and authorization belong to the service. Tools pass the exact live calling Agent (`exec.agent`) as sender and authority.

### Delivery and signal ownership

The execution signal owns work only until inbox acceptance. Accepted messages cannot be cancelled through this tool. Every message is framed as `Agent <sender-name> sent a message:` and recorded with `{ kind: 'agent-message', form: 'relay', senderSessionId: sender.id }`. Tree membership authorizes communication; the target’s actual parent still owns restoration and disposal.

### Listing projection

`list_agents` resolves the caller’s live root and traverses its catalogs without a cursor, refining activity through the live Agent registry. Unknown modes remain traversable with diagnostics; unreadable catalogs stop that branch. Sessions absent from reachable catalogs cannot be discovered.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `send_message` and `interrupt_agent` registration |
| [`src/list-agents.ts`](src/list-agents.ts) | Whole-Team discovery and activity projection |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the tool schemas to the continuation service behind them.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — continuable children, activations, inbox, interrupt, and follow-up authority.
- [dsh-tool-subagent](../tool-subagent/README.md) — the delegation tool that starts continuable children.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent-control) — the three tool schemas.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The generated [schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent-control): `send_message` takes `name` and `message`; `interrupt_agent` takes `name`; `list_agents` takes no arguments. The root is `lead`; descriptions may repeat. Older unnamed agents have stable `legacy:<session-id>` addresses.

#### Token effect

Fixed schema cost per request, independent of the number or descriptions of children.

#### KV Cache effect

Prefix-stable; the schemas do not change at runtime, and a parent and its continuable children, including fork children, receive identical definitions.

### Interrupt result

#### What the model sees

`interrupt requested for agent <name>` on acceptance. An unknown name or unauthorized caller — self, sibling, stale, or non-ancestor — returns an error; a known settled target still renders the acceptance line.

#### Token effect

One short acknowledgement per call; the interrupted turn's abort is visible only in the child's own transcript.

#### KV Cache effect

Append-only; each result follows the reusable request prefix.

### Delivery result

#### What the model sees

`message delivered to agent <name>` on acceptance; canonical output carries the accepted `messageId`. A target outside the caller’s Team or rejected admission produces an errored result.

#### Token effect

One short acknowledgement per call; replies arrive as separately addressed messages. Use names from `list_agents` for follow-ups across the Team.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Listing result

#### What the model sees

The first row is `<name> [<status>] — team lead`. Each continuable descendant follows as `<name> [<status>] parent=<name> depth=<n> — <label>`. The root has `kind: root`; descendants have `kind: child` relative to that root. Diagnostics render `<name> [diagnostic: <reason>] parent=<name> depth=<n>`. Status describes turn activity, not task completion.

#### Token effect

Grows linearly with the whole Team’s listed rows. There is no cursor or cap.

#### KV Cache effect

Append-only; each result follows the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the control tools cannot observe or steer; they are current package constraints.

- **A delivered message has no independent result** — acceptance returns only its inbox `messageId`; later target work lands in that target's durable Session and is never collected through this tool. A reply is another explicitly addressed `send_message`, not this call's result.
- **Messaging requires a live sender tree** — the root and the sender’s ancestors must remain live. Cold targets and their continuable ancestors can resume within that tree; each restored activation consumes the shared capacity. Unrelated trees and external or one-shot targets cannot receive messages.
- **Listing is a snapshot, not a delivery promise** — it may race publication, disposal, or a later message, and another process may activate a child this process reports as `inactive`; cross-process accuracy requires a shared lease. `interrupt_agent` performs the authoritative live-lineage check itself, so discovery staleness cannot grant authority.
- **No pagination or deletion** — the complete stably ordered set is returned, and persisted children remain listed for as long as their sessions remain in persistence; a service-level bound or delete operation is a later product decision.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
