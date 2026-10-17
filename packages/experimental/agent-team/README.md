---
description: "Coordinate subagents through a durable shared task board and change waits in experimental Team compositions."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-team

English | [中文](README.zh.md)

## Summary

`dsh-experimental-agent-team` turns an agent and its subagents into a Team with a durable shared task board. Standard subagent tools create and message teammates by id. Team adds compare-and-set task ownership, progress waits, and a roster for the Web panel. Mount `dsh-experimental-tool-agent-team` for model tools. The package is experimental, and members share one checkout.

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

Add this package when subagents need a shared working directory, durable task board, and change waits. Mount it with `@deepseek-ai/dsh-experimental-tool-agent-team` for model tools.

### When to choose it

Choose it when delegated agents must divide and track shared work in one checkout. Plain subagents suffice when delegated work needs no shared board. Separate working directories, coordination across processes, and automatic task-owner release are unsupported.

### Smallest working setup

<a id="smallest-working-setup"></a>

Mount both Team packages in a composition that already provides continuable subagents, their messaging tools, and durable session storage, such as a profile built on `@deepseek-ai/dsh-base`:

```yaml
# smallest Team addition over a composition with continuable subagents
- name: '@deepseek-ai/dsh-experimental-agent-team'
- name: '@deepseek-ai/dsh-experimental-tool-agent-team'
```

For example, ask the model to start a subagent to review the diff and track its work on the task board. The one limit is optional and validated at startup:

| Field | Default | Meaning |
|---|---|---|
| `maxTasks` | `256` | Maximum non-deleted tasks on the board |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-agent-team) is the exhaustive source for every accepted field and its JSDoc. A row that sets `maxMembers`, `maxMessageBytes`, or `disposalTimeoutMs` does not activate, and dsh names the key in its startup warning; the [upgrade guide](../../../docs/upgrade-guide/v0.2.1-rc.2/agent-team-subagents/guide.md) lists the replacements.

### Teammates

Ask the Lead to start a subagent with a `description` of its work: `subagent` starts fresh, while `subagent_fork` inherits completed turns. The returned Session id addresses the teammate; descriptions are display text and may repeat.

Every root agent leads its own Team, and every live subagent below it, at any depth, receives Team tools. The roster lists the Lead, its direct continuable children, and historical `team/member` records. Deeper descendants work on the same board under their Session ids but have no roster row.

### Messages between teammates

Members use standard `list_agents` to discover the whole Team and `send_message` to contact any other member by Session id. The subagent runtime owns routing, sender attribution, and cold restoration. Team stores no messages; accepted messages follow ordinary Agent persistence.

### Shared task board

Any member can add a task with a title, details, optional dependencies on other tasks, and optional hints about which files it will touch. A task is claimable only when everything it depends on is complete.

A member claims a task to start work, completes it, releases it, or reopens it. The Lead can reassign a task by Session id to itself, a direct continuable child, or an active historical member. Other members claim tasks themselves. Every change is compare-and-set, so stale updates cannot overwrite newer work.

File hints produce warnings when two in-progress tasks plan to touch overlapping paths — they never block anything. Deleted tasks remain in history but disappear from the active list.

### Waiting and interruption

A member can wait for the next Team change — a task update, a member's status change, or a message a member's inbox accepts — instead of polling repeatedly; the wait reports only whether it timed out, and the caller re-reads the current state afterward.

An ancestor stops a teammate's current turn with the standard `interrupt_agent` tool, so only the Lead interrupts its direct teammates. Interruption keeps unclaimed queued messages and leaves task ownership unchanged.

### What success and failure look like

Success returns an updated task revision or a wait result. Unknown member ids, unready tasks, stale revisions, unauthorized mutations, and an exhausted task limit report a `TeamError`, such as `TEAM_TASK_STALE_REVISION`. A caller outside a live Team receives `TEAM_NOT_MEMBER`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the service and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The service is built on four commitments:

- **Membership from lineage.** The live Agent registry and the Lead's subagent catalog define the Team; Team stores no membership record of its own.
- **Durable log, derived state.** The Lead log owns tasks and child catalog facts; each target Agent owns accepted messages.
- **Explicit authority.** Every service method takes the exact live calling `Agent`; a task owner or the Lead mutates a task, and only the Lead reassigns one.
- **Bounds that fail loud.** `maxTasks` is a validated deployment value, and exhaustion reports a typed error instead of reusing an id.

The [subagent teammates Agent Note](../../../.agents/notes/implemented/architecture/2026-10-15-agent-teams-as-subagents.md) owns the membership, roster, and messaging decisions. The [runtime-context identity decision](../../../.agents/notes/implemented/architecture/2026-10-13-team-identity-runtime-context.md) owns model-facing identity.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, removed-key rejection, service registration, change notification |
| [`src/membership.ts`](src/membership.ts) | Lead and teammate resolution through the live Agent registry, and task-assignee lookup |
| [`src/task-board.ts`](src/task-board.ts) | Task CAS commands, DAG validation, and derived views |
| [`src/journal.ts`](src/journal.ts) | Serialized Lead-log transactions and commit notification |
| [`src/projection.ts`](src/projection.ts) | Strict replay of historical roster, tasks, and mailbox records, publishing the `agentTeam` client view |
| [`src/task-view.ts`](src/task-view.ts) | Pure task readiness and write-overlap derivation shared by the task board and client view |
| [`src/activity.ts`](src/activity.ts) | One-shot change waiters and disposal release |

### Team identity and membership

A root Agent whose own log carries no subagent descriptor leads the Team identified by its Session id. `tryMembership()` uses `subagents.rootOf()` and the Agent registry’s runtime ownership; intermediate creators may be offline. An ordinary fork carries at most an inherited descriptor, so it leads a new Team. Membership records only the root, Team id, and role.

### Roster

Task assignment reads the Lead’s existing `subagentCatalog` projection, which excludes inherited catalog facts. Only continuable children and active historical members are assignable. Team retains historical `team/member` records but neither copies nor parses current child catalog records.

### Messages and historical mailbox

Team sends no messages. Routes, Steer delivery, cold resume, and sender framing for `send_message` belong to the subagent runtime. Historical `team/message/queued` and `team/message/delivered` records and `team-message` sources remain decodable; Team never delivers or acknowledges them, so a historical message its target had not recorded stays undelivered.

### Shared task board

Tasks are complete versioned snapshots; every mutation carries `expectedRevision`, and a stale caller receives `TEAM_TASK_STALE_REVISION` instead of overwriting a newer value. Numeric `task-<n>` ids require a safe-integer suffix, and id-space exhaustion reports `TEAM_TASK_LIMIT` instead of reusing the final id. Deleted tasks remain tombstones for replay and id stability but do not consume `maxTasks` or appear in `listTasks()`. `writeScopes` are normalized workspace-relative prefixes; views warn on overlap with in-progress tasks but never block claim or authorize writes. Lead reassignment resolves the root, a direct continuable child, or an active historical member by Session id, and reports `TEAM_MEMBER_NOT_FOUND` for anything else.

### Waiting

`waitForChange()` waits for one task commit, member `agent/status` change, or member `agent/inbox/inserted` edge that occurs after registration, from ten seconds through one hour, and reports only whether it timed out; unloading the service releases current waits. Cancellation preserves an Error reason or reports a non-Error reason through `TEAM_WAIT_ABORTED`. `hasActivePeer()` reports whether another live member is running a turn, which lets `wait_agent` skip a wait that no member can end.

### Durability model

Task mutations append `team/task` to the exact live Lead Session and flush before reporting success or waking waiters. Team events are log-only: they never enter the conversation surface, so derived model history is untouched by coordination records. Session event `seq` and `time` own ordering and timing; snapshots do not duplicate them. Teammate ids and descriptions live in the Lead's `subagent/catalog`, which the subagent runtime writes.

Mailbox projection and checkpoint admission preserve every decoded JSON field of accepted content outside the locally declared validators, including an own `__proto__` key. Local field checks cover `text`, `reasoning`, `image`, and `tool-call`; accepted unknown tags remain opaque. Team projection cache version 6 rebuilds checkpoints from earlier cache versions from the Session log; the Session format version is unchanged.

### Disposal

Unloading the service releases current waits and unregisters the projection. Team owns no Agent: teammates keep running under the subagent runtime, which owns their capacity, settlement, and teardown.

### Browser projection

The `agentTeam` Session projection publishes the Lead and historical roster rows with their phases and errors, non-deleted task views, and any `failure` beside the last valid state. Its `apply` replaces only the touched collection; mailbox-only changes retain the client view reference and produce no frame. The [subsystem reference](../../../docs/subsystems/agent-team.md#web-projection) defines the wire types.

The [Web UI](../client-ui-agent-team/README.md) combines the Lead’s `subagentCatalog` and `agentTeam` projections and overlays activity from Session status. Task creation and updates belong to Team agents through the service and model tools. The `./client` export supplies browser-safe roster, task, and projection types.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared subsystem types to the tool surface and the decisions behind the design.

- [Agent Teams subsystem](../../../docs/subsystems/agent-team.md) — durable Team types and the `ctx.agentTeams` service API.
- [tool-agent-team package](../tool-agent-team/README.md) — the task and wait tools, policy, and identity every member receives.
- [Subagent runtime](../../subagent/subagent/README.md) — continuable children, messaging, interruption, and lifecycle that teammates use.
- [Subagent teammates Agent Note](../../../.agents/notes/implemented/architecture/2026-10-15-agent-teams-as-subagents.md) — why teammates are subagents and what Team keeps.
- [Upgrade guide](../../../docs/upgrade-guide/v0.2.1-rc.2/agent-team-subagents/guide.md) — replacements for the removed Team tools, service methods, and configuration keys.
- [Experimental package reference](../AGENTS.md) — placement, publication, and dependency isolation.

-----

<a id="model-experience"></a>
## Model Experience

### Task views and errors

#### What the model sees

The model sees Team state through task-tool results; coordination events never enter the conversation. Task views identify their owner through `ownerId`. Failures surface as tool errors with the `TeamError` message, including the current revision for stale updates.

#### Token effect

The domain adds no context of its own; each task-tool result costs one compact task view per returned task. Policy, identity, and tool schemas belong to `@deepseek-ai/dsh-experimental-tool-agent-team`.

#### KV Cache effect

Task commits append only log-only events to the Lead Session, so they never change any member's request prefix; task results append after it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits describe what a team cannot do yet or what needs special operational care. They are current package constraints, not a comparison with other coordination mechanisms.

- **Whole-view broadcasts** — each roster or task change sends the complete roster and non-deleted task board, including descriptions, to every connected browser, even when it is viewing another Session.
- **Experimental prototype with no stability promise** — the package is public, but its contracts can change freely while it incubates.
- **One process and one shared checkout** — members share cwd and observe edits immediately; this package provides no worktree, remote member, merge, or filesystem lock.
- **Advisory write scopes** — Bash, formatters, code generators, and direct external writers can bypass filesystem version checks; Leads must coordinate ownership and review the final diff.
- **Roster covers direct continuable children** — deeper descendants share tasks and waits but have no roster row; they can claim tasks under their own ids.

- **Communication stays within one tree** — members cannot message unrelated Teams; only ancestors can interrupt descendants.
- **Membership needs a live Team root** — members keep their Team role when an intermediate creator finishes or is released; a missing root leaves them without an active Team.
- **No automatic ownership release** — inactivity, interruption, process exit, and failed work do not release a task owner.
- **Historical queued messages stay undelivered** — `team/message/queued` records without a matching delivery remain readable in the Lead log, but no member receives them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative.

#### Promotion

Promotion to a product-role group requires reviewing the public contract, limitations, test evidence, release payload, runtime dependents, and a named stable owner, per the [experimental subtree rules](../AGENTS.md).

#### Future directions

Undecided directions include nested Teams, automatic ownership release policies, and filesystem isolation via worktrees; none of these are committed.

</details>
