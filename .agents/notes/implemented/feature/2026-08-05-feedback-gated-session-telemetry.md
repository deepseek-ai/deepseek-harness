# Agent Note: Feedback-gated session telemetry

Status: implemented

English | [中文](2026-08-05-feedback-gated-session-telemetry.zh.md)

## Problem

Session telemetry originally has one mounted behavior: every accepted record enters the reporting backend immediately. Deployments need two stricter policies without replacing the plugin: hold a session's telemetry unless its user records feedback, or disable reporting while still explaining what happens to feedback. The policy must preserve the telemetry seam's redaction-before-backend boundary.

## Decision

`@deepseek-ai/dsh-session-telemetry-otel` exposes the string-valued `SessionTelemetryMode` enum to TypeScript callers and accepts the same three uppercase `mode` values in serialized configuration:

- `FULL` explicitly selects immediate delivery to the configured OTel pipeline.
- `FEEDBACK_ONLY` reads the canonical session log when `feedback/record` is appended and hands over the unreleased prefix through that exact event. Records appended after that boundary remain local until another feedback event.
- `DISABLED` is the [default](2026-08-10-telemetry-default-off.md), constructs no exporter, processor, or logger provider, and prints that nothing is shared and the feedback remains local when it observes `feedback/record`.

The generic telemetry coordinator owns `live` and `on-demand` capture. Live capture deep-copies, redacts, and hands every canonical event to the backend on the session firehose. On-demand capture registers no continuous capture listeners; `captureSession(session, throughSeq)` reads the canonical log after the same-object handoff cursor through an inclusive boundary, then deep-copies, redacts, and hands over every event in that prefix. A new Session object begins immediately before `firstLiveSeq`, so a fresh object starts at seq 0 while a forked, resumed, or migrated object skips its constructor seed and starts with this lifecycle's boundary; re-adopting or recapturing the same object starts after its highest handed-off seq. The [buffer-free replay decision](../simplification/2026-08-06-buffer-free-feedback-telemetry.md) owns why the on-demand path uses the canonical log instead of copied records.

Mode resolution is a closed, fail-before-setup check: an unknown direct-construction value fails before transport configuration is read. Only `FULL` exposes the public service's `emit()` path to the SDK pipeline. `FEEDBACK_ONLY` gives its on-demand coordinator a private backend capability; its listener passes an event to `captureSession()` only when `session.eventAt(event.seq)` returns that exact `feedback/record` object. `Session.append` commits that object before publishing `session/event`, so replay includes the feedback but cannot extend past its boundary. `DISABLED` creates neither the capability nor the SDK pipeline and does not inspect exporter configuration.

## Alternatives considered

**Open a session permanently after its first feedback.** Rejected because later work would be shared without another feedback act and the plugin would need additional open-session state. Releasing one pending prefix per feedback has the smaller state machine and the narrower sharing boundary.

**Retain capture-time redacted records until feedback.** Rejected because it duplicates an unbounded session prefix even though the canonical log already owns the events. It preserves capture-time redaction policy and operational records, but those properties do not justify the memory cost for a mode defined as uploading the session log after feedback.

**Temporarily allow public `emit()` calls during feedback replay.** Rejected because a redaction listener or another reentrant caller could enqueue an unrelated record while the flag was open. A private backend capability makes authorization structural and keeps the public service closed throughout replay.

**Use an unmounted plugin as the disabled state.** That remains the silent opt-out, but it cannot warn when feedback is recorded. The explicit disabled mode lets a deployment keep one configuration shape and communicate that the local feedback did not leave the process.

## Consequences

`FULL` hands off every lifecycle-local canonical event as an explicit opt-in. `FEEDBACK_ONLY` adds no telemetry-owned per-event buffer before feedback; direct service calls and non-canonical feedback events upload nothing, and a crash before feedback uploads nothing. The first feedback on a new resumed or migrated object excludes restored constructor history and includes only this lifecycle's boundary and suffix through that feedback; later feedback on the same object captures only the suffix after its cursor. Replay applies the redaction policy mounted when feedback is recorded and excludes operational records that do not exist in the canonical log, so feedback-only streams carry neither `agent-error` nor `shutdown` records and shutdown absence is not a crash signal. Same-object replay after lost cursor state and backend retries can duplicate lifecycle-local ledger rows; receivers deduplicate on `(session.id, session.format_version, event.seq)`. `DISABLED` can omit `exporter.url`, does no reporting work, and keeps feedback only in the canonical session log.
