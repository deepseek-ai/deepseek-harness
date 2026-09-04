# Agent Note: Event-domain semantics — session is the fact log, agent is the live event channel

Status: implemented

English | [中文](2026-06-30-event-domain-semantics.zh.md)

## Problem

The harness extends the agent loop through a Cordis event taxonomy (see [the microkernel event-taxonomy Agent Note](2026-06-11-microkernel-event-taxonomy.md)). As that taxonomy grew, the line between the three event domains blurred:

- `session/*` carries the durable, event-sourced log (`SessionEventMap`).
- `agent/*` carries live runtime signals that hand a plugin the `Agent` handle.
- `tools/*` carries the tool registry and execution pipeline.

Two problems motivated pinning the semantics down. First, several turn/step boundaries existed BOTH as a durable `SessionEvent` (`turn/start`, `turn/end`, `step/start`, `step/end`) AND as a mirrored `agent/*` emit (`agent/turn-start`, `agent/turn-end`, `agent/step-start`, `agent/step-end`). A consumer had two sources of truth for the same fact, and every lifecycle change had to update both. Second, the Hooks subsystem needs ONE coherent, documented surface to subscribe to — a plugin author (and the Claude Code / Codex hook bridges built on top) must know, without reading the loop, whether to listen on a session event or an agent event, and why.

This vocabulary is the foundation for interception decisions, the durable `hook/*` log, and the Claude Code and Codex bridges.

## Decision

**Three domains, one job each, with a single boundary rule.**

- **`session/*` — the durable, replayable FACT log.** Owns `SessionEventMap`; every entry is JSON-only (no live objects). One `session/event` emit per append, plus the `session/flush` parallel durability checkpoint. It is also the live transcript feed: a consumer that wants to render or react to what happened subscribes here, so live rendering and replay projections share one path.
- **`agent/*` — the LIVE runtime surface.** Always carries the live `Agent`. Interception waterfalls (`agent/pre-step`, `agent/request`, `agent/request-error`) transform, reject, or recover; awaited `agent/turn-stopping` observes the stop boundary; transient emits report lifecycle, status, inbox insertion/claim/discard, errors, and process-local `agent/assistant-stream` frames. Turn and step BOUNDARIES are NOT here — they are durable session events read off `session/event`; Assistant stream evidence becomes durable only inside one `assistant/message` or `assistant/attempt` settlement, and mid-turn steering is a durable `user/message`.
- **`tools/*` — the tool registry and execution pipeline.**

**The boundary rule:** a durable, replayable fact is a `SessionEvent`; a live interception or a transient/live-object signal is an `agent`/`tools` Cordis event. A turn or step boundary is a durable fact, so it lives in the session log and is read off the `session/event` feed — it is NOT mirrored as an `agent/*` emit.

**Applying the rule to the boundary twins:** all four boundary mirrors — `agent/turn-start`, `agent/turn-end`, `agent/step-start`, `agent/step-end` — are **REMOVED**. No production consumer needs the live `Agent` at a boundary: the ACP bridge correlates its in-flight prompt with the exact `session/event` `turn/start`/`turn/end` pair, and other transcript consumers likewise derive boundaries from the durable stream. See [the remove-boundary-mirror-events Agent Note](../simplification/2026-06-20-remove-agent-boundary-mirror-events.md), which owns that decision. Removing the emits also simplifies the loop's `closeStep`/`closeTurn` (one append each, no paired emit).

## Consequences

- The loop no longer emits any boundary mirror; `closeStep` appends `step/end` only and `closeTurn` appends `turn/end` only. `Session.append` owns post-commit observer containment, so a throwing boundary observer cannot change the turn outcome or starve later consumers; an acceptance or internal validation failure still escapes before the boundary enters the log.
- Tests that observed boundaries via the removed emits now observe the durable `turn/start`/`turn/end`/`step/start`/`step/end` session events — the behavior they pin (boundary ordering, step counting) is unchanged; only the feed they read moved to the canonical one. The tests that exercised a *throwing turn-boundary emit listener* were deleted, because that code path no longer exists (there is no emit to throw from). Per [AGENTS.md "tests document behavior, not golden truth"](../../../../AGENTS.md), the behavior and its test moved (or died) together.
- The loop marks the step open (`stepOpen = true`) only after `append('step/start')` returns. Internal dispatch validation runs before the log push and may reject without opening a step; post-commit `session/event` observer failures are contained inside `Session.append`. The marker therefore represents exactly the committed boundary that owes a later `step/end`.
- The full realization of this is [the simplification Agent Note "Stop mirroring durable boundaries as agent events"](../simplification/2026-06-20-remove-agent-boundary-mirror-events.md): all four boundary mirrors are removed and every consumer reads boundaries off `session/event`. `agent/steering` (not a boundary mirror) stayed outside that Agent Note's scope and was removed by its own follow-up, [Remove the `agent/steering` mirror emit](../../archived/simplification/2026-07-04-remove-agent-steering-mirror.md) — it mirrored the durable mid-turn steering `user/message`.
- The generated cordis event surface (the `docs/subsystems/` pages) no longer lists the mirror events.

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->
