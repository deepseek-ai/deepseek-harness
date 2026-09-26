# Agent Note: Background job completion wakes are unbounded by default

Status: implemented

English | [中文](2026-09-22-unbounded-completion-wakes-by-default.zh.md)

## Problem

The [idle-owner wake decision](2026-08-11-background-job-completion-wakes-an-idle-owner.md) shipped `maxConsecutiveWakes` with a default of 3: an idle owner could be woken three times by job completions before further notices degraded to injection, and only a claimed user message refilled the budget. The counter was per owner and shared by every job kind — background `bash`/`pwsh`/PTY commands and one-shot `subagent_*` children.

A session that chained more than three of them without a user message hit the cap (issue #4944, reported as [dsh-external/issues#641](https://github.com/dsh-external/issues/issues/641)). The fourth notice was injected into the next-step inbox of an owner nothing would wake; the client renders no pending `context` message, so the session sat with a notice it could not see. The `tool-jobs` prompt promises the model "you are notified in-session when a job finishes — do not busy-poll", which encourages exactly the start-and-end-turn pattern that exhausts the cap. The stall arrived when the user was away and looked like a hang until they typed something.

## Decision

`maxConsecutiveWakes` has no default. Unset, every completion reaching an idle owner under `wakeup` delivery opens a turn. The `agent/inbox/claimed` refill listener and the per-owner ledger exist only when a cap is configured; a configured value must still be a whole number of turns, and `Infinity` is rejected because omitting the field already means unbounded.

The self-exciting chain the cap was built for — a woken turn starting the job whose completion wakes it again — is still real, and deployments that want the bound set the field. The trade-off is that the chain spends model requests the user can watch and stop, while a notice parked past a cap is invisible: nothing in the client shows it, nothing re-arms the budget, and the model's promise becomes false. An observable cost beats an unobservable stall.

`dsh run` is unaffected: headless exits once the task turn goes idle, so there is no idle owner left to wake.

## Alternatives considered

**Keep the default cap and make the parked notice visible** — a session-level pending indicator or an unread mark on the jobs list. This keeps the runaway bound but still breaks the prompt's promise: the model ended its turn expecting a notice and receives nothing until the user acts. Visibility is worth adding for a configured cap; it does not justify a default one.

**Count only self-excited wakes** — a wake counts against the budget only when the woken turn starts a new background job. This bounds the runaway chain without cutting off a chain of independent jobs, but the distinction needs the plugin to correlate job starts with the turn a wake opened, state no current consumer needs. It remains the natural refinement if a configured cap proves too coarse.

**A cooldown or rate limit instead of a counter.** Time does not distinguish a wanted chain from a runaway one; the wanted case is often the slow one, and a rate limit still parks a notice invisibly when it triggers.

**Re-check the next-step inbox on every turn-close path** (abort, LLM error, rejected pre-step). This closes the other parking spots the issue lists, but they are reached only by an already-parked notice; with no default cap the reported scenario never parks one. It stays a separate `agent-loop` change.

## Consequences

- An unattended session chaining background jobs is woken for every completion; the model request per wake is the cost, and the user can stop the session.
- The cap is opt-in configuration. Its README, config-catalog, and JSDoc state the silent-stall cost of setting it.
- Unit coverage pins four unattended completions each opening a turn under the default config; the cap, refill, and quiet-delivery tests keep explicit `maxConsecutiveWakes` values.
- No recorded-session snapshot changes: no shipped profile sets the field, and no existing scenario chains more than three idle completions.
