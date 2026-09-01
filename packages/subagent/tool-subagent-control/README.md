---
description: "Global send_message, interrupt_agent, and list_agents tools for users and maintainers composing or debugging continuable-child control."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-subagent-control

English | [中文](README.zh.md)

## Summary

`dsh-tool-subagent-control` adds the global control tools for continuable children: `send_message` delivers a follow-up message that becomes the child's next turn, `interrupt_agent` stops a child's current turn while keeping its queue and descendants intact, and `list_agents` (from the separately loadable `list-agents` plugin) lists continuable children by durable id and label. The tools are global, so any number of delegation tools never duplicates them. These tools cover only the parent-to-child direction; the child-to-parent direction belongs to the independently installed `dsh-tool-subagent-report`. No tool's presence decides whether a delegation tool starts continuable work.

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
    backgroundMode: continuable
- name: '@deepseek-ai/dsh-tool-subagent-control'
- name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'
```

This package takes no configuration: the root plugin provides `send_message` and `interrupt_agent`, and the list plugin provides `list_agents`.

### send_message

Sends a message that becomes the child's next FIFO turn: a working child finishes its current turn first, so a message cannot redirect work already underway. The call returns only acceptance (the accepted message's stable `messageId`), never the child's reply — the child's transcript by its id is the source of what it did. A failure — an unauthorized or unknown child, a descriptor-less child that cannot be resumed, or rejected admission — states the message was not delivered.

### interrupt_agent

Stops only the target's current turn: queued messages stay parked until a later `send_message`, descendants keep running, and the child stays available for follow-ups. The call returns when the stop request is accepted, not when the target is quiet; interrupting an already-finished agent is an accepted no-op, and self, sibling, stale, and non-ancestor callers get errored results.

### list_agents

Lists the continuable children below the calling agent: `children` (default) shows direct children, `descendants` walks the whole tree in stable pre-order, annotating each entry with its durable direct-parent session id and depth. Status comes from the live Agent registry — `running`, `idle`, or `ready`. One-shot children are intentionally absent because they cannot accept `send_message`, and unreadable candidates appear as diagnostics.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains what the tools delegate to the subagent service; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

Thin adapters over `ctx.subagents.followup()`, `interrupt()`, and the list projections; the tools perform no lifecycle routing. Residency, cold resume, and interrupt authorization belong to the service, and the tools pass the exact live calling agent (`exec.agent`) as the authority the service verifies against the target's recorded lineage.

### Delivery and signal ownership

The tool forwards its execution signal, which owns admission only until inbox acceptance. Once the child accepts a message, the accepted turn cannot be cancelled through this tool. Every message is recorded with the coordinator source `{ kind: 'coordinator', senderSessionId: parent.id }`, which the service retains but never treats as authority.

### Listing projection

`list_agents` derives the root id from the calling agent, reads the service catalog without a cursor, refines each candidate's status through the live Agent registry, and omits one-shot children because they cannot accept `send_message`. Diagnostics keep their positions in the descendants scope and never expose descriptor contents.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `send_message` and `interrupt_agent` registration |
| [`src/list-agents.ts`](src/list-agents.ts) | `list_agents` registration: scopes, status refinement, projection |
| — | No runtime invariant companion is published; this model-facing adapter has no independent lifecycle stream; delivery and activation relations are owned by the subagent service it calls. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the tool schemas to the continuation service behind them.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — continuable children, activations, inbox, interrupt, and follow-up authority.
- [dsh-tool-subagent](../tool-subagent/README.md) — the delegation tool that starts continuable children.
- [dsh-tool-subagent-report](../tool-subagent-report/README.md) — the child-to-parent report channel.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent-control) — the three tool schemas.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The generated [schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent-control): `send_message` takes `subagent_id` and `message`; `interrupt_agent` takes `agent_id`; `list_agents` takes the optional `scope` enum.

#### Token effect

Fixed schema cost per parent request.

#### KV Cache effect

Prefix-stable; the schema does not change at runtime.

### Interrupt result

#### What the model sees

`interrupt requested for agent <agent_id>` on acceptance. An unauthorized caller — self, sibling, stale, or non-ancestor — is an errored result naming the rejection; an absent or settled target still renders the acceptance line.

#### Token effect

One short acknowledgement per call; the interrupted turn's abort is visible only in the child's own transcript.

#### KV Cache effect

Append-only; each result follows the reusable request prefix.

### Delivery result

#### What the model sees

`message queued as the next turn for subagent <subagent_id>` on acceptance; the canonical output carries the accepted `messageId`. A failure — an unauthorized or unknown child, a descriptor-less child that cannot be resumed, or admission rejected — is an errored result whose message states the message was not delivered.

#### Token effect

One short acknowledgement per call; the child's response never returns through this call. A separately granted `report` may append selected content to parent history.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Listing result

#### What the model sees

One line per continuable child in stable catalog order: `<id> [<status>] — <label>` (`running` = active driver, `idle` = resident between turns, `ready` = storage only, resumable rather than terminal), plus `<id> [diagnostic: <reason>]` for a candidate that could not be read. The `descendants` scope inserts ` parent=<id> depth=<n>` before the label dash on every line, in pre-order. One-shot children are intentionally absent; `(no subagents)` means no continuable child or diagnostic survived the projection.

#### Token effect

Grows linearly with the listed continuable children — the whole tree under the `descendants` scope; there is no cursor or cap, so long-lived parents with many persisted children pay the full list each call.

#### KV Cache effect

Append-only; each result follows the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the control tools cannot observe or steer; they are current package constraints.

- **A queued message has no independent result** — acceptance returns only its inbox `messageId`; the child's work lands in the durable child Session and is never collected through this tool. A child granted `report` may send selected content back separately, but that message is not this call's result.
- **No steering of the current turn** — every message opens a later FIFO turn, so a message sent while the child is working runs only after its current turn finishes and cannot redirect it.
- **Listing is a snapshot, not a delivery promise** — it may race publication, disposal, or a later message, and another process may activate a child this process reports as `ready`; cross-process accuracy requires a shared lease. `interrupt_agent` performs the authoritative live-lineage check itself, so discovery staleness cannot grant authority.
- **No pagination or deletion** — the complete stably ordered set is returned, and persisted children remain listed for as long as their sessions remain in persistence; a service-level bound or delete operation is a later product decision.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
