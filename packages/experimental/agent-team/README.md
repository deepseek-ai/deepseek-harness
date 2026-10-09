---
description: "Run named teammates with direct inbox messages and a durable shared task board in experimental Team compositions."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-team

English | [中文](README.zh.md)

## Summary

`dsh-experimental-agent-team` gives one session a Lead, named teammates, direct messages, and a durable shared task board. Sends use each target Agent’s inbox and can cold-resume stored teammates. Team retains roster and task state; message persistence follows the target Agent’s normal policy. Mount `dsh-experimental-tool-agent-team` for model tools. The package is experimental and requires durable session storage.

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

Add this package when one agent needs named helpers in a shared working directory, direct peer messages, and durable roster and task state. Mount it with `@deepseek-ai/dsh-experimental-tool-agent-team` to expose the model tools.

### When to choose it

Choose it for cooperation in one shared workspace with durable roster and task state. Separate working directories, coordination across processes, and automatic task-owner release are unsupported. Durable session storage is required.

### Smallest working setup

<a id="smallest-working-setup"></a>

The smallest addition to an existing composition is durable session storage plus both Team packages:

```yaml
# smallest team setup — durable storage plus both Team packages
- name: '@deepseek-ai/dsh-session-persistence-jsonl'
- name: '@deepseek-ai/dsh-experimental-agent-team'
- name: '@deepseek-ai/dsh-experimental-tool-agent-team'
```

With the tools installed, the model does the rest on request — for example, "create a teammate named reviewer to check the diff", then "send reviewer the change summary". All limits are optional and validated at startup:

| Field | Default | Meaning |
|---|---|---|
| `maxMembers` | `16` | Maximum teammates a team may ever create, including failed ones |
| `maxTasks` | `256` | Maximum active tasks on the board |
| `maxMessageBytes` | `65,536` | Maximum size of one sent message |
| `disposalTimeoutMs` | `5,000` | Time allowed for shutdown cleanup |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-agent-team) is the exhaustive source for every accepted field and its JSDoc.

### Teammates

Ask the Lead to create a teammate: give it a unique lowercase name such as `reviewer` and describe its job. A teammate starts fresh with no memory of the Lead's conversation, or as a fork that inherits the Lead's completed turns; the creation request chooses which. Teammate names are permanent — even a teammate whose creation failed keeps its name, and no name is ever reused.

The roster shows every member with its role (`lead` or `teammate`) and current status: `running`, `inactive` (no turn is executing, whether loaded or stored), `provisioning`, or `failed`. A member that is not loaded receives its messages when it wakes.

Only the Lead can create teammates or interrupt them.

### Messages between teammates

Any member can send to another member or the Lead. Each attempt either returns the target inbox `MessageId` or throws. Team does not retain unaccepted send intent, retry new messages after restart, or deduplicate explicit resends.

Steer gives a running target the message at its nearest step boundary and starts or cold-resumes an inactive target. Success means inbox acceptance, not model processing or a separate synchronous storage flush. Accepted messages follow ordinary Agent persistence and inbox recovery.

### Shared task board

Any member can add a task with a title, details, optional dependencies on other tasks, and optional hints about which files it will touch. A task is claimable only when everything it depends on is complete.

Tasks have an owner: a member claims a task to start work, completes it when done, releases it back, or reopens it; the Lead can assign a task to any member. Every change is compare-and-set: an update based on an outdated copy is rejected, so two members cannot silently overwrite each other's work.

File hints produce warnings when two in-progress tasks plan to touch overlapping paths — they never block anything. Deleted tasks remain in history but disappear from the active list.

### Waiting and interruption

A member can wait for the next team change — a teammate's status, an incoming message, or a task update — instead of polling repeatedly; the wait reports only whether it timed out, and the caller re-reads the current state afterward.

The Lead can stop a teammate's current turn without deleting its queued messages; task ownership is unchanged.

### What success and failure look like

Success returns a teammate roster row, an accepted inbox message id, or an updated task revision. Invalid member names, unready tasks, stale revisions, exhausted limits, and failed message admission report errors.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the service and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The service is built on one separation and three commitments:

- **Durable log, derived state.** The Lead log owns roster and tasks; each target Agent owns its accepted messages.
- **Process-local ownership.** Continuation delivery owns target locking, cold recovery, and lifecycle authorization.
- **Explicit authority.** Every service method takes the exact live calling `Agent`; only the Lead spawns, reassigns, or interrupts.
- **Bounds that fail loud.** Every limit is a validated deployment value, and exhaustion reports a typed error instead of reusing an id or name.

The [Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.md) owns the identity, mailbox, task, and shared-checkout decisions.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, service registration, recovery scheduling |
| [`src/roster.ts`](src/roster.ts) | Team identity, membership resolution, provisioning, and roster teardown |
| [`src/task-board.ts`](src/task-board.ts) | Task CAS commands, DAG validation, and derived views |
| [`src/journal.ts`](src/journal.ts) | Serialized Lead-log transactions and commit notification |
| [`src/projection.ts`](src/projection.ts) | Strict replay projection that decodes and validates Team events and publishes the `agentTeam` client view |
| [`src/task-view.ts`](src/task-view.ts) | Pure task readiness, owner-name, and write-overlap derivation shared by the task board and the client view |
| [`src/activity.ts`](src/activity.ts) | One-shot change waiters and disposal release |
| [`src/lifecycle.ts`](src/lifecycle.ts) | Shared admission cutoff and bounded settlement |

### Team identity and roster

Every ordinary runtime root is the implicit Lead of a Team whose `TeamId` equals its `SessionId`; there is no creation event, and durable Team state begins with the first member or task record. `spawnTeammate()` first appends and flushes a `provisioning` member record, then asks the configured provider to create the reserved child; a provider failure appends a durable `failed` member. A fresh child starts with no Lead history; a fork child captures the Lead's completed-turn prefix once. Recovery reconciles an unterminated provisioning record against the child's independently persisted Session: a matching direct-parent and continuable descriptor plus a recorded initial user message produces `active`, and anything else produces `failed`. If recovery wins a same-process race, the creator accepts the terminal state or reports `TEAM_PROVISIONING_CONFLICT` and drains the child. Names are reserved by the first provisioning record and never reused.

### Direct messages and historical compatibility

`sendMessage()` checks exact caller membership, rejects self-messaging, and bounds the complete sender-framed UTF-8 content. It returns the existing inbox identity and emits Team activity only after acceptance. The target stores `agent-message` source with the actual `senderSessionId`; the first content block is `Team message from <name>:`. No new `team/message/queued` or `team/message/delivered` records are written for these sends. Team adds no per-target send ordering; delivery order belongs to the target inbox. The client presents these messages with the ordinary Agent title and icon; the message body retains the sender name.

Lead delivery calls `Agent.steer()` directly. Teammate delivery uses the continuation owner's host-only Steer path, which preserves the Team sender source while authorizing the Lead-to-child edge and cold-resuming inactive targets. Sibling messages never impersonate the Lead through the public adjacent-Agent messaging operation.

### Shared task board

Tasks are complete versioned snapshots; every mutation carries `expectedRevision`, and a stale caller receives `TEAM_TASK_STALE_REVISION` instead of overwriting a newer value. Numeric `task-<n>` ids require a safe-integer suffix, and id-space exhaustion reports `TEAM_TASK_LIMIT` instead of reusing the final id. Deleted tasks remain tombstones for replay and id stability but do not consume `maxTasks` or appear in `listTasks()`. `writeScopes` are normalized workspace-relative prefixes; views warn on overlap with in-progress tasks but never block claim or authorize writes.

### Waiting and interruption

`waitForChange()` waits for one roster, task, message-acceptance, or live-status edge that occurs after registration, from ten seconds through one hour, and reports only whether it timed out; runtime disposal releases current waits. Cancellation preserves an Error reason or reports a non-Error reason through `TEAM_WAIT_ABORTED`. `interrupt()` is Lead-only and delegates to the continuable-subagent interrupt path, which cancels only a live teammate's current turn with `keepInbox`; it neither releases task ownership nor deletes durable mail.

### Durability model

Roster and task mutations append `team/member` and `team/task` to the exact live Lead Session and flush before reporting success or waking waiters. Historical `team/message/queued` and `team/message/delivered` records remain readable; Team writes neither. All four event types are log-only: they never enter the conversation surface, so derived model history is untouched by coordination records. Session event `seq` and `time` own ordering and timing; snapshots do not duplicate them.

Historical mailbox events and `team-message` sources remain readable, and the projection still reports queued-minus-delivered records. Team never delivers or acknowledges them: a historical message that its target had not recorded stays undelivered.

Mailbox projection and checkpoint admission preserve every decoded JSON field of accepted content outside the locally declared validators, including an own `__proto__` key. Local field checks cover `text`, `reasoning`, `image`, and `tool-call`; accepted unknown tags remain opaque. Team projection cache version 4 rebuilds checkpoints from earlier cache versions from the Session log; the Session format version is unchanged.

### Disposal

The runtime lifecycle tracks sends and complete creation transactions in one operation set. Disposal closes admission, aborts and awaits those operations, then releases the roster’s live children and descendants. Non-Team children remain untouched. Admitted operations share one `disposalTimeoutMs` settlement deadline; each subsequent Team child drain has its own deadline. This value is not a whole-service shutdown bound. Cleanup failures are reported.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared subsystem types to the tool surface and the decisions behind the design.

- [Agent Teams subsystem](../../../docs/subsystems/agent-team.md) — durable Team types and the `ctx.agentTeams` service API.
- [tool-agent-team package](../tool-agent-team/README.md) — the tools that let the model create, message, and coordinate teammates.
- [Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.md) — identity, mailbox, task, and shared-checkout decisions.
- [Experimental package reference](../AGENTS.md) — placement, publication, and dependency isolation.

-----

<a id="model-experience"></a>

### Browser projection

The `agentTeam` Session projection publishes the Lead Session's durable roster identities and phases, member errors, non-deleted task views, and any `failure` beside the last valid state. Its `apply` replaces only the touched collection; mailbox-only changes retain the client view reference and produce no frame. The [subsystem reference](../../../docs/subsystems/agent-team.md#web-projection) defines the wire types.

The [Web UI](../client-ui-agent-team/README.md) reads the shared Session projections and overlays activity from Session status. Task creation and updates belong to Team agents through the service and model tools. The `./client` export supplies browser-safe roster, task, and projection types.

## Model Experience

### Peer messages

#### What the model sees

Each peer message is a user-role message prefixed with its sender name, followed by the original content blocks. Roster, task, and historical mailbox records remain log-only.

#### Token effect

Each peer delivery adds the sender prefix plus message content to the target history. Task and roster mutations add no model tokens; their model-facing representation belongs to `@deepseek-ai/dsh-experimental-tool-agent-team` results.

#### KV Cache effect

Peer messages append after the target's reusable history prefix. Cold resume reuses the persisted conversation before appending the new message.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits describe what a team cannot do yet or what needs special operational care. They are current package constraints, not a comparison with other coordination mechanisms.

- **Whole-view broadcasts** — each roster or task change sends the complete roster and non-deleted task board, including descriptions, to every connected browser, even when it is viewing another Session.
- **Experimental prototype with no stability promise** — the package is public, but its contracts can change freely while it incubates.
- **One process and one shared checkout** — members share cwd and observe edits immediately; this package provides no worktree, remote member, merge, or filesystem lock.
- **Advisory write scopes** — Bash, formatters, code generators, and direct external writers can bypass filesystem version checks; Leads must coordinate ownership and review the final diff.
- **Flat immutable roster** — only the Lead creates direct teammates; there is no nested Team, rename, deletion, or name reuse.
- **No automatic ownership release** — inactivity, interruption, process exit, and failed work do not release a task owner.
- **No send retry guarantee** — Team does not retain or deduplicate new attempts; concurrent processes over one Team are unsupported. Historical queued messages that never reached their target are not delivered.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative.

#### Promotion

Promotion to a product-role group requires reviewing the public contract, limitations, test evidence, release payload, runtime dependents, and a named stable owner, per the [experimental subtree rules](../AGENTS.md).

#### Future directions

Undecided directions include nested Teams, automatic ownership release policies, cross-process mailbox transactions, and filesystem isolation via worktrees; none of these are committed.

</details>
