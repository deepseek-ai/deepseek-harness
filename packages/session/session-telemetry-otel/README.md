---
description: "OpenTelemetry session-telemetry backend for deployments choosing a mode, configuring the exporter, or tracing what leaves the machine."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-telemetry-otel

English | [中文](README.zh.md)

## Summary

`dsh-session-telemetry-otel` exports session records through the OTel JS SDK only after new explicit feedback, for all users and providers, including `deepseek-official`. `FEEDBACK_ONLY` releases the canonical prefix through that feedback, including context; later records wait for the next explicit feedback. `DISABLED` constructs no transport. SDK batching can finish an authorized upload without another user interaction or model call. Deployments own their redaction rules.

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

Mount this plugin when a deployment should export session records through OpenTelemetry logs. Choose a mode, give the exporter an endpoint, and decide whether to mount redaction rules on the seam.

### Modes

| `mode` | Behavior |
|---|---|
| `FEEDBACK_ONLY` | Default. Text feedback, rating creation/edit, note edit, and withdrawal release the unhanded prefix through that canonical feedback event; later records wait |
| `DISABLED` | No coordinator, provider, processor, or exporter is constructed; no telemetry record leaves the process. Live feedback warns locally; cold mutations stay silent |

Programmatic TypeScript configuration uses the exported `SessionTelemetryMode` enum; raw string literals are not assignable. `FULL` is rejected, not an alias. The [`sharing` property](../session-telemetry/README.md#the-sharing-disclosure) reports `feedback-only` or `disabled`, not a delivery receipt. The `/feedback` acknowledgement confirms recording only.

### Minimal configuration

Uploading modes require an exporter URL and accept the SDK option blocks verbatim:

```yaml
- id: sessionTelemetry-otel
  name: '@deepseek-ai/dsh-session-telemetry-otel'
  config:
    mode: FEEDBACK_ONLY       # optional; defaults to FEEDBACK_ONLY
    shutdownTimeoutMillis: 3000 # optional; defaults to 3000
    exporter:                # passed verbatim to the SDK's OTLP/HTTP log exporter
      url: https://collector.example.com/v1/logs
      headers:
        authorization: !!js `Bearer ${process.env.OTLP_TOKEN}`
    processor: {}            # optional; passed verbatim to BatchLogRecordProcessor
```

| Field | Default | Meaning |
|---|---|---|
| `mode` | `FEEDBACK_ONLY` | Sharing policy: `FEEDBACK_ONLY` or `DISABLED` |
| `exporter.url` | required in uploading modes | Full OTLP logs endpoint; must parse as `http(s)` |
| `exporter`, `processor` | — | Passed verbatim to the SDK exporter and batch processor |
| `shutdownTimeoutMillis` | `3,000` | Outer deadline for the SDK's complete shutdown sequence |

Direct `ctx.sessionTelemetry.emit()` calls are no-ops in every mode and cannot bypass feedback authorization. Inherited parent feedback does not authorize a child export: the child needs new feedback of its own. Its authorized prefix then includes inherited context.

Model requests, request headers, Session creation or adoption, restoration, and plugin mount or HMR do not authorize capture. Stored feedback alone triggers nothing. SDK scheduled flush and shutdown may finish batches authorized earlier, but never capture new records.

### What leaves the machine

In uploading modes, records carry the complete `event.data` as the seam's `sessionTelemetry/record` waterfall returns it — message content, tool arguments and results, the system prompt and tool schemas, todo text, compaction summaries, feedback text, and the session `cwd`. Provider credentials never appear: adapter API keys are constructor parameters, not session events, so they are structurally absent from the log and therefore from telemetry. `DISABLED` constructs no SDK pipeline and hands no capture to a backend.

### Failures and shutdown

Misconfiguration fails at plugin load: a missing or non-`http(s)` `exporter.url`, a non-positive-integer `processor.maxExportBatchSize` (which the SDK accepts but then hangs on at shutdown), and an invalid `shutdownTimeoutMillis` all reject before any record is exported. During shutdown, OTel awaits `exporter.forceFlush()` before the processor's bounded completion promise; if that transport promise never settles, this package abandons the wait at `shutdownTimeoutMillis`, logs the contained failure, and lets application teardown continue — records still pending then may be lost at process exit.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the backend's composition; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The backend is a thin adapter over the OTel JS SDK: it owns feedback authorization, resource identity, and an outer shutdown deadline. Canonical ledger records use the `@deepseek-ai/dsh-session-telemetry-otel` instrumentation scope; this backend captures no operational records. Resource identity carries `service.name`/`service.version` from `dsh-llm`'s `APP_IDENTITY` plus the anonymous `user.id` (from `$DSH_HOME/.anonymous-user-id`), once per export batch rather than per record.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: mode resolution, fail-closed validation, SDK pipeline wiring, coordinator composition, shutdown deadline |

### Capture wiring

The backend uses on-demand capture with stored history included. Only new own `feedback/record`, `feedback/message-put`, or `feedback/message-delete` events trigger live capture, bounded by that event. A cold `feedback/committed` notification supplies its committed canonical snapshot without publishing a live Session or Agent. Same-object handoff cursors suppress repeated capture. The backend implements no `flush()`; the SDK owns batching and shutdown drain.

### Field mapping

Each telemetry record maps to one SDK log record with captured timestamp, severity, body, and attributes. Feedback authorizes the complete unhanded prefix, not only the feedback payload.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the backend contract is not enough. They move from the seam it implements to the subsystem reference and the identity it reports.

- [Session telemetry seam](../session-telemetry/README.md) — the capture contract, record vocabulary, and redaction waterfall.
- [Session telemetry subsystem](../../../docs/subsystems/session-telemetry.md) — the capability split and type declarations.
- [Anonymous user identity](../../identity/anonymous-user-id/README.md) — the id reported as the OTel Resource `user.id`.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-telemetry-otel) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

None, as the backend forwards seam records into the OTel SDK pipeline and registers nothing model-facing.

#### KV Cache effect

None; the package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where SDK behavior governs and where export guarantees end. They are current package constraints.

- **Upstream experimental tree** — `@opentelemetry/sdk-logs` is published from the upstream experimental tree; SDK API churn lands here and only here, while the seam contract does not move.
- **Live-collector behavior belongs to the SDK exporter** — authentication, TLS, throttling, and other real OTLP deployment behavior follow the upstream SDK rather than a package-owned compatibility layer.
- **Best-effort handoff** — new cold snapshots and a new feedback submission after restart can repeat prefixes; receivers deduplicate by Session id, format version, and event seq. There is no durable outbox, delivery watermark, automatic retry promise, or collector-acceptance guarantee. OTel and the opt-in DeepSeek API path can overlap. Withdrawal exports a deletion event, not remote erasure.

- **Backend availability** — feedback submitted while this plugin is disabled or unloaded is recorded locally but not automatically replayed when it returns. Capture requires the subscriber to remain mounted until it observes the submission; unloading during a pending cold write can miss its post-flush notification.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Mode selection changes capture handoff, SDK setup, and local diagnostics without mutating session or service state an independent companion can compare. Export remains inside the SDK past the backend boundary.
