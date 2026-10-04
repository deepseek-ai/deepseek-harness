# Agent Note: Queued manual compaction with one durable lock

Status: implemented
Archived: 2026-09-30

English | [中文](2026-07-30-queued-manual-compaction.zh.md)

## Problem

Automatic compaction protects the context window, but an interactive user also needs a deterministic way to condense accumulated history before pressure policy fires. Sending `/compact` as prompt text would spend a model turn and let the conversation model reinterpret a direct control action. Implementing it inside one UI would duplicate command discovery, lifecycle logging, cancellation, and backend policy.

The human command arrives between turns and must summarize asynchronously. A prompt accepted during that wait must keep its ordinary identity, FIFO position, and wakeup behavior, but it must not derive a request from history that compaction is about to replace. A separate status check is insufficient because another caller can wake the driver between that check and the compaction operation claiming the idle phase.

Compaction also needs one mutual-exclusion fact shared by manual, pressure, overflow, and explicit-range entry points. A process-local flag alone cannot explain a crash-recovered log, while a summarize-first transaction leaves no durable evidence during the expensive interval. Conversely, treating marker pairs as exclusive containers would forbid valid idle injection even though injection is explicitly non-waking and immediate between turns.

This note extends the [compaction capability seam](2026-06-18-compaction-capability-seam.md), the [session end-seed boundary](../architecture/2026-07-30-session-end-seed-log-boundary.md), and the [removal of synthetic log-only turns](../simplification/2026-07-28-remove-synthetic-log-only-turns.md). Each remains active and owns its broader decision; the overlap is partial only.

## Decision

### `/compact` is a command over a backend-independent seam

`@deepseek-ai/dsh-command-compact` registers one argument-free human command through `ctx.commands`. It calls the third abstract `CompactionEngine` operation, `compactNow(agent, signal)`, and maps the closed `ManualCompactionError` taxonomy (`busy | changed | summary | commit | persistence`) to direct UI results. `command/run` and `command/done` preserve the command lifecycle without entering model history or consuming a model-loop turn.

The command plugin tracks each real handler promise independently of the command executor's abort-aware wait. Its composite lifecycle effect unregisters `/compact` before asynchronously draining handlers that already started, so root teardown reaches quiescence only after backend close and flush work settles.

The seam's `ManualCompactAgentContext` adds only `runMaintenance()` to the session and routing facts compaction already needs. Retention, balancing, summarization, marker ordering, replacement, and durability remain backend responsibilities.

### Idle maintenance is synchronously claimed

`Agent.runMaintenance(task)` starts only from the idle phase and claims that phase before invoking the task. A waking send starts the loop immediately when idle, so whichever operation claims the phase first owns the boundary.

Maintenance does not create a second queue. Later sends keep their `MessageId`, placement, FIFO order, and wakeup facts. Waking input remains queued until maintenance settles, then starts the existing driver path; `inject()` remains non-waking.

`whenIdle()` treats maintenance and any waking work released behind it as unfinished activity. Cancellation aborts the agent-owned maintenance signal, and lifecycle teardown drains the same activity boundary before disposal completes.

### One parameterized transaction owns every bracket

`dsh-compaction-basic` has one region transaction parameterized by bracket owner (`number | null`), stability rule (whole surface or selected span), and an optional flush. It performs one ordering:

1. validate the selected positional range and inspect the durable tail;
2. reject a live unmatched compaction marker;
3. append `compaction/start` synchronously;
4. prepare and await summarization;
5. revalidate the required stability;
6. append `compaction/summary` and the replacement `user/message`;
7. make exactly one `compaction/end` attempt;
8. flush when the manual caller requested durability.

Automatic and explicit-region work use the numeric owner recovered from the open turn and require whole-surface stability. Manual work reserves admission first, selects a useful range before the transaction, and writes nothing when selection returns `null`. Its bracket uses `turn: null`, requires only selected-span stability, and flushes every successfully closed attempt before releasing admission in `finally`.

`compaction/start` is therefore the only compaction lock. There is no `WeakSet`, wrapper mutex, locked/unlocked method split, or redundant activity check around the transaction.

### Bracket-first deliberately differs from the surveyed implementations

Codex models manual compaction as a `CompactionTask` occupying its active-turn slot while automatic compaction runs inline. Pi uses the existence of a compaction abort controller as its mutex and appends compaction only after success. Claude Code shares one compaction routine between automatic and manual paths but constructs its boundary after summary streaming.

DSH deliberately records `compaction/start` before calling the summarizer. A slow or crashed attempt is observable, automatic and manual paths share the same durable lock, and a later writer cannot mistake an in-flight summary for an unlocked session. This is a conscious divergence from summarize-first behavior, not an accidental event-order difference.

### Markers are time points, not an event container

`compaction/start` and `compaction/end` mean lock acquisition and release. They do not claim exclusive ownership of every event between their seqs. An idle `inject()` may append a `user/message` while a manual summary is pending, so that unrelated event can sit inside the marker interval.

Manual stability checks only the selected span: it must remain present, contiguous, ordered, equally priced, and balanced. Append-only context outside it does not stale the summary. Positional replacement places the checkpoint at the old span's surface position and leaves injected context after it in derived model history, even though the injection's log seq precedes the later summary and replacement events.

Failed `changed` or `summary` attempts leave the conversation surface unchanged, but the log is not unchanged: it contains `compaction/start` and `compaction/end { error }`. User-facing text states that distinction.

### End-seed distinguishes live and stale orphans

Tail scanning finds the current turn, unmatched compaction start, and newest `session/end-seed` independently. An unmatched start after the newest end-seed is live and blocks every compaction entry point. An unmatched start before a later end-seed belongs to an earlier session lifecycle and is stale, so it does not wedge the resumed or forked session.

The compaction invariant uses the same transition logic during seed replay: `session/end-seed` clears an open historical trace. The boundary need not publish live from the constructor for this case; replay is the load-bearing path.

The client request projection closes an unmatched compaction request as interrupted at the `session/end-seed` time and clears its active index. A later `compaction/start` therefore creates an independent request instead of leaving or overwriting a permanently running orphan.

Once a transaction has appended its start, every later failure makes one closing attempt. A failed close leaves the unmatched start deliberately visible and blocking, and no flush is attempted. A closed manual attempt is flushed even when it reports an expected failure. Cancellation retains exact-reason precedence after required close and flush cleanup.

### Reference implementation boundaries

An unmerged reference implementation informed the command, reservation, tests, and snapshot shape. Its process-local `WeakSet` lock and locked/unlocked method splits were considered and not adopted because the durable bracket is the single reachable lock.

That reference also carried client-side replacement-anchor machinery to preserve transcript placement. The log-ordered transcript projection already consumes compaction from event order and does not consult mutable surface positions, so those anchors were considered and not adopted.

## Alternatives considered

**Check `agent.status` before starting maintenance.** Rejected because the check and phase claim would be separate operations; a waking send could start the driver between them.

**Queue the command itself.** Rejected because `/compact` is direct control, not model input, and a prompt already accepted first must retain right of way rather than being reordered around a second command queue.

**Summarize before appending `compaction/start`.** Rejected because the expensive in-flight operation would be invisible and would not participate in the lock shared by automatic compaction.

**Use both a durable marker and a process-local mutex.** Rejected because two authorities can disagree after replay and require wrapper branches for states the bracket already expresses.

**Hold injection with waking prompts.** Rejected because idle injection is non-waking durable context by contract; delaying it would make plugin ordering depend on a UI command.

**Require the marker interval to contain only compaction events.** Rejected because markers represent lock time points. `compaction/summary` names the selected range and shadowed seqs exactly; exclusivity would add no correctness and would reject valid injection.

**Treat every unmatched marker as permanently busy.** Rejected because a crash-recovered or forked session would remain wedged. `session/end-seed` is the explicit lifecycle evidence that distinguishes stale history from a live process-local attempt.

## Verification

Agent-loop tests cover same-tick right of way, preserved IDs and FIFO lifecycle, waking and quiet queued work, idempotent release, `whenIdle()`, cancellation, and teardown. Compact tests cover standalone and numbered invariant ownership, end-seed replay, live versus stale orphans, re-entrant listeners, selected-span drift, commit and close failures, flush ordering, exact cancellation causes, raw output and usage preservation, and automatic/manual mutual exclusion.

The command package pins registration, Loader composition, argument rejection, exact success/failure text, cancellation, absence from model history, and disposal waiting across separate close and flush boundaries after an abort stops the executor from awaiting the handler. The client runtime projection test pins end-seed interruption followed by an independent completed attempt. The `queued-manual-compact` terminal snapshot drives real keystrokes through the assembled TUI: `/help` discovers the command, a held summary admits a queued prompt and immediate injection, `turn: null` markers and the flush precede the queued prompt turn, command lifecycle stays log-only, and the derived order is checkpoint → injection → queued prompt.

## Consequences

Interactive users can compact useful history without spending a conversation-model turn. A prompt accepted before the command wins; one submitted during the command waits with its original queue identity. Manual compaction consumes session seqs but no turn number.

The log exposes slow, failed, crashed, and successful attempts through the same bracket. A stale pre-boundary orphan no longer wedges a new lifecycle, while a current unmatched start remains a hard busy signal. Marker intervals may contain unrelated events, so consumers use the seqs recorded in `compaction/summary` and relative ordering rather than assuming a contiguous compaction-only slice.

The shared transaction keeps one ordering and one lock across every entry point. Failure reporting is precise about whether only the log changed, the surface may have partially changed, or the in-memory commit could not be persisted.
