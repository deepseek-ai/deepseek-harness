---
description: "OpenTelemetry session-telemetry backend for deployments choosing a mode, configuring the exporter, or tracing what leaves the machine."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-telemetry-otel

English | [中文](README.zh.md)

## Summary

The adapter injects `otel`; the [shared OTel plugin](../../telemetry/otel/README.md) creates its independent Session-log channel. Authorization, redaction, identity, scope version, configuration, and the shutdown deadline remain owned here.

`dsh-session-telemetry-otel` exports session records through the OTel JS SDK only after new explicit feedback, for all users and providers, including `deepseek-official`. `FEEDBACK_ONLY` releases the canonical prefix through that feedback, including context; later records wait for the next explicit feedback. `DISABLED` constructs no transport. Scheduled batching can finish an authorized upload without another user interaction or model call. Deployments own their redaction rules.

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

Uploading modes require an exporter URL. Processor settings control the independent Session-log queue; routing headers are explicit `exporter.headers` values.

```yaml
- id: sessionTelemetry-otel
  name: '@deepseek-ai/dsh-session-telemetry-otel'
  config:
    mode: FEEDBACK_ONLY       # optional; defaults to FEEDBACK_ONLY
    shutdownTimeoutMillis: 3000 # optional; defaults to 3000
    exporter:                # explicit SDK transport settings
      url: https://collector.example.com/v1/logs
      headers:
        authorization: !!js `Bearer ${process.env.OTLP_TOKEN}`
    processor: {}            # optional; byte/count batching and per-request watchdog
```

| Field | Default | Meaning |
|---|---|---|
| `mode` | `FEEDBACK_ONLY` | Sharing policy: `FEEDBACK_ONLY` or `DISABLED` |
| `exporter.url` | required in uploading modes | Full OTLP logs endpoint; must parse as `http(s)` |
| `exporter`, `processor` | — | SDK transport plus byte/count batching; headers/TLS identity are not inherited from the environment. Agent factories own their returned agent settings, including keepAlive |
| `shutdownTimeoutMillis` | `3,000` | Outer deadline for all queued HTTP requests; remaining queued sends stop at expiry |
| `maxRequestBytes` | `4,000,000` | Maximum complete OTLP JSON request bytes before gzip; may only be lowered |

Direct `ctx.sessionTelemetry.emit()` calls are no-ops in every mode and cannot bypass feedback authorization. Inherited parent feedback does not authorize a child export: the child needs new feedback of its own. Its authorized prefix then includes inherited context.

Model requests, request headers, Session creation or adoption, restoration, and plugin mount or HMR do not authorize capture. Stored feedback alone triggers nothing. Scheduled flush and shutdown may finish batches authorized earlier, but never capture new records.

### What leaves the machine

Each Session event becomes one `eventName: "session-log"` record. `attributes.sessionId` is the collector Session identity; `attributes.content` encodes the complete event envelope with redacted `event.data`. JSON values are preserved, not the original JSONL bytes or key ordering. Legacy `session.id`, `event.seq`, and `event.type` metadata remain for existing consumers. Resources carry application and anonymous-user identity; scope carries the backend package name and version. The base profile uses `https://dsh-otel-collector.deepseeksvc.com/v1/logs`; `DSH_TELEMETRY_OTLP_URL` overrides it. No channel header is added implicitly.

The shared OTel channel measures each record once with the SDK OTLP JSON serializer, including its resource/scope envelope, then greedily packs requests using those conservative sizes. A single oversized event produces one rejection diagnostic without truncation. Session logs never mix with product analytics in a request. Capture handoff and shutdown are not collector acknowledgements.

### Failures and shutdown

Invalid byte limits, non-positive queue/timer values, `maxExportBatchSize > maxQueueSize`, invalid endpoints, and invalid shutdown deadlines fail at load. Processor defaults are 2,048 queued records, 512 records per request, a 1,000 ms scheduling delay, and a 30,000 ms request watchdog. Byte limits may split a count batch into multiple serial HTTP requests. Each request waits for SDK export-queue cleanup after its callback before the next starts. `exportTimeoutMillis` warns per request but never frees an unsettled transport slot; the SDK transport owns network timeout/retry. Shutdown drains these requests until `shutdownTimeoutMillis`; expiry discards the remaining queue and prevents further sends, while an active request may still settle. Large prefixes can therefore remain partially unsent at CLI exit.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the backend's composition; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The backend owns feedback authorization, identity, and shutdown. The shared OTel service owns channel creation, byte/count scheduling, record construction, JSON transport, compression, and retries. Resource identity carries `service.name`/`service.version` from `APP_IDENTITY` and anonymous `user.id`; the scope retains this package’s name and version.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: mode resolution, fail-closed validation, SDK pipeline wiring, coordinator composition, shutdown deadline |

### Capture wiring

The backend captures history on demand through new own feedback events or committed cold snapshots. Its private reporter serializes queued HTTP requests even after a watchdog fires; an outer shutdown deadline stops the remaining queue. It exposes no extra flush entry point.

### Field mapping

Each capture record supplies a separately copied event envelope and redacted payload to `SessionLogReporter`; serialization retains optional surface metadata and the event sequence/time. Feedback authorizes the complete unhanded prefix, not only the feedback payload.

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

- **Upstream experimental tree** — `@opentelemetry/sdk-logs` is published from the upstream experimental tree; SDK API churn lands in the [shared OTel plugin](../../telemetry/otel/README.md), while the seam contract does not move.
- **Live-collector behavior belongs to the SDK exporter** — authentication, TLS, throttling, and other real OTLP deployment behavior follow the upstream SDK rather than a package-owned compatibility layer.
- **Best-effort handoff** — new cold snapshots and a new feedback submission after restart can repeat prefixes; receivers deduplicate by Session id, format version, and event seq. There is no durable outbox, delivery watermark, automatic retry promise, or collector-acceptance guarantee. OTel and the opt-in DeepSeek API path can overlap. Withdrawal exports a deletion event, not remote erasure.

- **Backend availability** — feedback submitted while this plugin is disabled or unloaded is recorded locally but not automatically replayed when it returns. Capture requires the subscriber to remain mounted until it observes the submission; unloading during a pending cold write can miss its post-flush notification.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
