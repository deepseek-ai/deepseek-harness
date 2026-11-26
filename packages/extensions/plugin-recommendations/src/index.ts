/**
 * Explicit-need official plugin recommendations: an `enable_official_plugin` card offers one plugin, and only a human
 * click enables it, installing an official connector the profile does not hold.
 */
import { z } from 'zod'
import { Service, type Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { isPluginStopping } from '@deepseek-ai/dsh-action-cards'
import type { ActionCardDecision, ActionCardId, ActionCardProposalOf, ActionCardResult } from '@deepseek-ai/dsh-action-cards'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import type { BundleInfo, ChangeResult } from '@deepseek-ai/dsh-plugin-manager/types'
import type {} from '@deepseek-ai/dsh-skill'
import { CONNECTORS_TAB_BUNDLE } from './connectors.ts'
import { eligible, registerOfficialPluginsSkill, targetOf } from './skill.ts'
import type { PluginData, PluginDetails, PluginPhase, RecommendationDetails } from './types.ts'
export type * from './types.ts'

export const name = 'plugin-recommendations'

/** Services the plugin uses; `actionCards` owns card state and user actions. */
export const inject = ['pluginManager', 'agents', 'skills', 'actionCards']

declare module '@deepseek-ai/cordis' {
  interface Context { pluginRecommendations: PluginRecommendations }
}

/** Card action this plugin registers. */
const ACTION = 'enable_official_plugin'

const detailsSchema = z.object({ name: z.string().trim().min(1) }) satisfies z.ZodType<PluginDetails>
/** Install scripts a failed decision recorded in the Session log. */
const buildsSchema = z.array(z.string()).min(1)

type PluginProposal = ActionCardProposalOf<PluginDetails>

/** Records one decision of the card being handled and returns it as the action's result. */
type Recorder = (phase: PluginPhase, data?: PluginData) => ActionCardResult

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

/** The install scripts a failed decision recorded as awaiting approval, or undefined when it recorded none. */
function recordedBuilds(decision: ActionCardDecision | undefined): string[] | undefined {
  if (decision?.phase !== 'failed') return undefined
  const builds = buildsSchema.safeParse(decision.data?.pendingBuilds)
  return builds.success ? builds.data : undefined
}

/** The phase a settled profile change records; a failed or cancelled one can be retried from the card. */
function phaseOf(application: ChangeResult['application']): 'enabled' | 'failed' {
  switch (application) {
    case 'applied': case 'restart-required': case 'overridden': return 'enabled'
    case 'failed': case 'cancelled': return 'failed'
    /* v8 ignore next -- ChangeResult.application is a closed union */
    default: return assertNever(application)
  }
}

/**
 * The install scripts a failed installation leaves awaiting approval when pnpm stopped it on them. After any failed run
 * the plugin manager lists every undecided script in the profile, including ones an earlier installation left, so no
 * other failure offers scripts for approval.
 */
function blockedBuilds(result: ChangeResult): string[] | undefined {
  const builds = result.packageResult?.kind === 'build-blocked' ? result.pendingBuilds : undefined
  return builds?.length === 0 ? undefined : builds
}

/** Catalog lookups for card text and the enabling and connector installation behind the `enable_official_plugin` card. */
export class PluginRecommendations extends TypertRemoteService {
  static inject = inject
  /** Card reconciliations, enabling and installation in flight; unloading waits for them. */
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
      action: ACTION, details: detailsSchema,
      verbs: { enable: { global: true }, approve: { global: true } },
      openPhases: ['failed', 'unconfirmed'],
      statusGuidance: 'Plugin cards: enabled means the plugin is on now, or after a DSH restart when application is restart-required; '
        + 'already-enabled means it was on before; failed, or unconfirmed when a reload cut enabling off, can be retried from the card; '
        + 'dismissed means the user declined it, so do not offer it again in this conversation; enabling authorizes nothing beyond that plugin; '
        + 'an enabled connector works once the user connects their account from the card or its Plugins page.',
      // The notice reports the outcome; the package names awaiting script approval stay on the card.
      statusFields: ['application', 'errorCode'],
      // Every action, including Not now, first learns whether an interrupted enable has since landed.
      reconcile: (agent, proposal) => this.tracked(this.confirm(agent, proposal)),
      act: (agent, proposal, verb) => this.tracked(this.enable(agent, proposal, verb)),
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
   * @param cardId - The card's id, never a package supplied by the browser.
   * @returns the plugin's title, description and selection, `connector` for an installed official connector,
   * `installable` with the connector catalog's title and description, in every shipped language, of an official
   * connector the profile does not hold, or a refusal when the card names no available official plugin.
   */
  @Remote
  async describe(agent: Agent, cardId: ActionCardId): Promise<RecommendationDetails> {
    if (this.isStopping()) return { status: 'refused', reason: 'closing' }
    if (this.ctx.agents.get(agent.id) !== agent || agent.session.header.origin === 'subagent') return { status: 'refused', reason: 'not-live-root' }
    const proposal = ownEntry(this.ctx.actionCards.view(agent.session).proposals, cardId)
    const details = proposal?.action === ACTION ? detailsSchema.safeParse(proposal.details) : undefined
    if (details?.success !== true) return { status: 'refused', reason: 'unknown' }
    const target = targetOf(await this.ctx.pluginManager.listBundles(), details.data.name)
    if (target === undefined) return { status: 'refused', reason: 'unavailable' }
    if (target.kind === 'install') return { status: 'installable', title: target.connector.meta.title, description: target.connector.meta.description }
    const { bundle, connector } = target
    return { status: 'available', title: bundle.meta?.title ?? bundle.name, description: bundle.meta?.description ?? bundle.description ?? '',
      enabled: bundle.enabled, ...connector === undefined ? {} : { connector: true } }
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
    if (ownEntry(cards.view(agent.session).decisions, proposal.cardId)?.phase !== 'unconfirmed') return
    const bundle = (await this.ctx.pluginManager.listBundles()).find(item => item.name === proposal.details.name)
    if (bundle?.enabled === true) cards.record(agent, { cardId: proposal.cardId, action: ACTION, phase: 'enabled' })
  }

  /**
   * Enable the card's plugin once, installing an official connector the profile does not hold; `approve` repeats an
   * installation that stopped on install scripts and allows exactly the scripts its failure recorded. Both enable a
   * connector that is installed by then, including one another action installed while this one waited. An enabled card
   * settles unchanged, and a failed or unconfirmed one can be retried.
   */
  private async enable(agent: Agent, proposal: PluginProposal, verb: string): Promise<ActionCardResult> {
    // Held from the start: an unload during the profile change still records where this card stands.
    const cards = this.ctx.actionCards
    const record: Recorder = (phase, data = {}) => {
      const fields = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined))
      const decision: ActionCardDecision = {
        cardId: proposal.cardId, action: ACTION, phase, ...Object.keys(fields).length === 0 ? {} : { data: fields },
      }
      cards.record(agent, decision)
      return settled(decision)
    }
    const previous = ownEntry(cards.view(agent.session).decisions, proposal.cardId)
    // Approval names come only from this card's own failed installation, never from the browser. A connector installed
    // since then is enabled like any other, and nothing is approved.
    const approvedBuilds = verb === 'approve' ? recordedBuilds(previous) : undefined
    if (verb === 'approve' && approvedBuilds === undefined) return refused('unavailable')
    if (previous !== undefined && previous.phase !== 'failed' && previous.phase !== 'unconfirmed') return settled(previous)
    const bundles = await this.ctx.pluginManager.listBundles()
    const target = targetOf(bundles, proposal.details.name)
    if (target === undefined) return refused('unavailable')
    let refusal = this.changeRefusal(agent)
    if (refusal === undefined && target.connector !== undefined) {
      await this.showConnectorsTab(bundles)
      refusal = this.changeRefusal(agent)
    }
    if (refusal !== undefined) return refusal
    if (target.kind === 'enable') {
      const { bundle } = target
      // An unconfirmed card's plugin that reconciliation still found off and is on now was turned on by its own enable.
      if (bundle.enabled) return record(previous?.phase === 'unconfirmed' ? 'enabled' : 'already-enabled')
      return this.settle(record, bundle.name, () => this.ctx.pluginManager.setBundleEnabled(bundle.name, true))
    }
    const { packageName: name } = target.connector
    return this.settle(record, name, async () => {
      // Each release publishes the connectors at the DSH version; any other package or version is undone.
      const version = getDshRuntimeVersion()
      const result = await this.ctx.pluginManager.installBundle(`${name}@${version}`, {
        saveExact: true, expected: { name, version }, ...approvedBuilds === undefined ? {} : { approvedBuilds },
      })
      // Another card or the Plugins page installed the connector while this installation waited for the profile, so
      // its selection is set instead, unless this plugin has started unloading.
      return result.error?.code === 'already-installed' && !this.isStopping() ? this.ctx.pluginManager.setBundleEnabled(name, true) : result
    })
  }

  /** The refusal of a profile change this plugin may not make now: it is unloading, or the conversation is no longer a live root. */
  private changeRefusal(agent: Agent): ActionCardResult | undefined {
    if (this.isStopping()) return refused('closing')
    if (this.ctx.agents.get(agent.id) !== agent || agent.session.header.origin === 'subagent') return refused('not-live-root')
    return undefined
  }

  /** Switch on the Connectors tab before a connector action; a failure is logged and the action continues. */
  private async showConnectorsTab(bundles: readonly BundleInfo[]): Promise<void> {
    const tab = bundles.find(item => item.name === CONNECTORS_TAB_BUNDLE)
    if (tab === undefined || !eligible(tab) || tab.enabled) return
    try {
      // Like the card's own change, an unload ends only this wait; the caller then checks again that it may change the profile.
      const result = await Promise.race([this.ctx.pluginManager.setBundleEnabled(tab.name, true), this.stopped.promise])
      if (result?.application === 'failed') this.ctx.logger.warn('Switching on %s failed: %s', tab.name, result.error?.code)
    } catch (error) {
      this.ctx.logger.warn('Switching on %s was rejected: %s', tab.name, String(error))
    }
  }

  /** Wait for one profile change of the card's plugin and record its outcome; an unload while waiting records `unconfirmed`. */
  private async settle(record: Recorder, name: string, change: () => Promise<ChangeResult>): Promise<ActionCardResult> {
    let result: ChangeResult | undefined
    try {
      // PluginManager owns the accepted profile mutation. HMR may unload this
      // consumer before it finishes, so only our wait for its result is cancelled.
      result = await Promise.race([change(), this.stopped.promise])
    } catch (error) {
      // A rejected change reports no management code; the card offers a retry instead of failing the click.
      this.ctx.logger.warn('The profile change for %s was rejected: %s', name, String(error))
      return record('failed', { errorCode: 'operation-error' })
    }
    if (result === undefined) {
      record('unconfirmed')
      return { status: 'unconfirmed', reason: 'closing' }
    }
    return record(phaseOf(result.application), {
      application: result.application === 'restart-required' ? 'restart-required' : undefined, errorCode: result.error?.code,
      pendingBuilds: blockedBuilds(result),
    })
  }
}

/**
 * Register the official-plugins skill, the `enable_official_plugin` card kind and the catalog-text Remote;
 * disposing the plugin stops local follow-up of pending enabling and installation and removes all three.
 * @param ctx - Owning plugin context.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.plugin(PluginRecommendations)
}
