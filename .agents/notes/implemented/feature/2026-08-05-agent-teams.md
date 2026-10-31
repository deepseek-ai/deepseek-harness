# Agent Note: Durable Agent Teams over continuable children

Status: implemented

English | [中文](2026-08-05-agent-teams.zh.md)

## Problem

The subagent seam supplies fresh/fork providers, durable child Sessions, FIFO follow-ups, and cold-resumable Activations. Its direct-parent controls do not provide peer communication, a stable named roster, or shared task ownership. A coordinator can create several workers, but workers cannot address one another, durable follow-up intent lives only in target inboxes, and no common compare-and-set board prevents stale assignment updates.

All same-process Agents also share one checkout. Filesystem edit tools can reject an observed stale version, but Bash, formatters, generators, and external writers bypass that fence. Treating a teammate name or task owner as a file lock would hide rather than solve this concurrency boundary.

Team collaboration requires explicit opt-in; [Session selection](../architecture/2026-10-20-session-team-mode.md) owns its granularity and default composition. The default tool catalog and simple-task behavior must remain unchanged, while an explicitly requested Team must survive child Activation settlement and mailbox delivery races long enough for the Lead to aggregate the result before process teardown.

## Decision

Every ordinary root and its descendants form the Team identified by the root `SessionId`; durable task state begins with the first task event. [Subagent teammates](../architecture/2026-10-15-agent-teams-as-subagents.md) owns the single agent identity. [Inbox-only waiting](../simplification/2026-10-29-inbox-only-agent-wait.md) keeps task-board changes independent of inbox waiting. An ordinary Session fork leads a new tree and excludes inherited Team authority.

The implementation is split into `@deepseek-ai/dsh-agent-team`, which owns `ctx.agentTeams` and durable semantics, and `@deepseek-ai/dsh-tool-agent-team`, which owns scoped schemas and model guidance. Every Team tool declares its complete result schema and renders that value as compact JSON, so the compiler checks each `execute` against what the model is promised and no result spends tokens on indentation. The base bundle mounts both plugins; Team registers no tool that shares a name with the subagent controls. The shared policy announces Team availability and describes coordination responsibilities. Both packages belong to the [subagent family](../../../../packages/subagent/README.md); the root Session’s saved selection gates the task tools and policy. The [Session-mode upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.2/session-team-mode/guide.md) describes profile migration.

The Lead must wait for required work before its final answer. Process teardown remains the final lifecycle owner and drains continuation Activations; a Team task owner is durable state and is not automatically released by idle, interruption, or process exit.

## Profile delegation

The [base bundle](../../../../packages/bundle/base/README.md) inserts the Team rows and keeps the base delegation and control tools; teammates are started with those tools as described in [subagents](../architecture/2026-10-15-agent-teams-as-subagents.md). Ordinary Session forks retain their history; [current identity handling](../architecture/2026-10-13-team-identity-runtime-context.md) supplies the fork's own role.

## Team identity

Shared system policy and tool schemas stay uniform across members; execution enforces role restrictions. Team tools resolve the caller’s Team and use Session ids as task owners. [Required runtime-context identity](../architecture/2026-10-13-team-identity-runtime-context.md) owns identity injection, retention, and fork handling.

## Provisioning and recovery

Teammate creation and cold resume belong to the subagent runtime ([subagent teammates](../architecture/2026-10-15-agent-teams-as-subagents.md)). Historical `team/member` records remain readable with their phases and descriptions; Team writes no new membership records.

## Mailbox and task transactions

The historical Lead-log mailbox remains readable in original Session logs. The [task-only projection decision](../simplification/2026-10-29-team-task-only-projection.md) supersedes mailbox projection, checkpoint retention, and Team payload validation. Historical queued messages are never delivered or acknowledged.

Member messages use the subagent `send_message` operation, which steers running, idle, and cold targets and returns inbox acceptance.

Shared tasks are complete snapshots with Team-local ids and monotonic revisions. Every mutation carries `expectedRevision`. Any member creates, reads, or claims a ready unowned task; the owner or Lead edits and transitions it, while only the Lead assigns another member. Numeric task ids remain within the safe-integer allocation range, and exhaustion fails without reusing an id. Dependencies must name non-deleted tasks and form a complete DAG. Deleted tasks are retained tombstones. `writeScopes` are normalized path prefixes that produce overlap diagnostics but never block claim or authorize a write.

`wait_agent` belongs to ordinary subagent controls and waits for the exact caller’s next-step inbox, including already-pending input. Task commits do not end waits, deliver messages, or start idle turns. Agents send messages when another member needs to act on a task change. Ancestors may interrupt descendants without changing task ownership.

## Shared checkout boundary

Members start in the Lead’s current directory and observe shared filesystem writes immediately. Later directory changes stay local to each Session. The task policy tells members to claim ready tasks, use advisory write scopes and dependencies, and complete tasks after doing the work. A filesystem stale-version rejection requires rereading and rebasing the intended change. No equivalent guarantee is claimed for Bash, formatters, code generation, or direct external writes.

The Team domain does not infer branches, create worktrees, merge changes, or silently change cwd. A deployment or caller can use [explicit worktree creation](2026-09-13-explicit-worktree-creation.md) separately. This preserves the existing same-world subagent and sandbox contracts.

## Web projection

The Web panel reads the Lead Session's `agentTeam` wire projection because the existing projection stream keeps browser state current without a separate Team read API. Both Lead and teammate conversations select values from the shared cross-Session store. The panel owns no projection reads: Session loading, cached list values, and control baselines supply the data.

The task panel uses non-deleted task views with readiness and overlap diagnostics, plus `failure` beside the last valid state. Historical roster fields remain decodable but have no current UI or assignment authority. Ordinary subagent navigation owns member discovery; task owner labels reuse Session and catalog metadata.

Publication requires `apply` to return a new state per applied event and replace only the touched collection. Mailbox-only events retain the client view and publish nothing. The existing carrier sends each changed complete view to connected browsers; the package README records that cost.

## Alternatives considered

**Keep a separate Team communication authority.** The later [tree-wide communication decision](../architecture/2026-10-16-tree-wide-agent-communication.md) places routing and authorization in the subagent runtime; a task board cannot grant another route.

**Keep a durable Team mailbox.** Target admission and task commit are independent operations. The historical Team mailbox remains readable, while current messaging uses the target inbox. Task commits neither deliver messages nor end waits.

**Treat task ownership or write scopes as locks.** Rejected because external writers bypass them, crashed owners remain durable, and path-prefix overlap cannot prove semantic independence. False mutual exclusion is more dangerous than an explicit warning.

**Create isolated worktrees automatically.** Rejected because worktree creation, branch naming, merge policy, ignored files, build artifacts, and cleanup are deployment choices. It also changes the same-world behavior existing subagents and sandboxes expose.

**Enable Teams in the default catalog.** Rejected because unsolicited coordination and Team tool schemas would add latency and token cost to simple tasks. An opt-in profile bundle inserts Team without adding Team packages to shipped dependency graphs.

**Use an in-memory board and mailbox.** Task state must survive settlement, HMR, and interruption. Historical mailbox records stay readable; message ownership follows the target inbox.

**Return Team tool results as untyped JSON.** Rejected because an undeclared result type lets `execute` drift from the value the model is promised without a compiler error, and it invites indentation that costs tokens on every task and wait result. Each Team tool therefore declares its complete result schema and one shared helper renders it compactly.

## Testing

Package tests cover task transitions, tree-based assignment, historical roster and mailbox decoding, and task commits that leave inbox waits pending. Ordinary subagent tests cover inbox waiting; recorded Team compositions cover identity, task policy, and tools.

Identity and inbox waiting follow [subagent controls](../../../../packages/subagent/tool-subagent-control/README.md); task policy follows the [Team tool reference](../../../../packages/team/tool-agent-team/README.md).

## Consequences

The Lead Session retains whole task snapshots and historical member and mailbox records. This favors inspectable recovery over compact deltas; deleted and delivered history remains append-only until broader Session retention applies.

A teammate can be non-resident, so `inactive` is not failure and sends can incur cold-resume latency. Historical pending mail is never delivered.

Coordination reduces likely checkout conflicts but cannot eliminate writes outside filesystem compare-and-set tools. The final diff and tests remain the Lead's integration boundary.
