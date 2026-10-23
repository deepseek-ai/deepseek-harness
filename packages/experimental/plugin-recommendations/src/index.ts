/** Explicit-need official plugin recommendations: an `enable_official_plugin` card offers one plugin, and only a human click enables it. */
import { z } from 'zod'
import { Service, type Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isPluginStopping } from '@deepseek-ai/dsh-action-cards'
import type { ActionCardDecision, ActionCardProposalOf, ActionCardResult } from '@deepseek-ai/dsh-action-cards'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import type { ChangeResult } from '@deepseek-ai/dsh-plugin-manager/types'
import type {} from '@deepseek-ai/dsh-skill'
import { eligible, registerOfficialPluginsSkill } from './skill.ts'
import type { PluginData, PluginDetails, PluginPhase, RecommendationDetails } from './types.ts'
export type * from './types.ts'

export const name = 'plugin-recommendations'

/** Services the plugin uses; `actionCards` owns the card tool, card state and user actions. */
export const inject = ['pluginManager', 'agents', 'skills', 'actionCards']

declare module '@deepseek-ai/cordis' {
  interface Context { pluginRecommendations: PluginRecommendations }
}

/** Card action this plugin registers. */
const ACTION = 'enable_official_plugin'

const detailsSchema = z.object({ name: z.string().trim().min(1) }) satisfies z.ZodType<PluginDetails>

type PluginProposal = ActionCardProposalOf<PluginDetails>

/** Own entries only: browser-supplied ids such as `toString` never reach inherited object members. */
function ownEntry<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function settled(decision: ActionCardDecision): ActionCardResult {
  return { status: 'settled', decision }
}

function refused(reason: string): ActionCardResult {
  return { status: 'refused', reason }
}

/** Catalog lookups for card text and the enabling behind the `enable_official_plugin` card. */
export class PluginRecommendations extends TypertRemoteService {
  static inject = inject
  /** Card reconciliations and enabling in flight; unloading waits for them. */
  private readonly operations = new Set<Promise<unknown>>()
  private readonly stopped = Promise.withResolvers<undefined>()
  private closing = false
  private readonly owner: Context['fiber']

  constructor(ctx: Context) {
    super(ctx, 'pluginRecommendations')
    this.owner = ctx.fiber
  }

  protected [Service.init](): void {
    registerOfficialPluginsSkill(this.ctx)
    this.ctx.actionCards.register({
      action: ACTION, skill: 'official-plugins', details: detailsSchema,
      invitation: 'End with at most one short invitation in the user’s language to click Enable below; '
        + 'do not say the plugin is already on.',
      verbs: { enable: { global: true } },
      openPhases: ['failed', 'unconfirmed'],
      statusGuidance: 'Plugin cards: enabled means the plugin is on now, or after a DSH restart when application is restart-required; '
        + 'already-enabled means it was on before; failed, or unconfirmed when a reload cut enabling off, can be retried from the card; '
        + 'dismissed means the user declined it, so do not offer it again in this conversation; enabling authorizes nothing beyond that plugin.',
      // Every action, including Not now, first learns whether an interrupted enable has since landed.
      reconcile: (agent, proposal) => this.tracked(this.confirm(agent, proposal)),
      act: (agent, proposal) => this.tracked(this.enable(agent, proposal)),
    })
    this.ctx.effect(() => async () => {
      this.closing = true
      this.stopped.resolve(undefined)
      await Promise.allSettled([...this.operations])
    }, 'plugin-recommendations: drain enabling')
  }

  /**
   * Read the current catalog text for a logged card.
   * @param agent - Exact live root resolved by the Gateway from the Session id.
   * @param callId - The card's `propose_action` call id, never a package supplied by the browser.
   * @returns the plugin's title, description and selection, or a refusal when the card names no available official plugin.
   */
  @Remote
  async describe(agent: Agent, callId: ToolCallId): Promise<RecommendationDetails> {
    if (this.isStopping()) return { status: 'refused', reason: 'closing' }
    if (!this.ctx.agents.roots().includes(agent)) return { status: 'refused', reason: 'not-live-root' }
    const proposal = ownEntry(this.ctx.actionCards.view(agent.session).proposals, callId)
    const details = proposal?.action === ACTION ? detailsSchema.safeParse(proposal.details) : undefined
    if (details?.success !== true) return { status: 'refused', reason: 'unknown' }
    const bundle = (await this.ctx.pluginManager.listBundles()).find(item => item.name === details.data.name)
    if (bundle === undefined || !eligible(bundle)) return { status: 'refused', reason: 'unavailable' }
    return { status: 'available', title: bundle.meta?.title ?? bundle.name,
      description: bundle.meta?.description ?? bundle.description ?? '', enabled: bundle.enabled }
  }

  private isStopping(): boolean {
    return isPluginStopping(this.owner, this.closing)
  }

  /** Track an operation until it settles, so unloading waits for it. */
  private tracked<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    return operation.finally(() => { this.operations.delete(operation) })
  }

  /** Record `enabled` on an unconfirmed card whose interrupted enable has since turned its plugin on. */
  private async confirm(agent: Agent, proposal: PluginProposal): Promise<void> {
    // Held from the start, like enabling: an unload while the catalog is read still records the outcome.
    const cards = this.ctx.actionCards
    if (ownEntry(cards.view(agent.session).decisions, proposal.callId)?.phase !== 'unconfirmed') return
    const bundle = (await this.ctx.pluginManager.listBundles()).find(item => item.name === proposal.details.name)
    if (bundle?.enabled === true) cards.record(agent, { callId: proposal.callId, action: ACTION, phase: 'enabled' })
  }

  /** Enable the card's plugin once; an enabled card settles unchanged, and a failed or unconfirmed one can be retried. */
  private async enable(agent: Agent, proposal: PluginProposal): Promise<ActionCardResult> {
    // Held from the start: an unload during the profile change still records where this card stands.
    const cards = this.ctx.actionCards
    const record = (phase: PluginPhase, data: PluginData = {}): ActionCardResult => {
      const fields = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined))
      const decision: ActionCardDecision = {
        callId: proposal.callId, action: ACTION, phase, ...Object.keys(fields).length === 0 ? {} : { data: fields },
      }
      cards.record(agent, decision)
      return settled(decision)
    }
    const previous = ownEntry(cards.view(agent.session).decisions, proposal.callId)
    if (previous !== undefined && previous.phase !== 'failed' && previous.phase !== 'unconfirmed') return settled(previous)
    const bundle = (await this.ctx.pluginManager.listBundles()).find(item => item.name === proposal.details.name)
    if (bundle === undefined || !eligible(bundle)) return refused('unavailable')
    if (this.isStopping()) return refused('closing')
    if (!this.ctx.agents.roots().includes(agent)) return refused('not-live-root')
    // An unconfirmed card's plugin that reconciliation still found off and is on now was turned on by its own enable.
    if (bundle.enabled) return record(previous?.phase === 'unconfirmed' ? 'enabled' : 'already-enabled')
    let result: ChangeResult | undefined
    try {
      // PluginManager owns the accepted profile mutation. HMR may unload this
      // consumer before it finishes, so only our wait for its result is cancelled.
      result = await Promise.race([this.ctx.pluginManager.setBundleEnabled(bundle.name, true), this.stopped.promise])
    } catch (error) {
      // A rejected change reports no management code; the card offers a retry instead of failing the click.
      this.ctx.logger.warn('Enabling %s was rejected: %s', bundle.name, String(error))
      return record('failed', { errorCode: 'operation-error' })
    }
    if (result === undefined) {
      record('unconfirmed')
      return { status: 'unconfirmed', reason: 'closing' }
    }
    return record(result.application === 'failed' ? 'failed' : 'enabled', {
      application: result.application === 'restart-required' ? 'restart-required' : undefined, errorCode: result.error?.code,
    })
  }
}

/**
 * Register the official-plugins skill, the `enable_official_plugin` card kind and the catalog-text Remote;
 * disposing the plugin stops local follow-up of pending enabling and removes all three.
 * @param ctx - Owning plugin context.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.plugin(PluginRecommendations)
}
