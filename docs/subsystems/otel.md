# OTel reporting

English | [中文](otel.zh.md)

The [OTel plugin](../../packages/telemetry/otel/README.md) registers `ctx.otel`, a shared factory for independent ordinary-event and Session-log channels. It owns SDK transport and batching implementations. Business consumers inject the service, supply explicit transport/resource/scope options, and own each returned channel's shutdown.

UI feedback reaches the Session feedback services through their existing Remote APIs. Feedback recording authorizes the Session adapter's canonical-prefix capture and redaction before it reports through an OTel channel. Ordinary product consumers submit selected fields through the product adapter. The shared service has no automatic identity or capture policy, and channels never share queues or requests.

The [product adapter](../../packages/host/product-telemetry-otel/README.md) and [Session adapter](../../packages/session/session-telemetry-otel/README.md) retain their deployment configuration and disposal deadlines. Consumers must not reuse a channel after shutdown. Mounting only the OTel service allocates no provider or transport.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxotel--otel"></a>

### `ctx.otel` — `OTel`

Shared transport provider. Mounting creates no queue, identity, or network connection.

```ts cordis-catalog
/**
 * Create an independent ordinary-event channel with count-based batching.
 * The injected consumer must drain it during its fiber disposal.
 * @param options - transport, scope, resource, queue, and diagnostic settings selected by the consumer.
 * @returns the caller-owned channel; no state is shared with other channels.
 */
createEventReporter(options: EventLogOptions): EventLogReporter

/**
 * Create an independent byte-bounded Session-log channel.
 * Authorization and redaction precede reporting; the consumer owns shutdown and its outer deadline.
 * @param options - transport, scope, resource, queue, and diagnostic settings selected by the consumer.
 * @returns the caller-owned channel, preserving complete accepted events within the request byte ceiling.
 */
createSessionLogReporter(options: SessionLogOptions): SessionLogReporter
```

Source: [`packages/telemetry/otel/src/index.ts`](../../packages/telemetry/otel/src/index.ts)
<!-- END GENERATED cordis-surface -->
