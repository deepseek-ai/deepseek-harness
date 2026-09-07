# Agent Note: Durable Agent Teams over continuable children

Status: implemented

English | [中文](2026-08-05-agent-teams.zh.md)

## Problem

The subagent seam supplies fresh/fork providers, durable child Sessions, FIFO follow-ups, and cold-resumable Activations. Its direct-parent controls do not provide peer communication, a stable named roster, or shared task ownership. A coordinator can create several workers, but workers cannot address one another, durable follow-up intent lives only in target inboxes, and no common compare-and-set board prevents stale assignment updates.

All same-process Agents also share one checkout. Filesystem edit tools can reject an observed stale version, but Bash, formatters, generators, and external writers bypass that fence. Treating a teammate name or task owner as a file lock would hide rather than solve this concurrency boundary.

Agent Teams needs an explicit source-checkout composition before its public contracts are stable enough for released CLI or Web bundles. The default tool catalog and simple-task behavior must remain unchanged, while an explicitly requested Team must survive child Activation settlement and mailbox delivery races long enough for the Lead to aggregate the result before process teardown.

## Decision

Every ordinary runtime root is the implicit Lead of a Team identified by that root's `SessionId`. The Team has no creation event: its Lead pseudo-row exists by identity, while durable state begins with the first member, message, or task event. A roster is flat and contains at most the configured number of immutable lowercase-kebab-case names. Each teammate is a continuable direct child with a reserved Session id; only the Lead creates or interrupts teammates. Ordinary provider-owned subagents outside the roster are not Team members, and an ordinary fork is a new root whose inherited Team records are excluded by their ancestor `TeamId`.

The implementation is split into `@deepseek-ai/dsh-experimental-agent-team`, which owns `ctx.agentTeams` and durable semantics, and `@deepseek-ai/dsh-experimental-tool-agent-team`, which owns scoped schemas and model guidance. Every Team tool declares its complete result schema and renders that value as compact JSON, so the compiler checks each `execute` against what the model is promised and no result spends tokens on indentation. Deployments mount both plugins explicitly and may disable legacy continuable controls with the same model-visible names. The explicit delegation policy permits Team creation only when the user asks for Agent Teams or teammates. Both packages are private members of `packages/experimental/`; the [experimental package decision](../architecture/2026-08-18-experimental-agent-teams-packages.md) owns release exclusion, dependency isolation, and promotion.

The Lead must wait for required work before its final answer. Process teardown remains the final lifecycle owner and drains continuation Activations; a Team task owner is durable state and is not automatically released by idle, interruption, or process exit.

## Provisioning and recovery

Creation first appends and flushes a `team/member` provisioning snapshot in the Lead Session, then starts the reserved continuable child through the selected fresh or fork provider. Failure before initial inbox acceptance appends a failed snapshot. Success flushes the child's accepted inbox item before appending active. Recovery recognizes that initial message while it is still pending or after it enters user-message history. Names are reserved by the first provisioning record and never reused, including after failure. Disposal closes admission, aborts and awaits admitted creation and mailbox-dispatch transactions, then stops every live child recorded by the roster; a failed child remains cleanup-owned until its Activation exits, and cleanup rejection fails disposal.

A root recovery reconciles an unterminated provisioning record against the child's independently persisted Session. Matching direct-parent and continuable descriptors plus a recorded initial user message prove successful admission and produce active; absence, corruption, mismatched provider/lineage, or a missing admitted message produces failed. The creator re-reads the terminal phase under the same Lead-log serializer; if recovery marked failed while creation succeeded, it drains the child and reports a provisioning conflict instead of retaining an orphan. This avoids reconstructing an initial prompt that was never retained in the Team log and contains plugin-reload races.

Fresh children have no inherited conversation. Fork children capture the Lead's completed-turn prefix once and retain it as their own durable seed. The current delegation turn remains excluded, matching the existing fork provider contract.

## Mailbox and task transactions

Peer communication is a Lead-log mailbox. `team/message/queued` is appended and flushed before delivery. The target message carries the stable message id and sender identity in both durable source metadata and a short model-visible prefix. A target receipt is acknowledged with `team/message/delivered` only after its pending inbox item or recorded user message is flushed. Immediate admission is serialized per target in queued-log order, recovery retries queued-minus-delivered in the same order, and delivery folds live or persisted target inbox/history state before cold resume. Every current-version Team payload is runtime-validated before entering replay state. The Team runtime tracks dispatch and asynchronous acknowledgement work from synchronous admission until settlement; disposal closes admission and awaits both before removing the service. Current waiters wake only after the owning Team event flush succeeds.

`send_message` always attempts Steer delivery. A running target receives the message at the nearest step boundary, an idle target starts a turn, and an inactive teammate cold-resumes. Success means the message is already durable even when temporary delivery failure leaves it queued. The mechanism provides process-local retry and target-Session de-duplication, not a cross-process exactly-once claim. The [Team Steer messaging decision](../../archived/simplification/2026-08-30-team-send-message-steer.md) owns the single-tool scheduling rationale.

Shared tasks are complete snapshots with Team-local ids and monotonic revisions. Every mutation carries `expectedRevision`. Any member creates, reads, or claims a ready unowned task; the owner or Lead edits and transitions it, while only the Lead assigns another member. Numeric task ids remain within the safe-integer allocation range, and exhaustion fails without reusing an id. Dependencies must name non-deleted tasks and form a complete DAG. Deleted tasks are retained tombstones. `writeScopes` are normalized path prefixes that produce overlap diagnostics but never block claim or authorize a write.

`wait_agent` blocks on one roster, mailbox, task, or live-status edge registered after the call starts instead of encouraging model polling. It does not replay an earlier edge, so callers re-read authoritative state after wakeup or timeout. Lead-only interruption cancels the current turn with inbox preservation and does not alter mailbox or task ownership.

## Shared checkout boundary

All members use the same cwd and observe writes immediately. The policy tells members to partition tasks, record advisory write scopes, order dependent work, and let the Lead inspect the final diff and run tests. A filesystem stale-version rejection requires rereading and rebasing the intended change. No equivalent guarantee is claimed for Bash, formatters, code generation, or direct external writes.

Worktree isolation is not a harness runtime behavior. A deployment or prompt may arrange separate worktrees, but the Team domain does not infer branches, merge changes, or silently change cwd. This preserves the existing same-world subagent and sandbox contracts.

## Alternatives considered

**Extend direct-child subagent tools with peer ids.** Rejected because parent/child authority and Team peer membership are different domains. Adding peer access to the continuation seam would weaken its exact-parent authorization and still leave roster and tasks without a persistence owner.

**Store mail in each target Session before Lead-log enqueue.** Rejected because target materialization and acceptance can fail after the Team has committed the send. The always-live Lead Session is the transaction home; target recording is the acknowledgement and de-duplication boundary.

**Treat task ownership or write scopes as locks.** Rejected because external writers bypass them, crashed owners remain durable, and path-prefix overlap cannot prove semantic independence. False mutual exclusion is more dangerous than an explicit warning.

**Create isolated worktrees automatically.** Rejected because worktree creation, branch naming, merge policy, ignored files, build artifacts, and cleanup are deployment choices. It also changes the same-world behavior existing subagents and sandboxes expose.

**Enable Teams in the default catalog.** Rejected because scoped Team controls would shadow same-named legacy globals and unsolicited delegation would add latency and token cost to simple tasks. A private profile bundle inserts Team and disables the legacy controls without adding Team packages to shipped dependency graphs.

**Use an in-memory board and mailbox.** Rejected because child settlement, HMR, and process interruption would lose accepted coordination state and make retries ambiguous.

**Return Team tool results as untyped JSON.** Rejected because an undeclared result type lets `execute` drift from the value the model is promised without a compiler error, and it invites indentation that costs tokens on every roster, task, and receipt. Each Team tool therefore declares its complete result schema and one shared helper renders it compactly.

## Testing

Package tests cover identity, name and authority checks, provider selection, reserved-id persistence collisions, child-before-Lead flush ordering, durable provisioning failure and pending-inbox JSONL reconciliation, concurrent target-local ordering, pending/history de-duplication, mailbox limits, post-flush notification, bounded disposal with in-flight creation and dispatch cancellation, failed-member cleanup, task CAS and DAG validation, write-scope warnings, wait cancellation/timeout, inbox-preserving interruption, ordinary-fork isolation, legacy-control shadowing, compact declared-schema result rendering, and scoped registration HMR at per-file 100% coverage. A keyless product snapshot loads the private Agent Teams profile bundle through `dsh --profile headless` and pins its complete model-visible tool list, Team policy, and durable workflow projection for two teammates, dependent tasks, peer delivery, waiting, completion, and aggregation. A CLI e2e reuses the same deterministic adapter and verifies normal process exit with persisted Team and child logs.

## Consequences

The Lead Session grows with whole task/member snapshots and mailbox acknowledgements. This favors independently inspectable recovery over compact deltas; configured task and pending-mail bounds cap active state, while deleted and delivered history remains append-only until broader Session retention applies.

An active roster member can be non-resident, so `inactive` is not failure and a send can incur cold-resume latency. Temporary inspection, resume, or inbox-admission failure can leave a durable message queued for recovery. A failed member permanently consumes its name and member slot, making provisioning failures visible instead of silently recycling identity.

Coordination reduces likely checkout conflicts but cannot eliminate writes outside filesystem compare-and-set tools. The final diff and tests remain the Lead's integration boundary.
