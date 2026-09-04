# Agent Note: Live assistant stream frames remain separate from the session log

Status: implemented

English | [中文](2026-08-31-live-assistant-stream-frames.zh.md)

## Problem

The v2 session log keeps one `assistant/message` or `assistant/attempt` settlement with the complete compact timed stream, so replay, cold reads, telemetry, and request reconstruction observe one durable history. A live consumer also needs prompt frame-by-frame presentation while a request runs. Treating a transient presentation update as another durable event would restore token-level event cardinality and make a process-lifetime concern survive restart.

## Decision

`dsh-agent-loop` emits scoped `agent/assistant-stream` frames for each model attempt. `start`, `chunk`, and `end` carry a branded `LlmAttemptId` unique within one Agent lifecycle; every frame advances one revision local to that lifecycle. The start frame names the attempt's turn and step, chunk indexes are dense from zero, chunk timestamps are reused by the compact stream, and `end.index` equals the next chunk position. Stream acquisition and its final cancellation check occur before `start`; a failure there emits no frame. Every started attempt emits one terminal end: the loop appends the final `assistant/message` or `assistant/attempt` before a committed end names that event and seq, while assembly or settlement failure emits an abandoned end without a durable target. Authenticated Session-follow accepts an explicit Web opt-in, opens with a cached active-attempt compact baseline, and carries durable events and cursorless frames in one FIFO. Each follower captures a local arrival ordinal with the opening baseline and drops buffered frames at or before that cut; frame revisions can restart at one with a replacement Agent, so they do not define the opening cut. A settlement arriving after an active opening is owned by that attempt only when its seq follows `startedAfterSeq` and its Turn and Step match; it remains staged until the matching end index, type, and seq arrive, while an earlier retry at the same Turn and Step remains visible. Revision, dense-index, or settlement gaps for a known attempt reopen follow and replace the baseline; unknown-attempt frames fall back to the durable settlement. The TypeScript and Python SDK protocols do not expose these frames. Durable settlements remain the source of replay and model history; the [v2 stream decision](2026-09-01-v2-embedded-assistant-streams.md) owns their representation.

## Alternatives considered

- **Keep only the live stream** — rejected because cold reads, replay, telemetry, usage accounting, and failed-attempt diagnostics require the durable embedded stream.
- **Persist each live frame as its own event** — rejected because process-local attempt ids, revisions, and reconnect presentation do not survive restart or affect model reconstruction; one settlement owns the durable stream.
- **Use an unbranded request string as the attempt key** — rejected because consumers need an opaque identity that cannot be confused with provider request IDs or durable Session IDs.
- **Let UI Chat subscribe to a second live source** — rejected because the Session object owns stream reconciliation and UI Conversation is the sole event-source subscriber; a second source would make settlement order target-dependent.

## Consequences

The Web client renders in-memory chunks before the attempt settles while retaining one durable v2 history. A process restart has no active Assistant frames; reconnect can restore only the baseline held by the current process, while cold replay expands durable settlements. Cursorless notifications never advance the journal cursor, and notifications observed during durable gap repair wait for the replacement page. That page has no Assistant baseline, so the Client clears transient attempts and lets the held notification reopen follow once for a paired page and baseline. The frame declaration remains agent-scoped, so a listener observes only its owning Agent unless it explicitly registers globally.
