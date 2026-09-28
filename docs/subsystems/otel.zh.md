# OTel 上报

[English](otel.md) | 中文

[OTel 插件](../../packages/telemetry/otel/README.zh.md) 注册 `ctx.otel`，作为独立普通事件通道和 Session 日志通道的共享工厂。它持有传输与 SDK 聚合实现。业务调用方注入服务，显式提供传输、resource 和 scope 选项，并负责返回通道的关闭。

UI 反馈通过现有 Remote API 到达 Session 反馈服务。记录反馈后，Session 适配器才获得规范日志前缀的捕获授权，完成脱敏后通过 OTel 通道上报。普通产品调用方通过产品适配器提交选定字段。共享服务没有自动身份或捕获策略，通道之间不共享队列或请求。

[产品适配器](../../packages/host/product-telemetry-otel/README.zh.md) 和 [Session 适配器](../../packages/session/session-telemetry-otel/README.zh.md) 保留各自部署配置及销毁期限。通道关闭后调用方不得复用。只挂载 OTel 服务不会分配 provider 或 transport。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
