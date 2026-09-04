# Agent Note: Fold trace-only session facts into load-bearing events

Status: implemented

English | [中文](2026-06-20-collapse-trace-only-session-events.zh.md)

## Problem

The session event vocabulary includes first-class events that are not part of replayable conversation history and have little or no production consumption. `usage` is already present as a model stream chunk before the loop also appends a separate `usage` event. `error` duplicates the `turn/end { kind: 'error', message, code }` reason for loop failures; ACP settlement reads the turn-end reason, while message and UI projections skip the standalone `error` event.

These events make the canonical transcript look more useful as telemetry than it currently is. They add event variants, invariants, tests, snapshots, and persistence cases, but they are not load-bearing as separate records. The facts they carry can still be useful: token usage should remain available for accounting, and an error's step number should not silently disappear. The simplification is to fold those facts into nearby events consumers already must understand, not to record less information.

## Decision

Standalone trace-only events are removed exactly where their information is preserved without a parallel record:

- Successful-step usage folds into the matching `assistant/message` (`assistant/message { turn, step, content, usage? }`), so the assembled model output and its accounting travel together.
- A failed or aborted step that has usage but no assistant content carries the usage on an empty-content `assistant/message { content: [], usage }` — no persisted usage chunk goes unrepresented. The no-information-loss case is the max-tokens path: a step cut off with usage but empty content (e.g. only a dropped tool call) previously emitted a standalone `usage`. To keep the empty-content event from injecting a spurious content-less assistant turn into the provider transcript, `deriveMessages()` skips empty-content `assistant/message` events; a regression test asserts usage stays represented AND derived history stays uncorrupted.
- The step number from the standalone `error` event folds into `turn/end.reason` for `kind: 'error'` (`{ kind: 'error', step, message, code? }`) — `turn/end` is the durable turn outcome ACP and resume already consume.
- `agent/error` and logging stay for live diagnostics; there is no second session-log error record after `turn/end`.

The user conversation log contains what is needed to render, resume, audit, and account for the interaction without consumers reconciling duplicate trace rows.

## Alternatives considered

**Keep the standalone rows as telemetry** — the events made the canonical transcript look more useful as telemetry than it was, at the cost of event variants, invariants, tests, snapshots, and persistence cases nothing consumed. If analytics become real, the shape is a projection helper or a dedicated telemetry store with its own retention policy — not duplicate trace rows in the conversation log.

## Verification

`SessionEventMap` carries no standalone `usage` or `error`; the loop appends no separate usage event and records durable failures through `turn/end { kind: 'error', step, message, code? }`; ACP snapshots and persistence tests assert no trace-only lines; the frozen v0 codec and identity migration preserve this released representation into current v1; and the docs state where token usage and operational errors are observed.

## Consequences

A consumer can no longer filter the canonical log for standalone `usage` or step-level `error` rows. It must read those facts from the assistant/failure events that carry them. That is a reasonable simplification because the same facts remain present, as the Verification section proves.

## Implementation note

**Format version.** This event simplification predates the released v0 baseline. `dsh-session` owns the current writer constant, while the static catalog and adjacent packages now own supported historical decoding and migration. The identity v0-to-v1 edge proves that lifecycle without changing this event representation.

Usage is now observed on `assistant/message.usage`; an operational error's step on `turn/end.reason` for `kind: 'error'`. `agent/error` + logging are unchanged for live diagnostics.
