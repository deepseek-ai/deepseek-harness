# Agent Note: Durable Agent Teams over continuable children

Status: implemented

English | [中文](2026-08-05-agent-teams.zh.md)

## Problem

The subagent seam supplies fresh/fork providers, durable child Sessions, FIFO follow-ups, and cold-resumable Activations. Its direct-parent controls do not provide peer communication, a stable named roster, or shared task ownership. A coordinator can create several workers, but workers cannot address one another, durable follow-up intent lives only in target inboxes, and no common compare-and-set board prevents stale assignment updates.

All same-process Agents also share one checkout. Filesystem edit tools can reject an observed stale version, but Bash, formatters, generators, and external writers bypass that fence. Treating a teammate name or task owner as a file lock would hide rather than solve this concurrency boundary.

Agent Teams needs an explicit opt-in composition while its public contracts remain experimental. The default tool catalog and simple-task behavior must remain unchanged, while an explicitly requested Team must survive child Activation settlement and mailbox delivery races long enough for the Lead to aggregate the result before process teardown.

## Decision

Every ordinary root leads the Team identified by its `SessionId`. The Lead row exists by identity; durable task state begins with the first task event. [Subagent teammates](../architecture/2026-10-15-agent-teams-as-subagents.md) owns creation, messaging, and interruption. Every live subagent below the root is a member; the root’s direct continuable children form the roster. An ordinary fork leads a new Team and excludes inherited Team records.

The implementation is split into `@deepseek-ai/dsh-experimental-agent-team`, which owns `ctx.agentTeams` and durable semantics, and `@deepseek-ai/dsh-experimental-tool-agent-team`, which owns scoped schemas and model guidance. Every Team tool declares its complete result schema and renders that value as compact JSON, so the compiler checks each `execute` against what the model is promised and no result spends tokens on indentation. Deployments mount both plugins explicitly; Team registers no tool that shares a name with the subagent controls. The shared policy announces Team availability and describes coordination responsibilities. Both packages are public members of `packages/experimental/`; the [experimental package reference](../../../../packages/experimental/AGENTS.md) owns publication, dependency isolation, and promotion.

The Lead must wait for required work before its final answer. Process teardown remains the final lifecycle owner and drains continuation Activations; a Team task owner is durable state and is not automatically released by idle, interruption, or process exit.

## Profile delegation

The [Team profile](../../../../packages/experimental/agent-team-profile/README.md) inserts the Team rows and keeps the base delegation and control tools; teammates are started with those tools as described in [subagents](../architecture/2026-10-15-agent-teams-as-subagents.md). Ordinary Session forks retain their history; [current identity handling](../architecture/2026-10-13-team-identity-runtime-context.md) supplies the fork's own role.

## Team identity

Shared system policy and tool schemas stay uniform across members; execution enforces role restrictions. Team tools resolve the caller’s Team and use Session ids as task owners. [Required runtime-context identity](../architecture/2026-10-13-team-identity-runtime-context.md) owns identity injection, retention, and fork handling.

## Provisioning and recovery

Teammate creation and cold resume belong to the subagent runtime ([subagent teammates](../architecture/2026-10-15-agent-teams-as-subagents.md)). Historical `team/member` records remain readable with their phases and descriptions; Team writes no new membership records.

## Mailbox and task transactions

The historical Lead-log mailbox remains a readable format: queued and delivered records keep their stable identity and sender, and Team payload validation still applies to them. Team never delivers or acknowledges them; messages between members use the target Agent inbox through the subagent operation ([subagents](../architecture/2026-10-15-agent-teams-as-subagents.md)).

Unknown mailbox content stays as decoded JSON during event projection and checkpoint admission. Validation inspects its type without rebuilding its fields, because generic object parsing can omit a valid own `__proto__` key. Locally declared content variants undergo structural validation; opaque plugin fields do not gain Team semantics. Cache invalidation is necessary because parser correction alone cannot recover keys omitted from cached state. The [Team documentation](../../../../packages/experimental/agent-team/README.md) owns the restore behavior.

Member messages use the subagent `send_message` operation, which steers running, idle, and cold targets and returns inbox acceptance.

Shared tasks are complete snapshots with Team-local ids and monotonic revisions. Every mutation carries `expectedRevision`. Any member creates, reads, or claims a ready unowned task; the owner or Lead edits and transitions it, while only the Lead assigns another member. Numeric task ids remain within the safe-integer allocation range, and exhaustion fails without reusing an id. Dependencies must name non-deleted tasks and form a complete DAG. Deleted tasks are retained tombstones. `writeScopes` are normalized path prefixes that produce overlap diagnostics but never block claim or authorize a write.

`wait_agent` blocks on one task, member-status, or accepted member-message edge registered after the call starts instead of encouraging model polling. It does not replay an earlier edge, so callers re-read authoritative state after wakeup or timeout. Interruption is the subagent ancestor operation, so only the Lead interrupts teammates; it does not alter task ownership.

## Shared checkout boundary

Members start in the Lead’s current directory and observe shared filesystem writes immediately. Later directory changes stay local to each Session. The policy tells members to partition tasks, record advisory write scopes, order dependent work, and let the Lead inspect the final diff and run tests. A filesystem stale-version rejection requires rereading and rebasing the intended change. No equivalent guarantee is claimed for Bash, formatters, code generation, or direct external writes.

The Team domain does not infer branches, create worktrees, merge changes, or silently change cwd. A deployment or caller can use [explicit worktree creation](2026-09-13-explicit-worktree-creation.md) separately. This preserves the existing same-world subagent and sandbox contracts.

## Web projection

The Web panel reads the Lead Session's `agentTeam` wire projection because the existing projection stream keeps browser state current without a separate Team read API. Both Lead and teammate conversations select values from the shared cross-Session store. The panel owns no projection reads: Session loading, cached list values, and control baselines supply the data.

The wire view carries the roster of the Lead, its continuable catalog children, and historical members with their recorded phases, non-deleted task views with shared readiness and overlap derivation, and `failure` beside the last valid state. Live activity comes from Session status. Model selection has its own durable projection; the panel displays the shared store's available values without opening member conversations. A missing cached value remains absent until Session loading or a live update supplies it.

Publication requires `apply` to return a new state per applied event and replace only the touched collection. Mailbox-only events retain the client view and publish nothing. The existing carrier sends each changed complete view to connected browsers; the package README records that cost.

## Alternatives considered

**Give every child access across the Team tree.** Shared task membership does not grant messaging authority across parents. [Subagent teammates](../architecture/2026-10-15-agent-teams-as-subagents.md) uses the shared parent’s authority for continuable siblings; tasks retain the Lead log as persistence owner.

**Store mail in each target Session before Lead-log enqueue.** Rejected because target materialization and acceptance can fail after the Team has committed the send. The always-live Lead Session is the transaction home; target recording is the acknowledgement and de-duplication boundary.

**Treat task ownership or write scopes as locks.** Rejected because external writers bypass them, crashed owners remain durable, and path-prefix overlap cannot prove semantic independence. False mutual exclusion is more dangerous than an explicit warning.

**Create isolated worktrees automatically.** Rejected because worktree creation, branch naming, merge policy, ignored files, build artifacts, and cleanup are deployment choices. It also changes the same-world behavior existing subagents and sandboxes expose.

**Enable Teams in the default catalog.** Rejected because unsolicited coordination and Team tool schemas would add latency and token cost to simple tasks. An opt-in profile bundle inserts Team without adding Team packages to shipped dependency graphs.

**Use an in-memory board and mailbox.** Task state must survive settlement, HMR, and interruption. Historical mailbox records stay readable; message ownership follows the target inbox.

**Return Team tool results as untyped JSON.** Rejected because an undeclared result type lets `execute` drift from the value the model is promised without a compiler error, and it invites indentation that costs tokens on every task and wait result. Each Team tool therefore declares its complete result schema and one shared helper renders it compactly.

## Testing

Package tests cover Team membership, catalog-backed roster projection, task transitions, waits, and historical roster and mailbox readability. The keyless Team profile snapshot pins the policy, tools, and workflow; the CLI composition test checks persisted Team and child logs.

Model-facing member identities and availability follow the [tool projection reference](../../../../packages/experimental/tool-agent-team/README.md); service residency and durable identity remain distinct.

## Consequences

The Lead Session retains whole task snapshots and historical member and mailbox records. This favors inspectable recovery over compact deltas; deleted and delivered history remains append-only until broader Session retention applies.

A teammate can be non-resident, so `inactive` is not failure and sends can incur cold-resume latency. Historical pending mail is never delivered.

Coordination reduces likely checkout conflicts but cannot eliminate writes outside filesystem compare-and-set tools. The final diff and tests remain the Lead's integration boundary.
