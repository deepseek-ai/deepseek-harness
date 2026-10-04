# Agent Note: Truncate interrupted final turns on load

Status: rejected — a single turn can contain substantial real work, including many steps and large tool output. Preserving interrupted turns is preferable to silently dropping that tail on load.

English | [中文](2026-06-20-truncate-interrupted-turns.zh.md)

## Problem

The current persistence contract preserves a final turn that was durably written but never closed. On load, `interruptedTurnClosers()` scans the tail, synthesizes error `tool/result` events for unanswered tool calls, appends a `step/end` when a step is open, appends `turn/end { kind: 'interrupted' }`, and asks the backend to durably commit that repair. The coordinator, JSONL backend, SQLite backend, session event vocabulary, invariants, docs, and tests all model this synthetic close path.

This is a lot of machinery to preserve partial work from the last crashed turn. It also invents events that never happened. A synthetic tool result is useful because it makes provider history valid, but it also means the resumed log contains model-visible text that no tool produced. The current design optimizes for maximum tail preservation before there is a released product or a real resume UX that proves partial-turn recovery matters.

## Proposal

On load, keep only the last completed turn. A backend still tolerates and truncates a torn final record, but if the parsed durable prefix ends after an open `turn/start`, the canonical repair is to drop every event after the previous `turn/end`. No synthetic `tool/result`, no synthetic `step/end`, no `turn/end { interrupted }`, and no `interrupted` turn-end reason.

This makes the persisted turn boundary simple: a completed `turn/end` is the checkpoint. Anything after the last checkpoint is crash tail. The next prompt resumes from the last known-valid provider transcript, not from a partially reconstructed final turn.

## Acceptance criteria

- `TurnEndReasonMap` drops the `interrupted` variant.
- `interruptedTurnClosers()` and its tests disappear.
- The persistence coordinator's repair hook truncates backend-specific torn/open tail state without appending closers.
- [Session persistence docs](../../../../packages/session/session-persistence/README.md) say load returns the last completed turn, plus no partial final turn.
- Snapshot and contract tests update together with the behavior they pin.
- The session format version and recorded fixtures are refreshed; non-current stored logs are rejected per the pre-release format policy, with no migration path.

## What we give up

A crash can lose real work from the final turn: assistant text, tool calls, and tool output appended after the previous `turn/end`. That is the deliberate simplification. The product is unreleased, the final-turn recovery semantics are not user-proven, and a clean completed-turn checkpoint is much easier to explain, test, and implement. A future "recover partial crashed work" feature should be designed as an explicit user-facing recovery view, not as synthetic events silently inserted into the canonical transcript.

## Related

This is a direct simplification of [session persistence](../../../../packages/session/session-persistence/README.md) and the historical [universal turn-enclosure rule](../../archived/architecture/2026-06-15-turn-enclosure-invariant.md). It also removes much of the motivation for durable step boundary events, making [drop durable step boundary events](2026-06-20-drop-durable-step-boundaries.md) smaller.

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->
