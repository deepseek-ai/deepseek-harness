# Token 计量

[English](token-meter.md) | 中文

`@deepseek-ai/dsh-token-meter` 公开一个独立的回放快照，用于表示请求压力与按位置计算的表层定价。`logRevision` 表示生成该计量中每个字段时所消费的持久事件数量。

来源：[`packages/llm/token-meter/src/types.ts`](../../packages/llm/token-meter/src/types.ts)

## `TokenMeasurement`

```ts type-equiv
/** Detached immutable request-pressure and surface snapshot at one consumed log revision. */
interface TokenMeasurement {
  /** Number of durable events consumed; equal to the next unread event seq. */
  readonly logRevision: SessionLogOffset
  /** Provider or heuristic anchor used for this measurement. */
  readonly baseline: TokenMeasurementBaseline
  /** Signed repricing of current surface content relative to the baseline anchor. */
  readonly surfaceDeltaTokens: number
  /** Non-negative current request-and-response pressure. */
  readonly totalTokens: number
  /** Total route-priced request tokens across the current surface; equals the sum of the node prices. */
  readonly surfaceTokens: number
  /** Current surface nodes in positional head-to-tail order. */
  readonly nodes: readonly TokenSurfaceNode[]
}
```

每次计量都会通过 `ctx.llm` 把生效信封的路由 provider/model 解析为该路由声明的请求图片定价，因此图片出现处按请求实际发送的视觉 token 加模型可见文本计价；未声明定价的路由与组合保持固定启发式规则。`baseline.kind === 'usage'` 表示最近一次成功的提供方调用具有相同的规范请求 envelope，且该调用的总量不低于其完整路由定价锚点。`estimated` 表示不存在可复用的保守 usage 锚点，因此服务自行对完整信封和表层定价。后续成功请求会替换早先的锚点；有符号的 `surfaceDeltaTokens` 会保留相对于匹配锚点的增长与缩减，且两侧按同一路由重新定价。`totalTokens` 仍表示请求与响应压力，`surfaceTokens` 则是表层的路由定价总量，等于所有节点价格之和。

## `TokenSurfaceNode`

```ts type-equiv
/** One token-priced node in the current ordered session surface. */
interface TokenSurfaceNode {
  /** Durable sequence number of the surface event. */
  readonly seq: SessionSeq
  /**
   * Request-pressure tokens for the exact message projected by this node under
   * the measured route: image occurrences carry the route's declared visual
   * price when the routed adapter declares one, and the fixed heuristic
   * otherwise. Trigger, retention, and range selection all read this price.
   */
  readonly tokens: number
  /**
   * Fixed-heuristic tokens for the same message, independent of any route.
   * The shadow-price protocol prices replacements with this value so the O(1)
   * projection fold stays in agreement with its own appends.
   */
  readonly heuristicTokens: number
}
```

表层顺序具有权威性；替换节点的持久 seq 可能高于位置排在其后的节点。该快照不可变，不会随底层回放折叠推进而增长。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtokenmeter--tokenmeter"></a>

### `ctx.tokenMeter` — `TokenMeter`

Replay owner for one service-wide estimator and isolated per-session folds.

```ts cordis-catalog
/**
 * Measure current request pressure and surface through the durable tail.
 *
 * The effective envelope's routed provider/model selects the request-image
 * pricing every node is priced under: a route whose adapter declares image
 * pricing charges each retained image its visual tokens plus its
 * model-visible text, while other routes keep the fixed heuristic. Provider
 * usage is reused only when the latest successful call's canonical request
 * envelope matches `requestHeader` and its total is no lower than that
 * call's full route-priced anchor; otherwise the complete envelope and
 * surface are repriced.
 *
 * `requestHeader` replaces the latest logged envelope for pressure and node
 * pricing; the node set always describes the current session surface. Every
 * call clones those positional nodes, so measurement is O(surface).
 *
 * @param session - session to replay through its current durable tail.
 * @param requestHeader - optional effective request envelope replacing the latest logged header.
 * @returns a detached deeply immutable pressure and surface measurement.
 */
measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement

/**
 * Heuristically price one model-visible message (instance face of the pure
 * `estimateMessage` export from `estimate.ts`).
 * @param message - message to price without mutation.
 * @returns content and role-framing tokens under the fixed service heuristic.
 */
estimateMessage(message: Message): number
```

Types: [EpochHeader](session.zh.md) · [Message](llm-streaming.zh.md) · [Session](session.zh.md)

Source: [`packages/llm/token-meter/src/index.ts`](../../packages/llm/token-meter/src/index.ts)
<!-- END GENERATED cordis-surface -->
