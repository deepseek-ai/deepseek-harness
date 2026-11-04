---
description: "Coordinate subagents through a durable shared task board in Team-enabled Sessions."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-team

English | [中文](README.zh.md)

## Summary

`dsh-agent-team` adds a durable shared task board to an existing subagent tree. Members use standard subagent tools to discover and contact one another. Team adds compare-and-set task ownership. Mount `dsh-tool-agent-team` for task tools. Members share one checkout.

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

New Sessions, including ordinary forks, default to Team mode off. See the [Session-mode upgrade guide](../../../docs/upgrade-guide/v0.2.1-rc.2/session-team-mode/guide.md). Select **Use Agent Teams** in the root Session’s model and reasoning menu. Turning it off hides Team tools and guidance from subsequent steps throughout the tree while retaining tasks and subagents. The saved selection survives restart; a historical task board without a saved selection remains enabled.

Set `defaultEnabled: true` to enable new root Sessions, including ordinary forks, before their first model step. Initialization saves the selection as `team/mode`; a save failure rejects Agent creation. Existing selections take precedence, and resuming a Session never applies the default, including when no selection was saved. Descendants use their live root's mode. The [SDK configuration guide](../../../docs/user/guide/python-sdk.md#enable-team-mode) includes a ready-to-use patch; the standard bundle keeps this option off.

Mode changes take effect without waiting for queued task mutations. Each mutation checks the current mode when it starts: an admitted operation finishes, while queued work is rejected if Team is still off when it starts. Enabling again permits subsequent operations. A failed save leaves an appended selection active; retrying the same selection saves without another mode record.

Add this package when subagents need durable shared task ownership and dependencies. Mount it with `@deepseek-ai/dsh-tool-agent-team` for model tools.

### When to choose it

Choose it when delegated agents must divide and track shared work. Plain subagents suffice when no shared board is needed. Team does not create isolated working directories, coordinate across processes, or automatically release task owners.

### Smallest working setup

<a id="smallest-working-setup"></a>

Mount both Team packages in a composition that already provides continuable subagents, their messaging tools, and durable session storage, such as a profile built on `@deepseek-ai/dsh-base`:

```yaml
# smallest Team addition over a composition with continuable subagents
- name: '@deepseek-ai/dsh-agent-team'
- name: '@deepseek-ai/dsh-tool-agent-team'
```

For example, ask the model to start a subagent to review the diff and track its work on the task board. Configuration fields are optional and validated at startup:

| Field | Default | Meaning |
|---|---|---|
| `maxTasks` | `256` | Maximum non-deleted tasks on the board |
| `defaultEnabled` | `false` | Save Team mode on for new roots without an existing selection |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-agent-team) is the exhaustive source for every accepted field and its JSDoc. A row that sets `maxMembers`, `maxMessageBytes`, or `disposalTimeoutMs` does not activate, and dsh names the key in its startup warning; the [upgrade guide](../../../docs/upgrade-guide/v0.2.1-rc.2/agent-team-subagents/guide.md) lists the replacements.

### Teammates

Ask the Lead to start a subagent with a `description` of its work: `subagent` starts fresh, while `subagent_fork` inherits completed turns. The returned name, such as `reviewer`, addresses the teammate; pass `name` to choose it. Names are unique among one creator's children, while descriptions may repeat.

Every root agent and its descendants form one Team. Task assignment accepts the root or any reachable continuable descendant discovered by the subagent runtime, at any depth. Historical roster records remain readable but grant no assignment authority.

### Messages between teammates

Members use standard `list_agents` to discover the tree and `send_message` to contact another member by name. The subagent runtime owns routing, sender attribution, and cold restoration.

### Shared task board

Any member can add a task with a title, details, optional dependencies on other tasks, and optional hints about which files it will touch. A task is claimable only when everything it depends on is complete.

A member claims a task to start work, completes it, releases it, or reopens it. The root can reassign a task to itself or any reachable continuable descendant. Other members claim tasks themselves. Every change is compare-and-set, so stale updates cannot overwrite newer work.

File hints produce warnings when two in-progress tasks plan to touch overlapping paths — they never block anything. Deleted tasks remain in history but disappear from the active list.

### Waiting and interruption

The standard `wait_agent` tool waits for the exact caller’s next-step inbox and works without Team mode; see [subagent controls](../../subagent/tool-subagent-control/README.md#wait_agent). Task changes and Team mode changes do not end waits, add inbox input, or start idle Agents. Use `send_message` when an Agent needs to act on an update.

An ancestor stops a descendant’s current turn with the standard `interrupt_agent` tool. Interruption keeps unclaimed queued messages and leaves task ownership unchanged.

### What success and failure look like

Success returns the committed task revision. Unknown owners, unready tasks, stale revisions, unauthorized mutations, and exhausted task limits report typed errors.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the service and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The service is built on four commitments:

- **One tree identity.** The subagent runtime resolves the root and discovers descendants; Team maintains no second membership authority.
- **Durable log, derived state.** The Lead log owns tasks and child catalog facts; each target Agent owns accepted messages.
- **Explicit authority.** Every service method takes the exact live calling `Agent`; a task owner or the Lead mutates a task, and only the Lead reassigns one.
- **Bounds that fail loud.** `maxTasks` is a validated deployment value, and exhaustion reports a typed error instead of reusing an id.

The [inbox-only wait decision](../../../.agents/notes/implemented/simplification/2026-10-29-inbox-only-agent-wait.md) separates task commits from Agent input waiting.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry, configuration validation, and task service registration |
| [`src/task-board.ts`](src/task-board.ts) | Task CAS commands, DAG validation, and derived views |
| [`src/journal.ts`](src/journal.ts) | Serialized Lead-log transactions and commit notification |
| [`src/projection.ts`](src/projection.ts) | Replay of saved mode and task records, publishing the `agentTeam` client view |
| [`src/task-view.ts`](src/task-view.ts) | Pure task readiness and write-overlap derivation shared by the task board and client view |

### Team identity and membership

The subagent service resolves the exact live caller’s root through `subagents.rootOf()`. Intermediate creators may be offline. An ordinary Session fork leads a new tree. Team uses that root Session as the board owner without a separate membership object.

### Task assignees

Reassignment resolves the root or a continuable descendant through the same discovery used by `list_agents`. Historical `team/member` records remain in the Session log and cannot authorize assignment.

### Messages and historical mailbox

Peer messaging, Steer delivery, cold resume, and sender framing belong to the subagent runtime. Historical `team/message/queued` and `team/message/delivered` records and `team-message` sources remain decodable but are never delivered or acknowledged.

### Shared task board

Tasks are complete versioned snapshots. Mutations require `expectedRevision`; stale updates report `TEAM_TASK_STALE_REVISION`. Numeric `task-<n>` ids stay within the safe-integer range. Deleted tasks remain replay tombstones but do not consume `maxTasks` or appear in `listTasks()`. Normalized workspace-relative `writeScopes` warn about overlapping in-progress work without blocking claims or authorizing writes.

### Durability model

Team requires `sessionPersistence` before activation. `Service.init` awaits registration of the `agentTeam` projection before publishing service readiness. The journal retains the returned handle and reads task state through `stateOf(session)`; callers use the Team service rather than registering another reader.

Task mutations honor cancellation before appending `team/task` to the exact live root Session, then await the flush. Cancellation cannot retract an appended record. A failed flush or one with no participating listener raises `TEAM_TASK_PERSISTENCE_UNCONFIRMED` with the task id and revision: the task is already visible, but durability is unknown. Read that task before retrying. Task records remain log-only. No committed task or historical payload generation is rewritten.

The projection ignores historical roster and mailbox records without validating or retaining their payloads. It stores only the task board, saved mode, and recovery metadata. Version-7 checkpoints without `ownerName` remain usable; suffix replay records names from later task events without backfilling historical tasks. Incompatible projection checkpoints rebuild from the unchanged Session log; see the [upgrade guide](../../../docs/upgrade-guide/v0.2.1-rc.3/team-projection/guide.md).

### Disposal

Unloading the service unregisters the projection. The retained handle remains readable and folds Session events on demand while admitted work settles. Team owns no Agent: teammates remain under the subagent runtime, which owns their capacity, settlement, and teardown.

### Browser projection

The `agentTeam` projection publishes non-deleted task views and any failure beside the last valid state. Historical roster and mailbox records cannot cause a task-board projection failure. A failed projection rejects task reads and mutations without appending task events. Mode selections can still be saved and applied, including disabling Team; the projection failure remains visible. Invalid mode payloads retain the last valid selection and publish a projection failure. The [subsystem reference](../../../docs/subsystems/agent-team.md#web-projection) defines the wire types.

The [Web UI](../../client/ui-agent-team/README.md) displays tasks only. Ordinary subagent navigation owns the member list; task owner labels display the owner's full name, or its Session id when the owner has no name.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared subsystem types to the tool surface and the decisions behind the design.

- [Agent Teams subsystem](../../../docs/subsystems/agent-team.md) — durable Team types and the `ctx.agentTeams` service API.
- [tool-agent-team package](../tool-agent-team/README.md) — task tools and shared-board policy.
- [Subagent runtime](../../subagent/subagent/README.md) — continuable children, messaging, interruption, and lifecycle that teammates use.
- [Subagent teammates Agent Note](../../../.agents/notes/implemented/architecture/2026-10-15-agent-teams-as-subagents.md) — why teammates are subagents and what Team keeps.
- [Upgrade guide](../../../docs/upgrade-guide/v0.2.1-rc.2/agent-team-subagents/guide.md) — replacements for the removed Team tools, service methods, and configuration keys.

-----

<a id="model-experience"></a>
## Model Experience

### Task views and errors

#### What the model sees

The model reads task views through task-tool results. Host views and the durable task record identify owners by `ownerId`, a Session id, and retain the immutable full name in optional `ownerName`. Claim and reassignment save both fields together; release, reopening, and unassignment clear both. Historical tasks without `ownerName` display `ownerId`; [task tools](../tool-agent-team/README.md) show the owner's name to the model. Stale updates report the current revision. Task updates do not end `wait_agent`; send an explicit message when a member needs to act on an update.

#### Token effect

Each task result adds a compact task view. Task updates add no inbox messages.

#### KV Cache effect

Task records stay outside model history. Task results append after the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits describe what a team cannot do yet or what needs special operational care. They are current package constraints, not a comparison with other coordination mechanisms.

- **Whole-view broadcasts** — each task change sends the complete non-deleted board to connected browsers.
- **One process** — members can observe shared filesystem edits; this package provides no worktree, remote member, merge, or filesystem lock.
- **Advisory write scopes** — Bash, formatters, code generators, and direct external writers can bypass filesystem version checks; Leads must coordinate ownership and review the final diff.
- **Notices reach live local members only** — cold members are not restored, and idle members remain idle until explicitly resumed.

- **Communication stays within one tree** — members cannot message unrelated Teams; only ancestors can interrupt descendants.
- **Membership needs a live Team root** — members keep their Team role when an intermediate creator finishes or is released; a missing root leaves them without an active Team.
- **No automatic ownership release** — inactivity, interruption, process exit, and failed work do not release a task owner.
- **Historical queued messages stay undelivered** — `team/message/queued` records without a matching delivery remain readable in the Lead log, but no member receives them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative.

#### Future directions

Undecided directions include automatic ownership release and filesystem isolation via worktrees; neither is committed.

</details>
