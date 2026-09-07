# Agent Note: Explicit-feedback-only upload through OpenTelemetry

Status: implemented

English | [中文](2026-09-05-nonofficial-feedback-otel.zh.md)

## Problem

Feedback needs the session context it describes and a delivery path independent of the model provider or a later model request. Ordinary activity must not authorize uploads. Inherited feedback must not count as a child Session's consent.

## Decision

The base mounts OTel in `FEEDBACK_ONLY` for all users and providers, including `deepseek-official` and Sessions without a request header. Only new own `feedback/record`, `feedback/message-put`, and `feedback/message-delete` events authorize capture through that exact canonical event. Text feedback, ratings, material note edits, and withdrawals count. Cold `feedback/committed` notifications supply a committed snapshot without publishing a live Session or Agent.

An authorized prefix includes all unhanded canonical context from seq 0 through the feedback, not just its payload. A child needs its own new feedback; its prefix then includes inherited history. Later records wait for the next explicit feedback. Request activity, request headers, Session creation or adoption, restoration, plugin mount, and HMR never authorize capture; stored feedback alone triggers nothing.

The backend uses on-demand capture with complete history and the existing redaction waterfall. `DISABLED` constructs no transport. `FULL` is rejected rather than aliased. Direct `ctx.sessionTelemetry.emit()` calls are no-ops, so callers cannot bypass feedback authorization. SDK scheduled flush and shutdown may finish previously authorized batches but never capture new records. Sending after submission needs no further user interaction or model call.

The [canonical-feedback decision](2026-09-05-canonical-feedback-log.md) owns storage, versions, deletion, and plain command confirmation. The [opt-in DeepSeek contribution](../../../../packages/session/session-log-deepseek/README.md) remains independent, with its existing destination and acceptance behavior.

## Alternatives considered

**Filter by provider or endpoint hostname.** Feedback authorizes the same bounded context for every user; a provider choice, gateway, or missing header does not change that authorization.

**Use only later DeepSeek requests.** Other providers do not carry `dsh_session_log`, and final feedback may have no subsequent request. The existing OTel pipeline sends independently without a custom uploader or model call.

**Keep continuous capture or replay stored feedback on lifecycle events.** Deployment configuration and old feedback do not authorize new capture. Only a new explicit submission does. Parent feedback likewise cannot authorize a child upload.

## Consequences

Handoff is best-effort, not collector acceptance. Same-object cursors suppress repeated capture, but fresh cold snapshots and new feedback after restart can repeat prefixes; receivers deduplicate on `(session.id, session.format_version, event.seq)`. There is no durable OTel outbox, delivery watermark, or harness HTTP retry promise. SDK batching and loss behavior apply after enqueue. OTel and the opt-in DeepSeek path can overlap. Withdrawal exports a deletion event, not remote erasure.

[OTel tests](../../../../packages/session/session-telemetry-otel/tests/otel.spec.ts) cover explicit-feedback capture, provider-independent behavior, lifecycle silence, fork consent, cold commits, and direct-call denial. [Coordinator tests](../../../../packages/session/session-telemetry/tests/telemetry.spec.ts) cover history capture; [base tests](../../../../packages/bundle/base/tests/base.spec.ts) pin the mounted default.
