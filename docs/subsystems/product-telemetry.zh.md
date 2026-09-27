# 产品埋点

[English](product-telemetry.md) | 中文

[产品埋点插件](../../packages/host/product-telemetry-otel/README.zh.md) 通过 OTLP/HTTP 发送明确选定的分析事件。`productTelemetry` 服务仅负责提交；产品消费方决定事件发生时机与获准采集的字段。导出器不自动采集 Session 数据或标识。[桌面埋点消费方](../../packages/client/product-analytics/README.zh.md)选择交互与实时压缩事件，补充可用的登录身份，并遵守桌面启动时的采集开关。普通 Web 客户端不采集产品事件。

`ProductTelemetryRecord` 要求事件名称、字符串 body 和 Unix 毫秒时间戳。属性接受字符串、数字、布尔标量，以及这些值组成的单层对象（`ProductTelemetryScalar`）。可选的严重程度使用 OTel 严重程度数字，默认为 INFO。记录入队时填写观测时间。

入队同步完成，不代表送达确认。SDK 负责批量发送与重试；发送失败会产生本地诊断。配置、退出和丢失限制见包 README。

## 记录类型

```ts type-equiv
/** Scalar values accepted in product attributes. */
type ProductTelemetryScalar = OTelEventScalar
```

```ts type-equiv
/** Caller-selected ordinary analytics record. */
type ProductTelemetryRecord = OTelEventRecord
```

Source: [`packages/host/product-telemetry-otel/src/index.ts`](../../packages/host/product-telemetry-otel/src/index.ts)

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxproductanalytics--productanalytics"></a>

### `ctx.productAnalytics` — `ProductAnalytics`

Authenticated event intake; disabled instances do not inspect identity or accept new events.

```ts cordis-catalog
/**
 * Read the collection policy.
 * @returns whether this Host currently accepts Desktop analytics.
 */
@Remote enabled(): boolean

/**
 * Stream the effective policy initially and after live configuration edits.
 * @param signal - subscriber lifetime.
 * @returns current policy values until cancellation or service disposal.
 */
@Remote({ mode: 'stream' }) async *watchPolicy(signal: AbortSignal): AsyncIterable<boolean>

/**
 * Submit selected Desktop fields; missing identity is omitted and never generated.
 * @param event - typed product event without message contents or credentials.
 * @returns after local submission; no delivery or warehouse acknowledgement.
 */
@Remote async report(event: ProductEvent): Promise<void>
```

Source: [`packages/client/product-analytics/src/index.ts`](../../packages/client/product-analytics/src/index.ts)

<a id="ctxproducttelemetry--producttelemetry"></a>

### `ctx.productTelemetry` — `ProductTelemetry`

Host analytics sender. Mounting alone sends nothing; the owning fiber drains it on unload.

```ts cordis-catalog
/**
 * Enqueue one selected product event without waiting for network delivery.
 * Queue admission and shutdown completion are not collector or warehouse acknowledgements.
 * @param record - caller-owned event containing only approved analytics fields.
 */
emit(record: ProductTelemetryRecord): void
```

Source: [`packages/host/product-telemetry-otel/src/index.ts`](../../packages/host/product-telemetry-otel/src/index.ts)
<!-- END GENERATED cordis-surface -->
