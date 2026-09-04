---
description: "OpenTelemetry session-telemetry backend for deployments choosing a mode, configuring the exporter, or tracing what leaves the machine."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-telemetry-otel

English | [中文](README.zh.md)

## Summary

`dsh-session-telemetry-otel` delivers session records through OpenTelemetry logs and is the only entry a deployment loads for the [session-telemetry seam](../session-telemetry/README.md). Its `mode` decides whether session records follow the live stream, are released only at recorded feedback, or stay local: `FULL` hands every record to the OTel SDK immediately, `FEEDBACK_ONLY` replays the canonical log when a `feedback/record` lands, and `DISABLED` (the default) constructs nothing and shares nothing. Uploading modes compose the OTel JS SDK as-is — `LoggerProvider` → `BatchLogRecordProcessor` → OTLP/HTTP log exporter — and map each record onto `logger.emit()`, so batching, retry, queueing, and loss policy follow the SDK. Records carry the complete event data as the seam's redaction waterfall returns it, so a deployment exporting beyond a trusted boundary mounts its own redaction rules. Modes, configuration, and the export surface come first; the implementation internals live in a collapsible developer section below.

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
| `FULL` | Every captured record, including every canonical event and lifecycle ops record, is handed to the OTel SDK immediately |
| `FEEDBACK_ONLY` | Each `feedback/record` replays, copies, and redacts every canonical event after the handoff cursor through that event; later records wait for another feedback event and remain local if none arrives |
| `DISABLED` | Default. No coordinator, provider, processor, or exporter is constructed; no telemetry record leaves the process, and a `feedback/record` logs that nothing will be shared |

Programmatic TypeScript configuration uses the exported `SessionTelemetryMode` enum; raw string literals are not assignable. The mounted service discloses the resolved mode through the seam's [`SessionTelemetrySharingStatus`](../session-telemetry/README.md#the-sharing-disclosure) `sharing` property (`full` / `feedback-only` / `disabled`), so the `/feedback` acknowledgement reports whether and how the session is shared — even `DISABLED` discloses `disabled`.

### Minimal configuration

Uploading modes require an exporter URL and accept the SDK option blocks verbatim:

```yaml
- id: sessionTelemetry-otel
  name: '@deepseek-ai/dsh-session-telemetry-otel'
  config:
    mode: FULL                # explicit opt-in; default: DISABLED
    shutdownTimeoutMillis: 3000 # optional; defaults to 3000
    exporter:                # passed verbatim to the SDK's OTLP/HTTP log exporter
      url: https://collector.example.com/v1/logs
      headers:
        authorization: !!js `Bearer ${process.env.OTLP_TOKEN}`
    processor: {}            # optional; passed verbatim to BatchLogRecordProcessor
```

| Field | Default | Meaning |
|---|---|---|
| `mode` | `DISABLED` | Sharing policy: `FULL`, `FEEDBACK_ONLY`, or `DISABLED` |
| `exporter.url` | required in uploading modes | Full OTLP logs endpoint; must parse as `http(s)` |
| `exporter`, `processor` | — | Passed verbatim to the SDK exporter and batch processor |
| `shutdownTimeoutMillis` | `3,000` | Outer deadline for the SDK's complete shutdown sequence |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-telemetry-otel) is the exhaustive source for every accepted field. Upload authorization is positive and fail-closed: an unknown direct-construction mode fails before transport configuration is read, only `FULL` accepts direct `ctx.sessionTelemetry.emit()` calls, and `FEEDBACK_ONLY` treats only the exact `feedback/record` object already stored in the canonical log as consent.

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

The backend is a thin adapter over the OTel JS SDK: it owns capture mode, resource identity, and an outer shutdown deadline, and passes everything else through verbatim. Two instrumentation scopes separate record channels — ledger records on `@deepseek-ai/dsh-session-telemetry-otel`, operational records on `@deepseek-ai/dsh-session-telemetry-otel/ops` — so receivers can alert on ops without summing them. Resource identity carries `service.name`/`service.version` from `dsh-llm`'s `APP_IDENTITY` plus the package's anonymous `user.id` (from `$DSH_HOME/.anonymous-user-id`), once per export batch rather than per record.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: mode resolution, fail-closed validation, SDK pipeline wiring, coordinator composition, shutdown deadline |

### Capture wiring

`FULL` composes the coordinator in `live` mode and lets direct service calls through; `FEEDBACK_ONLY` composes it in `on-demand` mode, gives the coordinator a private backend capability, and triggers `captureSession(session, event.seq)` only when `session.eventAt(event.seq) === event` confirms the exact canonical feedback record; `DISABLED` registers nothing but a warning on `feedback/record`. The backend deliberately implements no `flush()`: the batch processor owns ordinary flushing, and forwarding the hint to `forceFlush()` would create the sole source of concurrent flushes whose interaction with shutdown's drain is undocumented.

### Field mapping

Each seam record maps onto one SDK log record: `time` and `severity` become the SDK timestamp and severity fields, and `body` and `attributes` carry through verbatim; the exact field mapping lives in [`src/index.ts`](src/index.ts). In `FULL`, receivers can detect crashes by `shutdown`-record absence — the marker is emitted at the session's own disposal or application teardown, and a marker followed by more events is a telemetry reload. In `FEEDBACK_ONLY`, a released prefix normally has no later `shutdown` marker, so its absence is not a crash signal.

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
- **Feedback-time snapshot** — `FEEDBACK_ONLY` retains no telemetry-owned copy before feedback; it reads and redacts the current canonical log when feedback is recorded, so a crash before feedback uploads nothing and policy changes before feedback affect what that replay exports.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Mode selection changes capture handoff, SDK setup, and local diagnostics without mutating session or service state an independent companion can compare. Export remains inside the SDK past the backend boundary.
