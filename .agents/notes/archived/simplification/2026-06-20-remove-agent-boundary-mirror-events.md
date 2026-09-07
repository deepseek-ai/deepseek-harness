# Agent Note: Stop mirroring durable boundaries as agent events

Status: implemented
Archived: 2026-09-04

English | [中文](2026-06-20-remove-agent-boundary-mirror-events.zh.md)

## Problem

The loop records the canonical transcript in `SessionEvent` and also emitted a parallel set of live `agent/*` boundary mirror events: `agent/turn-start`, `agent/turn-end`, `agent/step-start`, and `agent/step-end`. The mirrors made consumers choose between two sources of truth for the SAME durable fact. ACP already chose the session log for prompt settlement and committed output because it is the one durable, replayable record; consuming a live mirror would require reconciling its timing with the boundary already stored in that log. The stdio UI was the only production consumer that still rendered turn boundaries from the mirror events; it already rendered tool calls and results from `session/event`.

This duplication is not free. Every lifecycle change had to update the session event, the mirror event, docs, invariants, tests, and snapshot expectations. The duplicate boundary events also made failure ordering subtle: a turn can be durably closed before a live `agent/turn-end` listener runs, so a post-boundary listener failure has no valid in-log position left and must be reported out of band.

## Decision

Make `session/event` the single live boundary/transcript stream. Consumers that render turns, tool calls, tool results, assistant messages, and durable boundaries subscribe to `session/event` and derive their UI from the same event vocabulary persistence uses.

The four durable-boundary mirrors — `agent/turn-start`, `agent/turn-end`, `agent/step-start`, `agent/step-end` — are removed from the agent event taxonomy. A UI that wants the agent handle at a boundary retains the live target object from `agent/created`/`agent/disposed` and compares its session directly; `dsh-ui-stdio` uses this to label the app-owned agent's `[main turn N]` header while other sessions render their durable id. The canonical record remains the event-sourced session log.

The step mirrors (which had no consumer at all) were removed first, in [the event-domain-semantics Agent Note](../architecture/2026-06-30-event-domain-semantics.md); that Agent Note KEPT the turn mirrors on the stated justification that the stdio UI needed the `Agent` handle at the turn boundary. This decision finishes the job: `dsh-ui-stdio` is a disposable test REPL whose rendering can change freely, so "ui-stdio needs it" is not a reason to keep a mirror — it reads `session/event` and retains only its live target object.

## Scope: what is and isn't removed

Removed (durable-boundary mirrors — the session log is authoritative for each): `agent/turn-start`, `agent/turn-end`, `agent/step-start`, `agent/step-end`.

RETAINED — NOT durable-boundary mirrors, so out of scope for this decision:

- `agent/steering` — not a boundary, so out of scope for THIS decision. It mirrors the durable `steering/message` control record rather than a boundary, and was removed by its own follow-up: [Remove the `agent/steering` mirror emit](../../archived/simplification/2026-07-04-remove-agent-steering-mirror.md).
- `agent/stream-chunk` — the live token stream. Out of scope for THIS decision (a mirror of the durable `assistant/chunk`, not a boundary), it was removed by its own follow-up: [Stop mirroring the token stream as an agent event](../../archived/simplification/2026-07-02-remove-stream-chunk-mirror.md).
- `agent/created`, `agent/disposed`, `agent/status`, `agent/error`, `agent/queued` — lifecycle/control events that are not transcript data. `agent/queued` in particular is an inbox acknowledgement that fires before any durable event exists (cancelled queued work may never enter the log), so it is deliberately live-only.

## Alternatives considered

- **Bundling `agent/steering` into the removal** — the original proposal's shape; narrowed out as scope creep: it mirrors the durable `steering/message` control record, not a boundary, and was removed by [its own later decision](../../archived/simplification/2026-07-04-remove-agent-steering-mirror.md) (as was `agent/stream-chunk`, by [the stream-chunk-mirror Agent Note](../../archived/simplification/2026-07-02-remove-stream-chunk-mirror.md)).
- **Keeping the turn mirrors for the stdio UI** — [the event-domain-semantics Agent Note](../architecture/2026-06-30-event-domain-semantics.md)'s original stance; rejected here because `dsh-ui-stdio` is a disposable test REPL, not a load-bearing consumer, and it renders boundaries from `session/event` plus its live target object instead.

## Consequences

A plugin can no longer observe turn/step boundaries from a convenient `Agent`-first event. It subscribes to `session/event` and, if it needs the live object, resolves the shared id through `ctx.agents` or retains the object it already owns. That is an acceptable trade: boundary consumers should not depend on a second event feed that can drift from the durable log.
