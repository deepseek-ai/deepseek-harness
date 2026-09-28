---
description: "Configure explicit product usage events, OTLP/HTTP routing, batching, and shutdown limits."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-product-telemetry-otel

English | [中文](README.zh.md)

## Summary

Send selected product usage events to an OTLP/HTTP collector. Events carry a name, string summary, occurrence time, and scalar or one-level object attributes. Mounting the plugin collects nothing automatically; applications explicitly submit each event. Delivery is best effort and does not confirm warehouse ingestion.

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

Mount the plugin in a Cordis composition with the application identity; override the collector endpoint when needed. The Desktop composition mounts it when [product analytics](../../client/product-analytics/README.md) is enabled; ordinary Web does not. The standalone example below reads `DSH_APP_VERSION`; Desktop supplies `DSH_CLIENT_VERSION` through its native launcher. Both must name the running release; the schema rejects an absent version.

```yaml
- name: '@deepseek-ai/dsh-otel'
- name: '@deepseek-ai/dsh-host-product-telemetry-otel'
  config:
    endpoint: https://dsh-otel-collector.deepseeksvc.com/v1/logs
    serviceName: deepseek-harness
    serviceVersion: !!js process.env.DSH_APP_VERSION
    compression: gzip
    scheduledDelayMillis: 30000
```

| Field | Default | Meaning |
|---|---|---|
| `endpoint` | `https://dsh-otel-collector.deepseeksvc.com/v1/logs` | Full HTTP(S) logs URL |
| `serviceName`, `serviceVersion` | required | Application identity on the OTel resource |
| `channel` | `dsh_otel_report` | Collector `x-channel` header |
| `compression` | SDK environment | `gzip` or `none`; omission honors OTel compression environment variables |
| `maxExportBatchSize`, `maxQueueSize` | `512`, `2048` | Record-count limits; batch size cannot exceed queue size |
| `scheduledDelayMillis` | `30000` | Partial-batch export interval |
| `timeoutMillis` | `15000` | Exporter HTTP and retry deadline |
| `exportTimeoutMillis` | `20000` | Processor batch export deadline |
| `shutdownTimeoutMillis` | `21000` | Drain deadline; expiry cancels pending exports and reports possible loss |

The default endpoint routes explicitly submitted events to the production product collector. Test and custom deployments must override it. Only `x-channel` and SDK protocol headers reach the collector; ambient OTel headers and client certificates are not inherited.

The 30-second interval batches product events; the exporter has a 15-second retry window inside the processor’s 20-second batch deadline. The 21-second drain deadline covers SDK `forceFlush()` work that the processor deadline does not cover. Expiry cancels active HTTP requests and retry waits, then awaits transport cleanup before disposal completes. An unreachable collector can delay disposal for the full 21 seconds. A full 2,048-record queue requires four 512-record batches and may not drain before that deadline. Interactive compositions needing a shorter exit should override these budgets; neither configuration guarantees delivery.

Consumers inject `productTelemetry` and call `emit()` with explicitly selected analytics fields. Event names and field semantics belong to their product and analytics owners. The plugin reads no Session, account, credential, or device identifier. Callers must exclude prompts, responses, file contents, credentials, and other unapproved values.

The collector expects a string body and attributes containing strings, numbers, booleans, or objects of those scalars. Callers supply occurrence time in milliseconds; the plugin assigns observation time and defaults severity to INFO. Invalid transport configuration fails at activation. Export failures produce local warnings without making event submission wait for the network.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The adapter injects `otel` and creates an independent ordinary-event channel through `ctx.otel.createEventReporter()`. The [shared OTel plugin](../../telemetry/otel/README.md) owns transport and SDK batching; this adapter owns analytics configuration and its shutdown cancellation deadline. No global OTel provider is installed.

[`src/index.ts`](src/index.ts) owns configuration and submission. No runtime invariant companion is published: delivery has no independent local acknowledgement to compare with the SDK's queue.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Product telemetry](../../../docs/subsystems/product-telemetry.md) — consumer types and service reference.
- [Session telemetry](../../session/session-telemetry-otel/README.md) — separate feedback-authorized Session reporting.
- [Testing policy](../../../docs/testing.md) — Loader composition and network fixtures.

-----

<a id="model-experience"></a>
## Model Experience

None, as the plugin exports explicit analytics records without contributing model context.

#### KV Cache effect

None; event submission does not change model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Delivery and collection remain limited to the following capabilities.

- Callers own event selection, renderer-to-host transport, and any permitted identity attributes.
- The queue is memory-only; overflow, network failure, and process exit can lose events. There is no durable outbox or warehouse acknowledgement.
- The SDK batches by record count, not encoded bytes. Callers must keep records within the collector's 4 MB limit and choose batch sizes appropriate to the receiver.
- Caller-selected strings are not redacted automatically. This package does not decide product disclosure or consent policy.

<a id="dev-note"></a>
### Dev Note

None.
