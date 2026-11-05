---
description: "Discover and coordinate a subagent tree through messaging, interruption, and inbox waiting."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-subagent-control

English | [中文](README.zh.md)

## Summary

`dsh-tool-subagent-control` lets agents discover and message their subagent tree by name, interrupt descendants, and wait for their own next-step inbox. By default, one plugin instance registers all four tools; members inherit the same definitions and ordering.

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

Sends a message to another agent in the same subagent tree. `agent` takes a name from `list_agents`: `lead` for the root or a full name such as `reviewer/checker`. Text that is not a name in the tree is treated as a Session id, so Session ids also work, including for members listed by Session id. The caller must be the live root or a resident continuable subagent. A working target receives Steer input at its next step; an inactive target starts or resumes a turn. Only the target resumes; its creation ancestors stay offline. Success returns inbox acceptance (`messageId`), never a reply. Self, unrelated trees, unsupported targets, unknown names or ids, unavailable history, and rejected admission return errors.

### interrupt_agent

`agent` names a descendant the same way `send_message` names its target. External executions stop permanently and cannot receive follow-ups. Local targets stop only their current turn: queued messages stay parked until a later `send_message`, descendants keep running, and the child stays available for follow-ups. The call returns when the stop request is accepted, not when the target is quiet; interrupting an already-finished agent is an accepted no-op, and self, sibling, stale, and non-ancestor callers get errored results.

<a id="wait_agent"></a>
### wait_agent

Waits for the exact caller’s next-step inbox. Pending input returns immediately unless an earlier wait in the same model tool call already reported it, so repeated waits from one `run_code` program block until new input or timeout; later input, including messages, completion notifications, and user steering, ends the wait. Queued next-turn messages, unrelated inboxes, and Agent status changes do not end it. Task changes do not end the wait. The tool neither consumes input nor starts an Agent. `timedOut: false` means new input is pending. Pending input is delivered to the model after code execution finishes. `timeout_ms` defaults to 30000 and must be an integer from 10000 through 3600000. Results contain only `timedOut`; cancellation, caller disposal, or plugin unload rejects the wait.

### list_agents

Lists the root and all reachable continuable descendants, including the caller, in stable pre-order. Each row carries a `name`, a `status`, and, for the root and continuable descendants, a `description`. The root is `lead` with the description `root agent`; a descendant's name is its full path from the root and its description is its creation label. A child whose catalog entry has no name, and every descendant below it, is listed by Session id. Live status is `running` or `inactive`. External entries are omitted without reading child Sessions; readable one-shot children remain traversal nodes. Unknown modes and unreadable catalogs produce rows whose status is `unsupported`, `corrupt`, or `unavailable`; the status reports that the row's own descendants could not be read, while the row itself stays an addressable member. Ordinary Session forks lead separate subagent trees.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains what the tools delegate to the subagent service; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

Messaging, interruption, and discovery delegate to `ctx.subagents`; residency, cold resume, and authorization belong to that service. Messaging and interruption first map `agent` to a Session id through `ctx.subagents.resolveName()`, which grants no authority; the service then authorizes that Session id. The wait tool subscribes to the exact caller’s inbox events before starting the timer and checking pending next-step input, and removes its listeners and timer on every settlement. Each successful wait records, per Agent, the pending ids it reported and its root tool call; a later wait from the same root call ignores those ids.

### Delivery and signal ownership

The execution signal owns work only until inbox acceptance. Accepted messages cannot be cancelled through this tool. Every message is framed as `Agent <sender-name> sent a message:` and recorded with `{ kind: 'agent-message', form: 'relay', senderSessionId: sender.id }`. Tree membership authorizes communication; the subagent tree root owns runtime instances and capacity.

### Listing projection

`list_agents` resolves the caller’s live root and traverses its catalogs without a cursor, refining activity through the live Agent registry. Names come from the `path` of each `listDescendants()` row. Unknown modes remain traversable with diagnostics; unreadable catalogs stop that branch. Sessions absent from reachable catalogs cannot be discovered.

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

The generated [schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent-control) define name-addressed messaging and interruption, whole-tree discovery, and inbox waiting with `timeout_ms`. `wait_agent` returns `{ "timedOut": false }` for available input, and `{ "timedOut": true }` on timeout. It returns no message body or peer-activity diagnosis.

#### Token effect

Fixed schema cost per request, independent of the number or descriptions of children; disabling interruption removes its schema and discovery guidance.

#### KV Cache effect

Prefix-stable; the schemas do not change at runtime, and a parent and its continuable children, including fork children, receive identical definitions.

### Identity and communication context

#### What the model sees

Required `subagent:identity` runtime context identifies each agent by name. It is independent of Team mode and tool filtering. When the live root is available, identity context includes messaging and discovery instructions independently for each admitted standard tool. The root sees `You are the root agent. Your name is "lead".` followed by the same guidance. A missing live root is reported with the agent's Session id, without preventing independent work. Automatic result delivery remains owned by the subagent service. A child of the root named `reviewer`, with both tools admitted, sees:

##### Subagent identity

```markdown
You are a subagent delegated by agent "lead".
Your name is "reviewer".
The root agent of your collaboration tree is "lead".

To message other agents, use send_message({ agent: "<agent-name>", message: "..." }).
Use list_agents({}) to find your collaborator agents and their names.
```

#### Token effect

One short context entry per agent, independent of tree size; full names lengthen with nesting depth.

#### KV Cache effect

Identity and communication guidance follow inherited history as logged runtime context, leaving the shared system prompt and tool definitions unchanged. When a retained snapshot's identity text differs from the current text, one current runtime-context snapshot is appended. This required context remains available with `includeRuntimeContext: false` and is restored after compaction. Team mode does not change it.

### Interrupt result

#### What the model sees

`interrupt requested for agent <agent>` on acceptance, echoing the `agent` argument. An unauthorized caller — self, sibling, stale, or non-ancestor — is an errored result naming the rejection; an absent or settled target still renders the acceptance line.

#### Token effect

One short acknowledgement per call; the interrupted turn's abort is visible only in the child's own transcript.

#### KV Cache effect

Append-only; each result follows the reusable request prefix.

### Delivery result

#### What the model sees

`message delivered to agent <agent>` on acceptance, echoing the `agent` argument; canonical output carries the accepted `messageId`. A target outside the caller’s subagent tree or rejected admission produces an errored result.

#### Token effect

One short acknowledgement per call; replies arrive as separately addressed messages. Use names from `list_agents` for follow-ups across the subagent tree.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Listing result

#### What the model sees

Each row renders as `<name> [<status>] — <description>`, or `<name> [<status>]` without a description. The first row is `lead [<status>] — root agent`; continuable descendants follow, such as `reviewer/checker [inactive] — Check the diff`. Unreadable branches render as `<name> [corrupt]`, `<name> [unsupported]`, or `<name> [unavailable]`. The canonical value is an array of `{ name, status, description? }`. Status describes turn activity, not task completion, success, or failure.

#### Token effect

Grows linearly with the whole subagent tree’s listed rows. There is no cursor or cap. Rows carry no parent ids or depth; a full name encodes both.

#### KV Cache effect

Append-only; each result follows the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the control tools cannot observe or steer; they are current package constraints.

- **A delivered message has no independent result** — acceptance returns only its inbox `messageId`; later target work lands in that target's durable Session and is never collected through this tool. A reply is another explicitly addressed `send_message`, not this call's result.
- **Messaging requires a live subagent tree root** — intermediate creators may be offline. Only the target resumes, consuming one shared capacity slot. Unrelated trees and external or one-shot targets cannot receive messages.
- **Listing is a snapshot, not a delivery promise** — it may race publication, disposal, or a later message, and another process may activate a child this process reports as `inactive`; cross-process accuracy requires a shared lease. `interrupt_agent` performs the authoritative live-lineage check itself, so discovery staleness cannot grant authority.
- **Edits to reported input do not end a wait** — replacing a pending message keeps its id, so within the same model tool call a wait that already reported it stays pending; the edited content still reaches the model at the next step.
- **No pagination or deletion** — the complete stably ordered set is returned, and persisted children remain listed for as long as their sessions remain in persistence; a service-level bound or delete operation is a later product decision.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
