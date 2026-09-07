# Agent Note: Feedback-gated session-telemetry default

Status: implemented

English | [中文](2026-08-25-feedback-gated-telemetry-default.zh.md)

## Problem

Diagnosing a `/feedback` report needs the session data the report describes. With the shared base resolving an unset `DSH_TELEMETRY_MODE` to `DISABLED`, a default installation's feedback reached its receiver with no session data at all, and the reporter had no way to grant access at the moment they asked for help; only deployments that had exported `DSH_TELEMETRY_MODE` beforehand ever delivered a diagnosable report.

## Decision

The [explicit-feedback OTel decision](../architecture/2026-09-05-nonofficial-feedback-otel.md) owns upload authorization for all users, including `deepseek-official`. This note retains the rationale for the base default: feedback-gated release rather than continuous export.

The shared base resolves an unset or empty `DSH_TELEMETRY_MODE` to `FEEDBACK_ONLY`. The plugin's own omitted-`mode` default is `DISABLED`; `FULL` rejects, and non-empty `DSH_TELEMETRY_DISABLED` is the pre-load hard opt-out. New own text feedback, message-rating edits, and withdrawals release the unhanded canonical prefix through that event, including stored context. Inherited parent feedback does not authorize a child export.

Feedback-gated release lets a reporter share the Session that exhibited the problem without reproducing it. It trades continuous export for an explicit feedback trigger. The [archived default-off](../../archived/feature/2026-08-10-telemetry-default-off.md) and [default-mount](../../archived/feature/2026-07-31-web-telemetry-default-mount.md) notes record the earlier composition; the [base patch](../../../../packages/bundle/base/cordis.patch.yml) and [OTel README](../../../../packages/session/session-telemetry-otel/README.md) own current configuration.

## Alternatives considered

**Require reporters to re-run after enabling telemetry.** Rejected as the feedback-gated workflow: the Session that exhibited the problem is the useful evidence, and re-running loses it.

**Permit continuous export.** Rejected: deployment configuration does not authorize capture without explicit feedback.

**Use only subsequent DeepSeek requests for delivery.** The independent opt-in contribution can carry canonical feedback, but a final feedback entry may have no later request. OTel releases it for every provider without initiating another LLM request.

## Consequences

- The shipped base releases a bounded prefix only at new explicit feedback. Ordinary requests, lifecycle events, and stored feedback do not trigger capture. Later records wait for the next explicit feedback.
- On-demand capture copies and redacts the canonical log at feedback time. Without a deployment redaction rule, exported data can include message text, tool arguments and results, and workspace paths.
- The command acknowledgement confirms recording, not sharing or delivery. A deployment requiring prior informed consent must provide it before enabling uploads; OTel handoff remains subject to the SDK's batching, retry, and loss policy.
