# Agent Note: SessionTelemetryBackend requires explicit opt-in

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-10-telemetry-default-off.zh.md)

## Problem

DeepSeek Harness has two outbound telemetry feeds. During internal testing, the shared base mounted telemetry with a baked-in production endpoint, and both feeds reported by default to help diagnose reported problems: the session OTel backend could export complete session content, tool data, prompts, and workspace paths when its mode was omitted, while the dsh-sdk launcher feed did so unconditionally. A fresh installation therefore permitted outbound reporting without a positive deployment choice.

## Decision

Both feeds use `DSH_TELEMETRY_MODE` as their positive consent setting. Unset and empty values resolve to `DISABLED`. `@deepseek-ai/dsh-session-telemetry-otel` also resolves an omitted `mode` to `DISABLED`, which constructs no OTel provider, processor, or exporter and leaves feedback in the local session log. The shared dsh base keeps the backend row mounted so disabled feedback can still explain that nothing was shared. A deployment opts into Session Log sharing through `FULL` or `FEEDBACK_ONLY`; only `FULL` also permits dsh-sdk launcher reporting. The shared base's session-backend default was later superseded by the [feedback-gated default](2026-08-25-feedback-gated-telemetry-default.md), which resolves an unset `DSH_TELEMETRY_MODE` to `FEEDBACK_ONLY`; the hard opt-out and the launcher rule below remain current. Any non-empty `DSH_TELEMETRY_DISABLED` remains an authoritative pre-load hard opt-out. The [default-mount decision](2026-07-31-web-telemetry-default-mount.md) continues to own the endpoint, batching cadence, and exit-drain settings.

The dsh-sdk launcher reads the same variable without parsing `cordis.yml` or booting Cordis. `FULL` permits reporting; `FEEDBACK_ONLY`, `DISABLED`, unset, and empty values deny it. Consent is frozen from the launching environment before the command runs, because `dsh-sdk start` loads a project `.env` and project code can mutate `process.env`: resolving afterwards would let a project grant reporting of its own configuration, which the [configuration source ownership decision](../architecture/2026-08-04-configuration-source-ownership.md) denies for the whole `DSH_*` namespace. An unsupported mode denies rather than throwing at that boundary, since telemetry may never change a command's result. This rule superseded the default-on launcher consent before the launcher and its proposal were deleted by the [SDK project toolchain removal](../simplification/2026-08-11-remove-sdk-project-toolchain.md).

The [CLI reference README](../../../../apps/cli/reference/README.md) documents the current deployment stance: the shared base defaults to feedback-gated sharing ([feedback-gated default](2026-08-25-feedback-gated-telemetry-default.md)), `DSH_TELEMETRY_MODE=FULL` and `DSH_TELEMETRY_MODE=DISABLED` are the explicit overrides, and enabled exports can contain complete session content. The restored [testing-stage onboarding notice](2026-08-13-shared-modal-product-onboarding.md) contains no telemetry copy, so the product still presents no prompt about enabling upload.

## Alternatives considered

**Keep opt-out defaults and improve disclosure.** Rejected because disclosure does not make a missing configuration a positive authorization to send data, especially when session telemetry can contain complete local content.

**Default session telemetry to `FEEDBACK_ONLY`.** Rejected because recording feedback would still trigger an upload without a deployment explicitly enabling outbound reporting. The default must keep both the session and its feedback local.

**Add project-level consent markers.** Rejected because `DSH_TELEMETRY_MODE` already expresses consent for both feeds; another configuration entry would create conflicting settings and require launcher-specific parsing.

**Remove both telemetry implementations.** Rejected because internal deployments still need explicit `FULL` and feedback-gated reporting, and the launcher feed remains useful under `FULL`.

## Consequences

Fresh profiles and projects make no telemetry network request until the user records `/feedback` ([feedback-gated default](2026-08-25-feedback-gated-telemetry-default.md)). `FULL` still requires an explicit setting; the launcher feed it once also enabled was deleted with the SDK project toolchain. The existing hard opt-out remains effective, and uploading modes retain their endpoint validation, redaction responsibility, batching, and shutdown behavior.
