# Agent Note: Request-error retry action

Status: implemented
Archived: 2026-09-30

English | [中文](2026-07-27-request-error-retry-action.zh.md)

## Problem

Model-request recovery was decided inside `agent/request-error` but communicated through `Agent.retry()`. That public command was valid during one narrow waterfall window and while idle, rejected other running states, and required `ReactLoopAgent` to retain a mutable retry window beside the waterfall result. The recovery plugins were the only production callers, so the wider live-agent capability exposed states and behavior unrelated to their policy decision.

## Decision

`agent/request-error` returns `RequestErrorAction`, whose handling action is `{ kind: 'retry' }`; the default `undefined` keeps the failed turn terminal. A listener that does not own the failure calls `next()`. A listener that owns it performs any awaited repair and returns the retry action without delegating.

The loop reads the action after the waterfall settles, closes the failed turn, and opens one retry turn from durable history. It rechecks the turn signal when consuming the action, so cancellation or disposal during recovery prevents the retry even if a listener returns it afterward. A thrown recovery never produces an action.

`Agent` and `ReactLoopAgent` expose no `retry()` method. Ordinary new work enters through `followup()`, `steer()`, and `inject()`; only a handled model-request failure can open a promptless retry turn.

## Alternatives considered

**Keep `Agent.retry()` as the recovery command.** Runtime guards can restrict the command to the request-error window, but the interface still advertises an idle resummon operation with no production consumer and the loop still needs mutable side-channel state to recover a decision already owned by the waterfall.

**Return an explicit terminal action.** `undefined` already represents the waterfall's unhandled default and composes directly through `next()`. A second `{ kind: 'fail' }` value would add no distinct behavior or ownership information.

## Consequences

Recovery ownership, asynchronous repair, and the retry decision share one typed return path. The live-agent interface and concrete loop lose the idle resummon capability and retry-window state. Callers cannot restart arbitrary failed non-request work without submitting a later prompt, while transient and context-overflow policies retain numbered retry turns, durable-history reconstruction, finite private budgets, and cancellation precedence.

Focused agent-loop tests pin retry chaining, terminal fallthrough, recovery failure, and cancellation races. The llm-retry and compaction-basic suites pin their policy-owned action returns, and the ACP, goal-round-driver, and plan-mode integrations pin successor-turn adoption.
