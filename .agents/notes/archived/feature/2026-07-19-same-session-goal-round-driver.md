# Agent Note: Same-session goal-round driver

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-19-same-session-goal-round-driver.zh.md)

## Problem

The goal domain can retain an objective and the model-facing tools can mutate its lifecycle, but neither should decide when another model turn begins. A continuation driver must bridge active goal state to the ordinary agent loop without adding goal-specific branches to `dsh-agent-loop`, inventing a second conversation, or treating every human turn as an autonomous iteration.

That bridge has concurrency and durability obligations. Human input, cancellation, a goal edit, persistence failure, session restart, plugin unload, and a downstream prompt policy can all race a pending continuation. A naive `goal/changed -> agent.followup()` listener can admit obsolete work, run alongside a human prompt, spend beyond the cap, or restart from replay without new authority.

## Decision

`@deepseek-ai/dsh-goal-round-driver` in `packages/goal/goal-round-driver/` is a policy plugin over `ctx.goals`, the public `Agent` interface, and durable session events. It imports no concrete agent-loop implementation. For each exact live `Agent`, it owns process-local scheduling state and may reserve at most one automatic round.

The hierarchy is Goal → Goal Round → Turn → Step. A goal round is the outer continuation policy iteration; it becomes one goal-sourced session turn, and that turn can contain any number of ordinary model/tool steps. Human turns in the same session are not goal rounds and never increment `roundsStarted`.

The plugin has no configuration. `maxGoalRounds` is resolved and persisted by `dsh-goal`, and the same-condition blocking threshold is resolved and prompted by `dsh-tool-goal`. Repeating those tunables in the driver would create multiple owners for one policy.

### Reservation and admission

When an agent is idle, has no competing queued work, and its current goal is `active` plus `armed`, the driver checkpoints pending goal mutations and rechecks every predicate after the await. If `roundsStarted` already equals `maxGoalRounds`, it records `blocked` with code `round-limit`. Otherwise it reserves the exact identity `{ goalId, revision, round: roundsStarted + 1 }` and the complete rendered prompt before calling `Agent.followup()` with `GoalMessageSource`. The prompt JSON-quotes the objective so multiline or tag-like text remains an unambiguous data value inside the familiar frame.

The `agent/pre-step` waterfall is the entry fence. A positive goal source enters only when it exactly matches the driver's pending identity and content, the live goal still has that id and revision, activation remains armed, and the round is still the next number. The plugin checks once before delegating and again after downstream listeners return. This second check prevents an async listener from editing or pausing the goal while still entering the old prompt.

Only the resulting `user/message` is an entered round and advances the goal fold. A stale reservation closes a blocked no-step turn; the driver marks it stale and does not charge the round. A downstream policy rejection that is not caused by staleness blocks the goal rather than retrying around policy.

### Human work and revision races

The reserved `MessageId` distinguishes the driver's complete record from every other prompt. Ordinary work already queued before a reservation prevents scheduling. Ordinary work queued while an automatic prompt is pending makes that reservation stale, so a mixed claimed batch rejects the automatic proposal. Ordinary work arriving after the goal round entered remains queued for its own next turn; continuation is reconsidered only when the agent later becomes idle.

A goal mutation during a round advances its durable revision. Settlement of the older revision cannot overwrite that mutation. The driver discards the old attempt outcome, reads the new projection, and continues only if the new revision is still active and armed. This makes model-recorded completion, pause, block, and edit authoritative over the physical turn's later close reason.

### Settlement

The driver classifies one closed goal-owned turn as follows:

| Turn result | Action |
|---|---|
| durable `completed` | continue while active/armed and under cap |
| cancellation of a reserved/admitted goal round, or its `aborted` result | pause and disarm |
| `error` with code `RATE_LIMIT` or `QUOTA` | block with code `usage-limited` |
| other `error` | block with code `turn-error` |
| `max-tokens` | block with code `max-tokens` |
| failed durability checkpoint | disarm without changing durable phase |
| `disposed` or `interrupted` | disarm |
| plugin-added unknown result | block for inspection |

No abnormal outcome requests an automatic retry. A later human prompt can ask to continue in any language; the model reads the stopped goal and uses the goal tool's resume action, which records a new revision and arms continuation.

### Durability and cancellation contract

Every `goal/changed` notification creates a checkpoint obligation. The driver awaits `ctx.sessions.flush(session)` before reserving work, then checks for a newer mutation, agent lifecycle change, or competing prompt. Turn-end flush failure is reported by the existing `agent/error` notification after `turn/end`; the driver finds that exact closed turn even when a concurrent one-shot injection appended a later turn, associates the failure with the exact attempt, and disarms before the next idle decision.

Broad cancellation clears pending inbox work and aborts the active loop phase. The goal driver follows the reserved message through inbox claim/discard events and the durable aborted turn ending. Because a turn now opens before its initial claim, cancellation can close a claimed no-step attempt; the driver marks that attempt cancelled and lets the following idle edge pause the goal, just as it does for an admitted attempt. Cancellation with no matching goal attempt only removes process-local activation. If the pause mutation throws, the driver falls back to disarming rather than allowing cancelled automatic work to restart.

`Agent.cancel()` remains the only public broad cancellation verb. Custom `Agent` implementations that claim the interface must honor the inbox, turn-ending, status, and quiescence ordering if consumers depend on it.

### Process lifecycle

`GoalService.disarm(agent)` removes only process-local activation. It writes no session event, changes no revision, and emits no goal mutation. The driver calls it while loading over existing agents, on durability uncertainty, and before teardown; a later `resume` is the durable activation edge visible to the model.

The driver's event listeners and quiescent close are nested in one ordered Cordis effect. Cordis unloads sibling effects concurrently, so separate listener and cleanup registrations could remove the prompt fence while an async disposer was still draining. The composite effect first closes admission, disarms goals, cancels an admitted attempt, and awaits both agent and driver quiescence; only then does it unregister its listeners.

An inbox acceptance can win the microtask race immediately before plugin unload begins. In that case the turn and even its first request may start and the round remains durably charged; once unload starts, cancellation aborts it, no following round is scheduled, and the goal remains active but disarmed. Pretending that already-observed admission never happened would corrupt replay accounting.

## Testing

The unit suite uses the real agent loop and session service with only the model scripted. It covers exact sequential admission and cap enforcement, load/resume inertness, every outcome classification, rate limiting, request errors, max tokens, downstream prompt veto, pre-admission and in-flight cancellation, unrelated-human cancellation, failed-pause fallback, human-input ordering, queued and downstream revision races, forged goal attribution, failed mutation and turn checkpoints including a later one-shot injection, scheduler and custom-agent failures, session-start reset, exact lifecycle retirement, and queued/running plugin teardown. The new driver source has per-file 100% statement, branch, function, and line coverage.

A keyless ACP snapshot mounts the shipped automation app with the real goal domain, goal tools, goal driver, agent loop, persistence, and replay adapter through `cordis.yml`. One human-originated turn creates and inspects a two-round goal, the first automatic turn stops normally, and ACP cancellation of a deliberately stalled second round records a durable pause. The normalized wire transcript and external JSONL assertions prove one session, round sources `1, 2`, the lifecycle mutation, and exact replay accounting without using `echo-agent` as an application surrogate.

The core cancellation test proves notification order and containment: observers run only for effective cancellation, can queue replacement work before the inbox clear, cannot veto later observers by throwing, and an idle call emits nothing.

## Alternatives considered

- **Add a goal loop inside `dsh-agent-loop`** — rejected because the public queue, prompt, session, cancellation, and status contracts are sufficient, and a concrete-loop branch would privilege one policy.
- **Use `agent/turn-continuation` to make every round another step** — rejected because a goal round is an outer policy iteration and must have its own durable user prompt, turn boundary, round count, and failure settlement.
- **Persist a pending reservation** — rejected because a crash cannot prove that queued process memory had reached admission; only the durable `user/message` consumes the round.
- **Retry provider or persistence errors automatically** — rejected because retry policy spends resources and needs explicit authority; stopped phases plus later human resume are simpler and observable.
- **Fork conversation history or spawn a fresh agent for every round** — rejected for this package because the goal is explicitly same-session work. Fresh-agent Ralph execution remains a separate workflow plugin built from subagent and workflow primitives.
- **Reuse every session turn as the round counter** — rejected because human clarification and unrelated work share the session but not the automatic-work budget.

## Consequences

- Goal continuation remains a removable plugin and the concrete loop gains only a generic observe-before-cancel notification.
- Replay can reconstruct every admitted round from its exact goal source and prompt; rejected reservations cannot create phantom budget use.
- Human messages and lifecycle mutations win documented races without corrupting the revision or counter.
- Resume and fork remain inert until semantic human intent causes the model to record a resume mutation.
- Conservative failure mapping can require manual continuation after transient failures, but it never hides an automatic retry.

## Known limitations and deferred work

- Completion evidence and semantic blocker equivalence remain model judgments. An independent evaluator, completion certificate, or verifier-driven stop policy is deferred to a separate policy plugin.
- This package does not provide Ralph-style fresh-agent attempts, context reset, cross-round evaluator feedback, or workflow-level parallelism; those belong to the separate Ralph workflow tool.
- Cordis unload begins asynchronously. An already accepted inbox item may enter one charged round and start one request before teardown cancellation takes effect; the closing drain prevents every subsequent round.
- `maxGoalRounds` is only an admitted-round limit. Token, currency, wall-clock, and provider-usage budgets require independent policy.
- A custom `Agent` implementation must produce the documented session events, status edges, cancel notification, and quiescence semantics; structural TypeScript compatibility alone cannot verify runtime ordering.
