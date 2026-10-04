# Agent Note: Event-sourced sessions with derived message history

Status: implemented

English | [中文](2026-06-11-event-sourced-sessions.zh.md)

## Problem

The MVP requires strict event-based tracing with fully replayable sessions (严格的基于事件的trace、logging系统，session完全可回放).

## Decision

A `Session` is an append-only log of typed `SessionEvent`s — the single source of truth. The LLM message history is *derived* from the log (`deriveMessages()`); raw stream chunks are logged for token-level replay fidelity while the assembled `assistant/message` event is authoritative for derivation. Replay/fork = seed a new session with an existing log.

Appends are synchronous (the hot path never blocks on I/O); `session/event` is a sync notification; persistence plugins buffer write-behind and drain at the awaited `session/flush` checkpoint fired at every turn end.

Ordering contract: the loop claims inbox messages before `agent/pre-step`, opens `step/start` only after an enter decision, then appends the returned `user/message` batch before request derivation. Provider output is assembled and appended as `assistant/message` before tool dispatch, so the durable log records the exact message the tools follow. Regression tests pin that ordering.

## Alternatives considered

**A mutable message array with events fired as notifications** — simpler, but state and log can diverge; with event-sourcing the log IS the state, so divergence is structurally impossible.

## Consequences

- Replay, trace, and telemetry are structurally guaranteed, not bolted on.
- Persistence stays a plugin concern; the in-memory store ships in dsh-session.
- The event vocabulary is merge-extensible (plugins add e.g. compaction events); [session persistence](../../../../packages/session/session-persistence/README.md) froze its shape once the log became durable.
- Derivation cost grows with log length — compaction (dsh-compaction) is the intended mitigation, not log mutation.
