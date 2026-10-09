---
description: "Create independent OTLP reporting channels through the shared Cordis OTel service."
kind: "package-reference"
---

# @deepseek-ai/dsh-otel

English | [中文](README.zh.md)

## Summary

Mount one `otel` service to create ordinary-event and Session-log reporting channels. Each channel has its own exporter, resource, instrumentation scope, and queue. Mounting alone creates no transport or identity and sends nothing. Business consumers own authorization, redaction, field selection, and their channel's disposal.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The base bundle mounts `@deepseek-ai/dsh-otel`. Independent compositions must mount it before consumers that inject `otel`. Call `ctx.otel.createEventReporter(options)` for ordinary analytics or `ctx.otel.createSessionLogReporter(options)` for complete Session events. Options explicitly supply endpoint, scope, resource attributes, queue settings, and a diagnostic callback; the service has no deployment defaults or automatic collection policy of its own.

The returned channel belongs to the consumer. Ordinary-event `shutdown(signal)` cancels requests and retry waits when the supplied signal aborts, and resolves after transport cleanup. Register shutdown with the consumer's Cordis fiber and bound the complete drain with its configured deadline. Injection makes service replacement unload dependent consumers. Do not retain a channel after its consumer unloads. The product and Session adapters implement this ownership for UI and feedback callers.

Ordinary channels use SDK count-based batching. Session channels preserve one complete event per record with `eventName: "session-log"`, `sessionId`, and a JSON string `content`, and enforce at most 4,000,000 uncompressed request bytes. Their byte limits, single-record rejection, serial transport settlement, and shutdown behavior are specified by the [Session adapter](../../session/session-telemetry-otel/README.md). A Session channel never shares a request or queue with ordinary events.

Headers are explicit. The service does not add a channel header or inherit ambient authorization headers or TLS identity. Agent factories configure their returned agents, including keepAlive. Ordinary-event channels destroy their agent on shutdown; factories must provide a dedicated agent for each channel. Scope names and versions are supplied by each consumer, so transport sharing does not change event attribution.

<a id="understand-the-implementation"></a>
## Understand the implementation

`src/index.ts` registers the service; `event-log.ts` owns ordinary SDK batching; `session-log.ts` owns byte/count scheduling; `transport.ts` supplies the Session SDK JSON HTTP delegate and owns the shared exporter metrics recorder, which receives no meter provider and records nothing; `event-transport.ts` uses Got for cancellable ordinary-event HTTP requests and retry waits with SDK serialization and export accounting. No global OTel provider is installed; the accepted exporter options exclude the upstream `selfObsMeterProvider`, and the Session processor accepts only the batching fields it implements, so exporter and Session-processor self-observability metrics stay unrecorded. The Session processor measures each record once, groups conservative sizes, and waits for the SDK concurrency queue to clear after every callback before sending another request.

Composition tests exercise independent channels and service removal; adapter tests cover dependent-fiber cleanup and feedback authorization.

<a id="further-exploration"></a>
## Further Exploration

- [OTel subsystem](../../../docs/subsystems/otel.md) — service ownership and API.
- [Product adapter](../../host/product-telemetry-otel/README.md) — explicit analytics policy and configuration.
- [Session adapter](../../session/session-telemetry-otel/README.md) — feedback authorization and configured upload limits.

<a id="model-experience"></a>
## Model Experience

None, as the service delivers caller-selected records without changing model context.

#### KV Cache effect

None; reporting does not change model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Channels provide best-effort, memory-only delivery with the following limits.

- The caller owns consent, redaction, resource identity, renderer-to-host RPC, and the outer shutdown deadline.
- Queue overflow, oversized Session events, transport failure, and process exit can lose records. There is no durable outbox or warehouse acknowledgement.
- Ordinary-event channels batch by count; their consumers must select event and batch sizes suitable for the collector.

<a id="dev-note"></a>
### Dev Note

None.
