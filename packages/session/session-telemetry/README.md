---
description: "Session-telemetry capture seam for deployments and backend authors choosing a reporting backend, mounting redaction rules, or implementing the backend contract."
kind: "package-library"
---

# @deepseek-ai/dsh-session-telemetry

English | [中文](README.zh.md)

## Summary

`dsh-session-telemetry` captures session activity for outbound reporting: it copies each session event into a telemetry record, lets a deployment redact it, and hands it to a reporting backend that implements the contract. Deployments do not load this package directly — they load exactly one backend (the shipped OpenTelemetry backend is `dsh-session-telemetry-otel`), which registers `ctx.sessionTelemetry` and composes the capture coordinator. The seam owns capture, redaction, and the sharing disclosure; batching, retry, queueing, and loss policy belong to the backend's SDK and stop at `emit()`. Every mounted backend discloses its deployment-selected sharing policy so acknowledgement surfaces can report whether and how a session is shared. The contract and capture behavior come first; the implementation internals live in a collapsible developer section below.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

As a deployment, choose a backend, mount it, and add redaction rules when records must not leave the process as captured. As a backend author, implement the three-member contract and compose the coordinator with a capture mode.

### Choosing and mounting a backend

Load exactly one backend plugin; it registers `ctx.sessionTelemetry` with the capture coordinator and its own delivery pipeline, and a duplicate load throws. The mounted backend discloses its sharing policy through the required [`sharing` member](#the-sharing-disclosure), which the `/feedback` acknowledgement renders; a consumer renders "not configured" only when no telemetry service is mounted.

### The backend contract

A backend implements three members: `emit(record)` must be a non-blocking enqueue because it runs synchronously on the session-event path; optional `flush()` is a fire-and-forget hint after a turn ends, which most backends omit in favor of their SDK's own batching schedule; `shutdown()` drains queued records and resolves when the SDK stops, and disposal awaits it. A backend that implements `flush()` must order concurrent flushes with the final `shutdown()` drain.

### What gets captured

Capture runs in one of two modes. `live` capture follows session events as they are appended, replays already-live sessions at mount time, and records lifecycle markers; `on-demand` capture reads the canonical session log only when the backend requests a prefix through `captureSession(session, throughSeq?)`. Every canonical session event maps to one ledger record in order. An `assistant/message` or `assistant/attempt` record carries its complete embedded compact stream, including failed and retried output. Each ledger record also carries `session.id`, `session.format_version`, the numeric event identity, optional header facts, and a pre-mapped severity (`error` for `tool/result.isError`, `turn/end` error reasons, and `agent-error`; `info` otherwise).

### The sharing disclosure

<a id="the-sharing-disclosure"></a>

Every backend discloses its deployment-selected sharing policy through the seam's `sharing` vocabulary: `full` (every event is handed over as it happens), `feedback-only` (nothing is handed over until a `feedback/record` event releases the unreleased prefix), or `disabled` (nothing is handed over at all). The acknowledgement of a recorded feedback entry reports this status; the disclosure never claims delivery — handoff is the non-blocking enqueue, and batching, retry, and loss policy stay the backend SDK's.

### Redacting records

<a id="the-redact-waterfall"></a>

Every outbound record passes the `sessionTelemetry/record` waterfall after the coordinator copies its canonical event. This package ships no rules: with no listener mounted, records reach the backend exactly as captured, so exported data is as clean as the rules a deployment mounts. Listeners stack by transforming `next()`'s return value; a throwing listener withholds that one record fail-closed. Redaction applies to the outbound copy only — the canonical session log is never rewritten.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the capture design; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The seam is built on one boundary: the harness's aspect ends at `emit()`. Complete event capture, redaction, and the handoff cursor live here; batching, retry, queueing, and loss policy are the reporting SDK's, deliberately not modelled or wrapped. The design and rejected alternatives are pinned in the [revival Agent Note](../../../.agents/notes/implemented/feature/2026-07-23-session-telemetry-otel-revival.md).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service Definition: `SessionTelemetryBackend`/`SessionTelemetrySink` contract, record vocabulary, `session-telemetry/record` waterfall declaration |
| [`src/coordinator.ts`](src/coordinator.ts) | Capture: live listeners, lifecycle-local on-demand replay, redaction, handoff cursor, containment |

### Capture flow

Live capture registers, through the composing fiber's effects: `session/created` adopts the session and replays its lifecycle-local log suffix from the handoff cursor; `session/event` deep-copies, redacts, and hands off each event with zero I/O; `session/flush` forwards the optional hint and returns void so the loop's awaited parallel never waits on telemetry; `session/disposed` captures the session's `shutdown` marker and retires it; `agent/error` is the one live-bus relay, because the session-event vocabulary intentionally has no operational-error record. Disposal captures shutdown markers for still-live sessions, then awaits the backend's `shutdown()`. On-demand capture registers only the disposal effect and reads the requested lifecycle-local canonical-log prefix on request. Every synchronous handler runs inside containment so a failing backend or rule can never starve other listeners or reach the agent loop.

### The handoff cursor

A module-scope `WeakMap<Session, seq>` records, per Session object, the highest seq handed off (not delivered). Live capture advances it at append time; on-demand capture advances it only while handing a requested prefix. Re-adopting the same object resumes after that cursor and does not duplicate its handed-off ledger records. A new Session object starts immediately before `firstLiveSeq`: a fresh object starts at seq 0, while a forked, resumed, or migrated object skips its constructor seed and starts with this lifecycle's `session/end-seed` boundary. This keeps inherited and previously persisted history outside a new lifecycle's sharing act. Receivers absorb SDK retries by deduplicating on `(session.id, session.format_version, event.seq)`. The object-keyed map is a narrow, documented exception to the registrations-are-effects discipline: entries die with their sessions, and losing one can replay only the current lifecycle suffix.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the seam contract is not enough. They move from the shipped backend to the subsystem reference and the decision evidence.

- [OpenTelemetry telemetry backend](../session-telemetry-otel/README.md) — the shipped backend deployments load, with mode and exporter configuration.
- [Session telemetry subsystem](../../../docs/subsystems/session-telemetry.md) — the capability split and type declarations.
- [Session telemetry revival decision](../../../.agents/notes/implemented/feature/2026-07-23-session-telemetry-otel-revival.md) — rationale, trade-offs, and rejected alternatives.
- [Session package map](../README.md) — adjacent persistence, projection, title, and telemetry packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as the seam observes the session stream and hands redacted copies outward; it registers nothing model-facing.

#### KV Cache effect

None; the package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the delivery and data-protection guarantees a deployment gets. They are current package constraints.

- **Best-effort delivery** — the cursor marks handed-off, not delivered; a session torn down inside a reload window cannot be re-adopted, and whatever sits in a backend queue at crash time is lost. A durable outbox (spool, per-sink cursors, at-least-once) is deferred until a deployment states a crash-loss requirement.
- **No built-in redaction rules** — with no `sessionTelemetry/record` listener mounted, records leave the process exactly as captured, including any credentials embedded in file contents or command output; a deployment exporting to a shared collector owns its rule set.
- **On-demand redaction uses current state** — uncaptured events exist only in the canonical session log; a later `captureSession()` deep-copies and redacts their current values with the policy mounted at that time, and there is no capture-time telemetry snapshot or durable pre-capture spool.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The package's whole output is the backend handoff — a synchronous `emit()` call outside every authoritative event stream — and its capture side never appends session events, so no event/data relation exists for an independent companion to observe.
