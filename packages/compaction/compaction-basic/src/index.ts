/**
 * Basic replay-aware compaction backend.
 *
 * @module @deepseek-ai/dsh-compaction-basic
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CompactionEngine, ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
// Type-only: makes the optional sibling service available to `ctx.get()`.
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import {
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
  TargetPressureConfigError,
} from './config.ts'
import {
  assertNoActiveCompaction,
  compactSurfaceRegion,
  selectCompactableRange,
} from './region.ts'
import { summarizeWithLlm } from './summarizer.ts'
import type { SummarizationInput, SummaryResult } from './summarizer.ts'
import type {
  BasicCompactionConfig,
  ModelCompactPolicyConfig,
  ResolvedConfig,
} from './types.ts'

export type {
  BasicCompactionConfig,
  CompactionPolicyConfig,
  ModelCompactPolicyConfig,
  ResolvedCompactSpec,
  ResolvedConfig,
  ResolvedRetention,
  ResolvedTargetPolicy,
} from './types.ts'

/** The region transaction's view of this service's dynamically dispatched summarizer. */
type RegionSummarize = (input: SummarizationInput, agent: Agent, signal?: AbortSignal) => Promise<SummaryResult>

/** Resolve the exact provider/model durably routed for the latest request. */
function routedTarget(
  session: Session,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) {
    return undefined
  }
  return { provider: config.provider, model: config.model }
}

/** Resolve the conversation target used to select an optional policy override. */
function conversationTarget(
  agent: Agent,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const routed = routedTarget(agent.session)
  if (routed !== undefined) return routed
  if (agent.options.provider === undefined || agent.options.provider.length === 0
    || agent.options.model === undefined || agent.options.model.length === 0) return undefined
  return { provider: agent.options.provider, model: agent.options.model }
}

const thresholdRatioSchema = z.number()
const retainRatioSchema = z.number()
const retainTokensSchema = z.number().step(1).min(0)
const summarizationProviderSchema = z.string()
const summarizationModelSchema = z.string()
const maxTokensSchema = z.number().step(1).min(1)
const compactionRetriesSchema = z.number().step(1).min(0)
const maxOverflowRetriesSchema = z.number().step(1).min(0)

const modelPolicy: z<ModelCompactPolicyConfig> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  thresholdRatio: thresholdRatioSchema,
  retainRatio: retainRatioSchema,
  retainTokens: retainTokensSchema,
  summarizationProvider: summarizationProviderSchema,
  summarizationModel: summarizationModelSchema,
  maxTokens: maxTokensSchema,
  compactionRetries: compactionRetriesSchema,
  maxOverflowRetries: maxOverflowRetriesSchema,
})

/**
 * Dependency-light compaction backend using `ctx.tokenMeter` for pressure,
 * retention, cited source events, and summary-convergence pricing.
 *
 * `summarize()` is the sole subclass customization hook; the replay and durable
 * mutation strategy stays fixed so every pricing decision uses the singleton
 * token meter.
 */
export class BasicCompactionEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']

  static Config: z<BasicCompactionConfig> = z.object({
    thresholdRatio: thresholdRatioSchema,
    retainRatio: retainRatioSchema,
    retainTokens: retainTokensSchema,
    summarizationProvider: summarizationProviderSchema,
    summarizationModel: summarizationModelSchema,
    maxTokens: maxTokensSchema,
    compactionRetries: compactionRetriesSchema,
    maxOverflowRetries: maxOverflowRetriesSchema,
    modelPolicies: z.array(modelPolicy),
    auto: z.boolean(),
  })

  /** Resolved and validated compaction configuration. */
  readonly config: ResolvedConfig

  private readonly warnedPressureConfigTargets = new Set<string>()
  private readonly overflowRetries = new WeakMap<Agent, number>()
  private readonly overflowAgents = new WeakMap<Session, Agent>()

  constructor(ctx: Context, config: BasicCompactionConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    if (this.config.auto) this._registerAutomaticCompaction()
  }

  /**
   * Register automatic between-step pressure and model-request overflow
   * recovery. `compactIfNeeded` stays dynamically dispatched so subclass
   * overrides are honored at event time.
   */
  private _registerAutomaticCompaction(): void {
    const { ctx } = this
    const logResult = (result: CompactionResult, trigger: string): void => {
      ctx.logger.info(
        `compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes `
        + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, `
        + `~${result.shadowedTokenCount} tokens)`,
      )
    }

    ctx.on('agent/pre-step', async (
      { agent, signal },
      next,
    ): Promise<PreStepDecision> => {
      if (!signal.aborted) {
        try {
          const result = await this.compactIfNeeded(agent, 'pressure', signal)
          if (result !== null) logResult(result, 'step pressure')
        } catch (error: unknown) {
          if (error instanceof TargetPressureConfigError) {
            if (this.warnedPressureConfigTargets.has(error.targetKey)) return next()
            this.warnedPressureConfigTargets.add(error.targetKey)
          }
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`)
        }
      }
      return next()
    })

    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent)
    })

    // A successful response starts a fresh overflow-recovery sequence even
    // when tool calls continue the same turn into another request.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const agent = this.overflowAgents.get(session)
      if (agent !== undefined) this.overflowRetries.delete(agent)
    })

    ctx.on('agent/request-error', async (
      { agent, failure, signal },
      next,
    ) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      this.overflowAgents.set(agent.session, agent)
      const target = routedTarget(agent.session)
      if (target === undefined) return next()
      const policy = resolveTargetPolicy(this.config, target)
      const retries = this.overflowRetries.get(agent) ?? 0
      if (retries >= policy.maxOverflowRetries) return next()

      const generation = agent.session.surface.replaceGeneration
      let result: CompactionResult | null
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal)
      } catch (recoveryError: unknown) {
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        // A model-free prune can land before later summary work fails. That
        // durable reduction is sufficient retry proof; do not discard it just
        // because the optional second phase threw. Cancellation still wins.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(
            `context-overflow compaction failed after durable surface progress: ${message}; `
            + 'retrying from the replacement surface',
          )
          this.overflowRetries.set(agent, retries + 1)
          return { kind: 'retry' }
        }
        ctx.logger.warn(
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
          `context-overflow compaction failed: ${message}; ${signal.aborted
            ? 'cancellation prevents retry'
            : 'preserving the original request error'}`,
        )
        return next()
      }
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while compaction is awaited.
      if (signal.aborted
        || agent.session.surface.replaceGeneration <= generation) return next()
      if (result !== null) logResult(result, 'context overflow recovery')
      this.overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    })
  }

  /**
   * Summarize the replayed conversation region through a direct one-shot
   * `ctx.llm.stream()` call whose prefix reuses the conversation's own system
   * prompt, tools, and messages so the provider's KV cache is not invalidated.
   * Override this sole hook for a template or remote summarizer.
   * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
   * @param agent - supplies routed-model history, fallback model, and session id.
   * @param signal - optional cancellation forwarded to the adapter.
   * @returns safe text summary blocks and the exact auxiliary call envelope and output.
   */
  protected async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const target = conversationTarget(agent)
    const config = target === undefined
      ? this.config
      : resolveTargetPolicy(this.config, target)
    return summarizeWithLlm(this.ctx, config, input, agent, signal)
  }

  /**
   * Compact for replayed step-boundary pressure or one provider-confirmed context
   * overflow. Both triggers price the latest durable routed request envelope;
   * overflow bypasses the normal threshold and retained-tail policy so it can
   * force one useful balanced reduction.
   * @param agent - agent whose latest durable routed request is measured.
   * @param trigger - normal step-boundary pressure or context-overflow recovery.
   * @param signal - live turn cancellation signal forwarded to summarization.
   * @returns the latest summary compaction result, or `null` when no summary ran.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const target = routedTarget(agent.session)
    if (target === undefined) return null
    const policy = resolveTargetPolicy(this.config, target)
    const meter = this.ctx.tokenMeter
    let measurement = meter.measure(agent.session)
    switch (trigger) {
      case 'context-overflow':
        break
      case 'pressure':
        break
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(trigger, 'compaction trigger')
    }

    // Pruning is optional so compaction-basic remains independently composable.
    // Overflow always qualifies; pressure first resolves the routed model's
    // capacity and checks its target-specific threshold.
    const prune = this.ctx.get('toolResultPruner')

    if (trigger === 'context-overflow') {
      if (prune !== undefined) {
        prune.pruneSession(agent.session)
        measurement = meter.measure(agent.session)
      }
      const range = selectCompactableRange(agent.session, measurement, 0)
      if (range === null) return null
      return this.compactRegion(range.start, range.end, agent, signal)
    }

    const context = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context
    assertNoActiveCompaction(agent.session, 'automatic pressure compaction')
    const targetKey = `${target.provider}/${target.model}`
    if (context === undefined) {
      throw new TargetPressureConfigError(
        targetKey,
        `compaction-basic: no context capacity for ${targetKey}; `
        + 'configure contextWindow on that adapter model',
      )
    }
    const spec = resolveCompactSpec(policy, context.contextWindow)
    if (measurement.totalTokens < spec.thresholdTokens) return null

    // Once pressure qualifies, land the model-free pass before choosing a
    // summary range, then remeasure through the singleton replay fold.
    if (prune !== undefined) {
      prune.pruneSession(agent.session)
      measurement = meter.measure(agent.session)
    }
    if (measurement.totalTokens < spec.thresholdTokens) return null

    let result: CompactionResult | null = null
    for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
      const range = selectCompactableRange(agent.session, measurement, spec.retainTokens)
      if (range === null) {
        /* v8 ignore else -- concrete replacement preserves a compactable checkpoint; subclass hooks cannot mutate it. */
        if (result === null) return null
        /* v8 ignore next -- paired with the defensive post-success branch above. */
        break
      }
      result = await this.compactRegion(range.start, range.end, agent, signal)
      measurement = meter.measure(agent.session)
      if (measurement.totalTokens < spec.thresholdTokens) return result
    }

    throw new Error(
      `compaction still above threshold after ${spec.compactionRetries + 1} compaction attempts `
      + `(${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`,
    )
  }

  /**
   * Compact one inclusive positional range from the agent-owned surface using
   * the effective token meter for all retention and shrink pricing.
   * @param start - inclusive first surface-node seq.
   * @param end - inclusive last surface-node seq.
   * @param agent - owner of the target session, used by the summarizer.
   * @param signal - optional summarization cancellation signal.
   * @returns the successful durable compaction result.
   */
  override async compactRegion(
    start: SessionSeq,
    end: SessionSeq,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    return compactSurfaceRegion(
      this.regionDependencies(),
      agent.session,
      start,
      end,
      agent,
      { owner: 'current-turn', stability: 'whole-surface' },
      signal,
    )
  }

  /**
   * Force one useful idle-session compaction below the pressure threshold, and
   * resolve only after its standalone marker pair is durably checkpointed.
   * @param agent - idle agent whose next-turn admission this call reserves.
   * @param signal - cancellation scoped to this compaction request.
   * @param sourceCommandId - initiating command identity for presentation correlation.
   * @returns the committed result, or `null` when no safe useful range exists.
   */
  override compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          const range = selectCompactableRange(
            agent.session,
            this.ctx.tokenMeter.measure(agent.session),
            0,
          )
          if (range === null) return null
          return await compactSurfaceRegion(
            this.regionDependencies(),
            agent.session,
            range.start,
            range.end,
            agent,
            {
              owner: null,
              stability: 'selected-span',
              ...sourceCommandId === undefined ? {} : { sourceCommandId },
              flush: async () => {
                await this.ctx.sessions.flush(agent.session)
              },
            },
            operationSignal,
          )
        } catch (error: unknown) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError(
              'cancelled',
              'manual compaction was cancelled',
              { cause: error },
            )
          }
          operationSignal.throwIfAborted()
          throw error
        }
      })
    } catch (error: unknown) {
      throw new ManualCompactionError(
        'busy',
        'manual compaction requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
  }

  /** Bind the effective token meter and dynamically dispatched summarizer hook. */
  private regionDependencies(): { meter: TokenMeter; summarize: RegionSummarize } {
    return {
      meter: this.ctx.tokenMeter,
      summarize: (input, owner, abort) => this.summarize(input, owner, abort),
    }
  }
}

export default BasicCompactionEngine
