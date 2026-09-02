# Token Meter

English | [中文](token-meter.zh.md)

`@deepseek-ai/dsh-token-meter` exposes one detached replay snapshot for request pressure and positional surface pricing. `logRevision` is the number of durable events consumed for every field in the measurement.

Source: [`packages/llm/token-meter/src/types.ts`](../../packages/llm/token-meter/src/types.ts)

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

Every measurement resolves the effective envelope's routed provider/model to that route's declared request-image pricing through `ctx.llm`, so image occurrences are priced as the visual tokens plus model-visible text the request actually sends; routes and compositions without declared pricing keep the fixed heuristic. `baseline.kind === 'usage'` means the latest successful provider call has the same canonical request envelope and its total is no lower than that call's full route-priced anchor. `estimated` means no reusable conservative usage anchor exists, so the service priced the complete envelope and surface itself. A later successful request replaces the earlier anchor; signed `surfaceDeltaTokens` preserves growth and shrinkage relative to a matching anchor, repricing both sides under the same route. `totalTokens` remains request-and-response pressure, while `surfaceTokens` is the surface-only route-priced total and equals the sum of the node prices.

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

Surface order is authoritative; replacement nodes can have higher durable seqs than later positional nodes. The snapshot is immutable and does not grow when the underlying replay fold advances.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [EpochHeader](session.md) · [Message](llm-streaming.md) · [Session](session.md)

Source: [`packages/llm/token-meter/src/index.ts`](../../packages/llm/token-meter/src/index.ts)
<!-- END GENERATED cordis-surface -->
