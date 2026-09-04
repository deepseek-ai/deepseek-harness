# Agent Note: Feedback-gated session-telemetry default

Status: implemented

English | [中文](2026-08-25-feedback-gated-telemetry-default.zh.md)

## Problem

Diagnosing a `/feedback` report needs the session data the report describes. With the shared base resolving an unset `DSH_TELEMETRY_MODE` to `DISABLED`, a default installation's feedback reached its receiver with no session data at all, and the reporter had no way to grant access at the moment they asked for help; only deployments that had exported `DSH_TELEMETRY_MODE` beforehand ever delivered a diagnosable report.

## Decision

The shared dsh base resolves an unset or empty `DSH_TELEMETRY_MODE` to `FEEDBACK_ONLY` instead of `DISABLED`. Nothing is uploaded before the user records `/feedback`. On a Session object already captured, each feedback uploads the suffix after the last handoff through that exact event. A new object starts at its constructor boundary: a fresh Session begins at seq 0, while a forked, resumed, or migrated Session excludes its constructor seed and begins with this lifecycle's `session/end-seed`. The acknowledgement's sharing disclosure therefore matches the released lifecycle-local prefix. `FULL` and `DISABLED` remain explicit `DSH_TELEMETRY_MODE` overrides, any non-empty `DSH_TELEMETRY_DISABLED` remains the authoritative pre-load hard opt-out, and the plugin's own omitted-`mode` default stays `DISABLED`: the default changes only in the shared base's config expression, where deployments already override it.

This supersedes the session-backend default of the [default-off decision](2026-08-10-telemetry-default-off.md), accepting the user's explicit feedback action as the release authorization that note required a deployment setting for. That note's hard opt-out and its launcher-feed history remain current, and the [default-mount decision](2026-07-31-web-telemetry-default-mount.md) continues to own the endpoint, batching cadence, and exit-drain settings.

## Alternatives considered

**Keep `DISABLED` and instruct reporters to re-run with `DSH_TELEMETRY_MODE=FEEDBACK_ONLY`.** Rejected: the session that exhibited the problem is the one worth uploading, and re-running loses it.

**Default to `FULL`.** Rejected: continuous export without any user action is exactly what the default-off decision forbids, and nothing in a fresh installation authorizes it.

**Gate the official DeepSeek `dsh_session_log` request contribution on feedback instead of reviving the OTel default.** Not taken here: that contribution uploads through subsequent LLM requests rather than at the feedback boundary, so a session's final feedback would never be delivered; a feedback-triggered flush on that path is a larger design than a default flip.

## Consequences

- A fresh installation uploads the not-yet-shared session-log records to the production collector when — and only when — the user records `/feedback`; no other trigger uploads.
- Released exports remain the raw captured copy: the shipped base mounts no `session-telemetry/record` redaction rule, so they can contain message text, tool arguments and results, and workspace paths.
- The sharing disclosure is part of the `/feedback` acknowledgement, so the user reads it after the release has been triggered. A deployment that requires prior informed consent must override the default to `DISABLED` or add a pre-upload confirmation before this default is defensible there.
