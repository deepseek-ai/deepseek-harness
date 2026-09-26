# 产品埋点

[English](product-telemetry.md) | 中文

[产品埋点插件](../../packages/host/product-telemetry-otel/README.zh.md) 通过 OTLP/HTTP 发送明确选定的分析事件。`productTelemetry` 服务仅负责提交；产品消费方决定事件发生时机与获准采集的字段。不自动采集 Session 数据或标识。

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
