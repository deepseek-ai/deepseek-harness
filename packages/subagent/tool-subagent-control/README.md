---
description: "Global send_message, interrupt_agent, and list_agents tools for users and maintainers composing or debugging continuable-child control."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-subagent-control

English | [中文](README.zh.md)

## Summary

`dsh-tool-subagent-control` adds the global control tools for continuable children: `send_message` steers between a parent and child or between siblings, `interrupt_agent` stops a descendant’s current turn while keeping its inbox and descendants intact, and the separately loadable `list-agents` plugin discovers agents by name and description. Parents and continuable children inherit the same tool definitions and ordering.

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

Sends a message to the agent `name`. Any exact live Agent may target its direct continuable child; a resident continuable child may also target its direct parent or continuable siblings. Sibling delivery uses the shared live parent’s authority and preserves the actual sender. A working target receives the message at its nearest step boundary through Steer; an inactive child or sibling starts or resumes a turn. Success returns inbox acceptance (`messageId`), never a reply. An unsupported target, unavailable parent, unknown name, missing descriptor, or rejected admission returns an error.

### interrupt_agent

`name` identifies a descendant. External executions stop permanently and cannot receive follow-ups. Local targets stop only their current turn: queued messages stay parked until a later `send_message`, descendants keep running, and the child stays available for follow-ups. The call returns when the stop request is accepted, not when the target is quiet; interrupting an already-finished agent is an accepted no-op, and self, sibling, stale, and non-ancestor callers get errored results.

### list_agents

Lists all reachable continuable descendants in stable pre-order, with each row’s direct parent name and depth. A continuable subagent with a live parent first sees that parent and its continuable siblings. Live status is `running` or `inactive`. External entries are omitted without reading child Sessions; readable one-shot children are traversal nodes but not output rows. Unknown modes and unreadable child catalogs produce diagnostics. Ordinary Session forks are not catalog entries.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains what the tools delegate to the subagent service; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

Thin adapters resolve names through `ctx.subagents.resolveName()` before calling `sendMessage()` or `interrupt()`. Residency, cold resume, and authorization belong to the service. Tools pass the exact live calling Agent (`exec.agent`) as sender and authority.

### Delivery and signal ownership

The tool forwards its execution signal, which owns admission only until inbox acceptance. Accepted messages cannot be cancelled through this tool. Every message is framed as `Agent <sender-name> sent a message:` and recorded with `{ kind: 'agent-message', form: 'relay', senderSessionId: sender.id }`, including sibling delivery under the parent’s authority. Attribution never grants authority.

### Listing projection

`list_agents` traverses the caller’s catalogs without a cursor and refines status through the live Agent registry. A continuable caller’s live parent catalog supplies the parent and sibling rows. Descendant traversal preserves catalog order; unknown modes remain traversable with diagnostics, while unreadable catalogs stop that branch. Descendants absent from reachable catalogs cannot be discovered.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `send_message` and `interrupt_agent` registration |
| [`src/list-agents.ts`](src/list-agents.ts) | `list_agents` registration: parent, sibling, and child discovery and status refinement |

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

`message delivered to agent <name>` on acceptance; canonical output carries the accepted `messageId`. A target outside the caller’s supported parent, child, and sibling routes, or rejected admission, produces an errored result.

#### Token effect

One short acknowledgement per call; the target’s response never returns through this call. Children use parent and sibling names from `list_agents` for follow-up messages.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Listing result

#### What the model sees

One line per descendant in stable order: `<name> [<status>] parent=<name> depth=<n> — <label>`. A continuable child’s list starts with `<name> [<status>] — your parent`, then `<name> [<status>] — sibling: <label>` rows. Unknown modes or unreadable catalogs produce `<name> [diagnostic: <reason>] parent=<name> depth=<n>`. Status describes turn activity, not task completion. `(no subagents)` means no row survived the projection.

#### Token effect

Grows linearly with the listed rows, including parent and siblings. There is no cursor or cap.

#### KV Cache effect

Append-only; each result follows the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the control tools cannot observe or steer; they are current package constraints.

- **A delivered message has no independent result** — acceptance returns only its inbox `messageId`; later target work lands in that target's durable Session and is never collected through this tool. A reply is another explicitly addressed `send_message`, not this call's result.
- **Messaging requires live lineage** — every sender may target a direct continuable child. A resident continuable child may also target its direct parent and continuable siblings while their parent is live. Deeper descendants and unrelated trees are not message targets; only child and sibling delivery supports cold activation.
- **Listing is a snapshot, not a delivery promise** — it may race publication, disposal, or a later message, and another process may activate a child this process reports as `inactive`; cross-process accuracy requires a shared lease. `interrupt_agent` performs the authoritative live-lineage check itself, so discovery staleness cannot grant authority.
- **No pagination or deletion** — the complete stably ordered set is returned, and persisted children remain listed for as long as their sessions remain in persistence; a service-level bound or delete operation is a later product decision.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
