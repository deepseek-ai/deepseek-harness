/**
 * Single replay-aware token-meter service for request and surface pressure.
 *
 * @module @deepseek-ai/dsh-token-meter
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-compaction-image-offload/projection'
import z from '@deepseek-ai/schemastery'
import type { LlmImageRequestPricing, LlmRuntime, Message, TokenUsage } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type {
  EpochHeader,
  Session,
  SessionEvent,
  SessionSeq as SessionSeqType,
  SessionLogOffset as SessionLogOffsetType,
} from '@deepseek-ai/dsh-session'
import {
  canonicalHeader,
  headerEquals,
  isSurfaceEvent,
  SessionLogOffset,
  SessionSeq,
} from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {
  ContextPressureProjection,
  TokenMeasurement,
  TokenMeasurementBaseline,
  TokenMeterConfig,
} from './types.ts'
import { contextBreakdownProjectionDefinition } from './breakdown-projection.ts'
import { contextPressureProjectionDefinition, tokenUsageProjectionDefinition } from './usage-projection.ts'
import type { ContextPressureState } from './usage-projection.ts'
import { estimateMessage, estimateToolsTokens } from './estimate.ts'
import { advanceMeasurement, measurementProjectionDefinition } from './measurement-projection.ts'
import type { MeasurementState } from './measurement-projection.ts'
import { commitSurfaceTokens, planSurfaceTokens } from './surface-fold.ts'
import type { MeterSurfaceNode } from './surface-fold.ts'
import { priceSurface } from './route-pricing.ts'

export type * from './types.ts'

/** Rebuildable positional prices, excluded from projection checkpoints. */
interface ReplayState {
  consumedEvents: SessionLogOffsetType
  surface: MeterSurfaceNode[]
  header: { seq: SessionSeqType | null; value: EpochHeader } | undefined
  anchorHeader: { seq: SessionSeqType | null; value: EpochHeader } | undefined
  anchorNodes: readonly MeterSurfaceNode[]
  /** Preserve synchronous construction-time reads before registration completes. */
  pendingMeasurement: MeasurementState
}

/** Sum disjoint provider usage buckets without double-counting reasoning output. */
function usageTokens(usage: TokenUsage): number {
  return usage.inputTokens
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
    + usage.outputTokens
}

/** Compare optional envelopes so a headerless estimate can track later surface deltas. */
function optionalHeaderEquals(
  left: EpochHeader | undefined,
  right: EpochHeader | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return headerEquals(left, right)
}

/** Reject stale or misspelled keys before defaults can hide them. */
function validateConfigKeys(config: TokenMeterConfig): void {
  for (const key of Object.keys(config)) {
    throw new Error(`TokenMeterConfig: unknown key "${key}" (no settings are supported)`)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tokenMeter: TokenMeter
  }
}

/** Replay owner for one service-wide estimator and isolated per-session folds. */
export class TokenMeter extends Service {
  // Schemastery preserves untrusted loader keys on an empty object schema;
  // the public type excludes settings while validateConfigKeys rejects them.
  static Config: z<TokenMeterConfig> = z.object({}) as unknown as z<TokenMeterConfig>

  static inject = ['sessionProjections']

  private readonly states = new WeakMap<Session, ReplayState>()
  private measurementProjectionHandle: ProjectionHandle<MeasurementState> | undefined
  private contextPressureProjectionHandle!: ProjectionHandle<ContextPressureState>

  constructor(ctx: Context, config: TokenMeterConfig = {}) {
    super(ctx, 'tokenMeter')
    validateConfigKeys(config)
  }

  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    this.measurementProjectionHandle = await ctx.sessionProjections.register(measurementProjectionDefinition)
    await ctx.sessionProjections.register(tokenUsageProjectionDefinition)
    this.contextPressureProjectionHandle = await ctx.sessionProjections.register(contextPressureProjectionDefinition)
    await ctx.sessionProjections.register(contextBreakdownProjectionDefinition)

    // Readers catch up independently, while eager observation bounds ordinary
    // read latency without creating state for sessions no consumer has read.
    ctx.on('session/event', (session) => {
      if (this.states.has(session)) this._sync(session)
    })
  }

  /**
   * Read the latest logged provider prompt size and route capacity.
   * @param session - Session whose committed usage and request capacity are read.
   * @returns context pressure; fields remain absent until their source events are recorded.
   */
  contextPressure(session: Session): Pick<ContextPressureProjection, 'pressureTokens' | 'contextWindow'> {
    const { pressureTokens, contextWindow } = this.contextPressureProjectionHandle.stateOf(session)
    return {
      ...pressureTokens === undefined ? {} : { pressureTokens },
      ...contextWindow === undefined ? {} : { contextWindow },
    }
  }

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
   * surface are repriced. The anchor includes all surface nodes immediately
   * before the assistant message, including inputs admitted after step/start.
   *
   * `requestHeader` replaces the latest logged envelope for pressure and node
   * pricing; the node set always describes the current session surface. Every
   * call clones those positional nodes, so measurement is O(surface).
   *
   * @param session - session to replay through its current durable tail.
   * @param requestHeader - optional effective request envelope replacing the latest logged header.
   * @returns a detached deeply immutable pressure and surface measurement.
   */
  measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement {
    const { prices: state, measurement } = this._sync(session)
    const header = requestHeader === undefined
      ? this._cachedHeader(state, measurement.headerSeq)
      : canonicalHeader(requestHeader)
    const pricing = this._routeImagePricing(header)
    const fileText = this._fileRequestText()
    const surface = priceSurface(state.surface, pricing, fileText)
    const anchor = measurement.anchor

    let baseline: TokenMeasurementBaseline
    let surfaceDeltaTokens: number
    if (anchor !== null && optionalHeaderEquals(this._cachedHeader(state, anchor.headerSeq), header)) {
      // Matching headers share one route, so the anchored snapshot reprices
      // under the same pricing as the current surface and the signed delta
      // compares like with like.
      const anchorSurfaceTokens = priceSurface(state.anchorNodes, pricing, fileText).surfaceTokens
        + anchor.assistantTokens
      const estimatedAnchorTokens = estimateToolsTokens(header) + anchorSurfaceTokens
      const usage = anchor.usage
      // Signed heuristic deltas remain conservative only from an anchor
      // that is at least as large as the matching full heuristic price.
      baseline = usage !== null && usageTokens(usage) >= estimatedAnchorTokens
        ? { kind: 'usage', tokens: usageTokens(usage), usage }
        : { kind: 'estimated', tokens: estimatedAnchorTokens }
      surfaceDeltaTokens = surface.surfaceTokens - anchorSurfaceTokens
    } else if (header === undefined && surface.surfaceTokens === 0) {
      baseline = { kind: 'none', tokens: 0 }
      surfaceDeltaTokens = 0
    } else {
      baseline = {
        kind: 'estimated',
        tokens: estimateToolsTokens(header) + surface.surfaceTokens,
      }
      surfaceDeltaTokens = 0
    }

    return deepFreeze(structuredClone({
      logRevision: state.consumedEvents,
      baseline,
      surfaceDeltaTokens,
      totalTokens: Math.max(0, baseline.tokens + surfaceDeltaTokens),
      surfaceTokens: surface.surfaceTokens,
      nodes: surface.nodes,
    }))
  }

  /** Resolve the routed model's image pricing, when the llm service and route declare one. */
  private _routeImagePricing(header: EpochHeader | undefined): LlmImageRequestPricing | undefined {
    const config = header?.config
    if (config === undefined) return undefined
    return this.ctx.get('llm')?.imageRequestPricing(config.provider, config.model)
  }

  /** Resolve request-time file projection when an LLM service is mounted. */
  private _fileRequestText(): (
    (ref: Parameters<LlmRuntime['fileRequestText']>[0]) => string
  ) | undefined {
    const llm = this.ctx.get('llm')
    return llm === undefined ? undefined : ref => llm.fileRequestText(ref)
  }

  /**
   * Heuristically price one model-visible message (instance face of the pure
   * `estimateMessage` export from `estimate.ts`).
   * @param message - message to price without mutation.
   * @returns content and role-framing tokens under the fixed service heuristic.
   */
  estimateMessage(message: Message): number {
    return estimateMessage(message)
  }

  /** Resolve one of the two header payloads retained by the rebuildable price cache. */
  private _cachedHeader(state: ReplayState, seq: SessionSeqType | null): EpochHeader | undefined {
    if (seq === null) return undefined
    if (state.header?.seq === seq) return state.header.value
    return state.anchorHeader?.value
  }

  /** Catch rebuildable prices up to the current durable tail. */
  private _sync(session: Session, useProjection = true): { prices: ReplayState; measurement: MeasurementState } {
    let state = this.states.get(session)
    if (state === undefined) {
      state = {
        consumedEvents: SessionLogOffset(0),
        surface: [],
        header: undefined,
        anchorHeader: undefined,
        anchorNodes: [],
        pendingMeasurement: measurementProjectionDefinition.init(),
      }
      this.states.set(session, state)
    }
    const projected = useProjection ? this.measurementProjectionHandle?.stateOf(session) : undefined
    while (state.consumedEvents < session.seq) {
      // Cold price caches may replay resident history.
      // oxlint-disable-next-line typescript/no-non-null-assertion, typescript/no-deprecated
      const event = session.eventAt(SessionSeq(state.consumedEvents))!
      const next = projected !== undefined
        ? undefined
        : measurementProjectionDefinition.apply(state.pendingMeasurement, event)
      const measurement = next ?? projected
      if (measurement?.invalidSeq === event.seq) {
        // Match the original assistant validation order before committing any prices.
        if (event.type === 'assistant/message') planSurfaceTokens(state.surface, event)
        advanceMeasurement(measurement, event)
      }
      this._foldEvent(state, event)
      if (next !== undefined) state.pendingMeasurement = next
      state.consumedEvents = SessionLogOffset(state.consumedEvents + 1)
    }
    if (projected !== undefined && (projected.headerSeq !== (state.header?.seq ?? null)
      || (projected.anchor !== null && projected.anchor.headerSeq !== (state.anchorHeader?.seq ?? null)))) {
      // A checkpoint reference must match the original journal. Discard the
      // rebuildable cache and use the same calculation from the beginning.
      this.states.delete(session)
      return this._sync(session, false)
    }
    // An initialized registration supplies `projected`; earlier reads keep the same pure fold locally.
    return { prices: state, measurement: projected ?? state.pendingMeasurement }
  }

  /** Update only discardable positional prices and the pre-assistant view. */
  private _foldEvent(state: ReplayState, event: SessionEvent): void {
    if (event.type === 'request/header') state.header = { seq: event.seq, value: canonicalHeader(event.data.header) }
    if (event.type === 'image/offload') {
      const offloaded = new Map(event.data.targets.map(target => [target.seq, new Set(target.imageIndexes)]))
      state.surface = state.surface.map((node) => {
        const indexes = offloaded.get(node.seq)
        if (indexes === undefined) return node
        return {
          ...node,
          images: node.images.map((image, index) => (indexes.has(index) ? { ...image, offloaded: true as const } : image)),
        }
      })
    }
    const plan = isSurfaceEvent(event) ? planSurfaceTokens(state.surface, event) : undefined
    if (event.type === 'assistant/message') {
      state.anchorNodes = [...state.surface]
      state.anchorHeader = state.header
    }
    if (plan !== undefined) commitSurfaceTokens(state.surface, plan)
  }
}

export default TokenMeter
