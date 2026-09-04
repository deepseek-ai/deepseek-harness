# Agent Note: Terminal turn errors survive same-turn retry history

Status: implemented

English | [中文](2026-08-20-turn-error-survives-same-turn-retry-history.zh.md)

## Problem

The Web `turn-error` Definition suppressed its node permanently once the owning turn carried any `llm/retry` event. That rule encoded the retry model [bounded LLM request recovery](../architecture/2026-06-21-bounded-llm-request-recovery.md) originally shipped, where a retry closed the failed turn and opened the next numbered one: a turn with retry history could only be an intermediate failure whose facts already lived on the retry row, and the exhausted terminal failure landed in a later turn with no retry events.

The agent loop has since retried inside the failing turn and step — `llm-retry`'s runtime invariant requires `llm/retry` inside an open turn and step, and its loop tests assert a recovered turn holds one `step/start`. Under that producer, "the turn owns retry history" and "this `turn/end` error is the exhausted terminal failure" always coincide, so the suppression hid exactly the failure it existed to defer to: exhausting every transient retry left the conversation with a neutral collapsed "Retried model request (N/N)" row, no error row, and a re-enabled composer. The live e2e scenarios missed the gap because they covered a non-retryable AUTH failure (no retry events, so the row rendered) and a transient failure that recovered (a completed turn derives no failure), never exhaustion.

## Decision

Delete the suppression. The `turn-error` Definition matches only `turn/start` and error-reason `turn/end`, and renders whenever its turn recorded a terminal error; the settled retry chain renders beside it through the separate `model-retry` node. No hidden state, no retraction branch: with same-turn retries there is no event order in which a rendered terminal error is later superseded, because `turn/end` closes the turn.

Partial history windows behave identically by construction — a tail window containing only the error-reason `turn/end` derives the same node the full history does, where the old rule hid one and showed the other depending on which retry events the window happened to include.

## Testing

The Definition suite drives the real assembler through a same-turn retry chain ending in an error-reason `turn/end` and asserts the `turn-error` node materializes with its message and code — in full history, in a tail-only window, and after prepending the earlier chain. A keyless Web composition scenario exhausts a scenario-owned two-retry policy against three injected SERVER throws and pins the terminal error row beside the settled retry row in the golden; the scaffold gained a `replayRetryPolicy` option so exhaustion runs in milliseconds instead of the shared default's five backed-off attempts.

## Alternatives considered

**Reset `hidden` when the terminal failure arrives.** Rejected: it keeps a state machine whose only remaining transition is the one that caused the bug. Under same-turn retries no event sequence needs the suppression at all.

**Distinguish intermediate from terminal `turn/end` errors.** Rejected: the distinction does not exist in the log. A turn ends once; an error reason is always terminal for its turn.

## Consequences

Exhausted recovery now leaves durable, replayable feedback: the red terminal row with the display-safe message and code, plus the collapsed retry chain as recovery context. Session logs recorded under the retired new-turn retry model render one `turn-error` row per failed turn on replay; the v0-to-v1 edge preserves those terminal facts, and no shipped log producer has emitted that shape since same-turn retries landed.
