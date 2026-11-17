/** Optional action cards below an answer: card state, user actions and status notices for registered kinds. */
import { FiberState, Service, type Context } from '@deepseek-ai/cordis'
import type { ZodType } from 'zod'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { actionCardProjection, type ActionCardState } from './projection.ts'
import type { ActionCardDecision, ActionCardFields, ActionCardId, ActionCardProposal, ActionCardResult, ActionCardView } from './types.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { actionCards: ActionCards }
}

/** The user action every card offers; the shared service records it. */
const DISMISS = 'dismiss'
/** Phases the projection derives from the log; no decision may record them. */
const DERIVED_PHASES: readonly string[] = ['replaced']
/** Phases after which no user action changes the card. */
const FINAL_PHASES: readonly string[] = ['dismissed', ...DERIVED_PHASES]

const STATUS_PREAMBLE = 'Latest status of action cards from user actions and background work. '
  + 'These are status facts, not a request to start or retry work. Use these receipts instead of the earlier proposal when describing progress.'
const STATUS_CLOSING = 'Continue with the user’s current request.'

/** The fiber fields the stopping check reads. */
export interface PluginFiber {
  readonly uid: number | null
  readonly state: FiberState
  readonly parent: { readonly fiber: PluginFiber }
}

/**
 * Whether a plugin must refuse new work: its fiber or an ancestor is disposed or unloading, since a parent's disposal
 * begins before the plugin's own effects run, or the plugin's own drain has begun.
 * @param owner - the plugin's fiber.
 * @param draining - whether the plugin's drain effect has started.
 * @returns whether the plugin is stopping.
 */
export function isPluginStopping(owner: PluginFiber, draining: boolean): boolean {
  for (let fiber = owner; ; fiber = fiber.parent.fiber) {
    if (fiber.uid === null || fiber.state === FiberState.UNLOADING) return true
    if (fiber.parent.fiber === fiber) return draining
  }
}

/** Shared checks one user action of a kind requires before the kind handles it. */
export interface ActionCardVerb {
  /** The connection must hold global Remote access, as for profile changes. */
  readonly global?: true
  /** Refused while the Session sandbox mode is read-only. */
  readonly writes?: true
}

/** A proposal whose details passed its kind's schema. */
export type ActionCardProposalOf<Details> = Omit<ActionCardProposal, 'details'> & { readonly details: Details }

/** Host half of one action kind: its fields and its user actions. The kind's skill tells the model how to offer the card. */
export interface ActionCardKind<Details> {
  /** Value of the card's `action` field. */
  readonly action: string
  /** Validates `details` before each user action; a card that fails it offers only `dismiss`. */
  readonly details: ZodType<Details>
  /** User actions besides `dismiss`, with the shared checks each requires; other verbs are refused as unavailable. */
  readonly verbs: Readonly<Record<string, ActionCardVerb>>
  /** Recorded phases that still offer the action; dismissal is recorded for these and for an unstarted card. */
  readonly openPhases?: readonly string[]
  /** Sentences the status notice adds when it reports this kind's decisions. */
  readonly statusGuidance?: string
  /** Decision data fields the status notice reports; omitted reports every field. */
  readonly statusFields?: readonly string[]
  /**
   * Fields recorded with a dismissal.
   * @param proposal - the dismissed card.
   * @param payload - fields the user's client sent.
   * @returns decision data, or undefined to record none.
   */
  dismissal?(proposal: ActionCardProposalOf<Details>, payload: ActionCardFields | undefined): ActionCardFields | undefined
  /**
   * Bring the card's recorded decision up to date with state outside the Session, such as an installation that
   * finished while the Session was closed, recording each change with {@link ActionCards.record}. The service awaits it
   * before every user action, including `dismiss`, then reads the card's decision again, so a card that is no longer
   * open settles instead of being dismissed.
   * @param agent - live root of the card's Session.
   * @param proposal - the card with validated details.
   * @throws when that state cannot be read; the action is then refused as unavailable.
   */
  reconcile?(agent: Agent, proposal: ActionCardProposalOf<Details>): Promise<void>
  /**
   * Handle one user action other than `dismiss` after the shared checks passed. The handler records each new
   * decision with {@link ActionCards.record}.
   * @param agent - live root of the card's Session.
   * @param proposal - the card with validated details.
   * @param verb - one of {@link verbs}.
   * @param payload - fields the user's client sent; the kind validates them.
   * @returns the action's result.
   */
  act(agent: Agent, proposal: ActionCardProposalOf<Details>, verb: string, payload: ActionCardFields | undefined): Promise<ActionCardResult>
}

/** A registered kind with its details type erased behind validating closures. */
interface RegisteredKind {
  readonly verbs: Readonly<Record<string, ActionCardVerb>>
  readonly openPhases: readonly string[]
  readonly statusGuidance: string | undefined
  readonly statusFields: readonly string[] | undefined
  readonly dismissal: (proposal: ActionCardProposal, payload: ActionCardFields | undefined) => ActionCardFields | undefined
  /** Absent when the kind keeps no state outside the Session. */
  readonly reconcile: ((agent: Agent, proposal: ActionCardProposal) => Promise<void>) | undefined
  readonly act: (
    agent: Agent, proposal: ActionCardProposal, verb: string, payload: ActionCardFields | undefined,
  ) => Promise<ActionCardResult>
}

/** Own entries only: browser-supplied ids such as `toString` never reach inherited object members. */
function ownEntry<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function refused(reason: string): ActionCardResult {
  return { status: 'refused', reason }
}

/** Kind registry, Session projection, user actions and status notices. */
export class ActionCards extends TypertRemoteService {
  static inject = ['agents', 'sessionProjections', 'remoteAccess']
  private projection!: ProjectionHandle<ActionCardState>
  private readonly kinds = new Map<string, RegisteredKind>()
  /**
   * Actions whose kind unregistered. Cordis disposes a plugin's effects concurrently, so a kind's unload drain can
   * still record the outcome of its in-flight work after its registration is gone.
   */
  private readonly retired = new Set<string>()
  private readonly actions = new Map<string, Promise<ActionCardResult>>()
  private closing = false
  private readonly owner: Context['fiber']

  /**
   * @param ctx - Owning plugin context.
   */
  constructor(ctx: Context) {
    super(ctx, 'actionCards')
    this.owner = ctx.fiber
  }

  private isLiveRoot(agent: Agent): boolean {
    return this.ctx.agents.get(agent.id) === agent && agent.session.header.origin !== 'subagent'
  }

  protected async [Service.init](): Promise<void> {
    this.projection = await this.ctx.sessionProjections.register(actionCardProjection)
    this.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted || this.isStopping()) return decision
      const state = this.projection.stateOf(agent.session)
      const pending = Object.values(state.pendingStatus)
      if (pending.length === 0) return decision
      const receipts = Object.values(state.view.decisions).filter(receipt => Object.hasOwn(state.pendingStatus, receipt.cardId))
      const guidance = new Set(receipts.flatMap(receipt => this.kinds.get(receipt.action)?.statusGuidance ?? []))
      const updates = receipts.map((receipt) => {
        const fields = this.kinds.get(receipt.action)?.statusFields
        const data = receipt.data === undefined || fields === undefined ? receipt.data
          : Object.fromEntries(Object.entries(receipt.data).filter(([key]) => fields.includes(key)))
        return { action: receipt.action, title: ownEntry(state.view.proposals, receipt.cardId)?.title,
          phase: receipt.phase, ...data === undefined ? {} : { data } }
      })
      return { ...decision, messages: [...decision.messages, createUserMessage({
        source: { kind: 'action-cards', through: SessionSeq(Math.max(...pending)), form: 'notice', summary: 'Action card status updated' },
        content: [{ type: 'text', text: [STATUS_PREAMBLE, ...guidance, STATUS_CLOSING].join(' ') + '\n' + JSON.stringify(updates) }],
      })] }
    }, { prepend: true })
    this.ctx.effect(() => async () => {
      this.closing = true
      await Promise.allSettled([...this.actions.values()])
    }, 'action-cards: drain user actions')
  }

  /**
   * Register one action kind for the caller's lifetime.
   * @param kind - the kind's details schema, verbs and handler.
   * @returns disposer removing the kind; actions on its cards are then unavailable.
   * @throws when another kind already registered the same action.
   */
  register<Details>(kind: ActionCardKind<Details>): () => void {
    const typed = (proposal: ActionCardProposal): ActionCardProposalOf<Details> | undefined => {
      const details = kind.details.safeParse(proposal.details)
      return details.success ? { ...proposal, details: details.data } : undefined
    }
    const reconcile = kind.reconcile?.bind(kind)
    const entry: RegisteredKind = {
      verbs: kind.verbs, openPhases: kind.openPhases ?? [], statusGuidance: kind.statusGuidance, statusFields: kind.statusFields,
      dismissal: (proposal, payload) => {
        const card = typed(proposal)
        return card === undefined ? undefined : kind.dismissal?.(card, payload)
      },
      // A card whose details do not validate never reaches the kind, so the kind has nothing to reconcile.
      reconcile: reconcile === undefined ? undefined : async (agent, proposal) => {
        const card = typed(proposal)
        if (card !== undefined) await reconcile(agent, card)
      },
      act: (agent, proposal, verb, payload) => {
        const card = typed(proposal)
        return card === undefined ? Promise.resolve(refused('unavailable')) : kind.act(agent, card, verb, payload)
      },
    }
    const dispose = this.ctx.effect(() => {
      if (this.kinds.has(kind.action)) throw new Error(`action-cards: action "${kind.action}" is already registered`)
      this.kinds.set(kind.action, entry)
      return () => {
        this.kinds.delete(kind.action)
        this.retired.add(kind.action)
      }
    }, `action-cards: kind ${kind.action}`)
    return () => { void dispose() }
  }

  /**
   * Record a card decision in the Session log; the next model request reports it.
   * @param agent - agent whose Session owns the card.
   * @param decision - the card's new state.
   * @throws when no kind ever registered the decision's action with this service, or its phase is one the projection derives.
   */
  record(agent: Agent, decision: ActionCardDecision): void {
    if (!this.kinds.has(decision.action) && !this.retired.has(decision.action)) {
      throw new Error(`action-cards: cannot record a decision for unregistered action "${decision.action}"`)
    }
    if (DERIVED_PHASES.includes(decision.phase)) throw new Error(`action-cards: phase "${decision.phase}" is derived from the log and cannot be recorded`)
    this.append(agent, decision)
  }

  /**
   * Read the cards of one Session.
   * @param session - a Session whose projections are prepared.
   * @returns proposals and decisions by card id.
   */
  view(session: Session): ActionCardView {
    return this.projection.stateOf(session).view
  }

  /**
   * Apply a user action to a logged card. Shared checks run first, then the kind reconciles the card; `dismiss` is
   * recorded here and every other verb goes to the card's kind. `dismiss` also works on an unstarted card whose kind
   * is no longer registered. Concurrent actions on one card share one operation.
   * @param agent - live root resolved from the displayed Session.
   * @param cardId - the card's id in the Session's card view.
   * @param verb - `dismiss` or one of the kind's verbs.
   * @param payload - kind-defined fields such as a chosen location.
   * @returns acceptance of background work, the decision in effect, or a refusal.
   */
  @Remote
  act(agent: Agent, cardId: ActionCardId, verb: string, payload?: Record<string, JsonValue>): Promise<ActionCardResult> {
    if (this.isStopping()) return Promise.resolve(refused('closing'))
    if (!this.isLiveRoot(agent)) return Promise.resolve(refused('not-live-root'))
    const proposal = ownEntry(this.projection.stateOf(agent.session).view.proposals, cardId)
    if (proposal === undefined) return Promise.resolve(refused('unknown'))
    const kind = this.kinds.get(proposal.action)
    if (verb === DISMISS) return this.coalesce(agent, cardId, () => this.dismiss(agent, kind, proposal, payload))
    const policy = kind === undefined ? undefined : ownEntry(kind.verbs, verb)
    if (kind === undefined || policy === undefined) return Promise.resolve(refused('unavailable'))
    if (policy.global === true && !this.ctx.remoteAccess.allows({ kind: 'global' })) return Promise.resolve(refused('access-denied'))
    return this.coalesce(agent, cardId, () => this.perform(agent, kind, proposal, verb, policy, payload))
  }

  /** Share one operation per card, run under the Agent's initiator, until it settles. */
  private coalesce(agent: Agent, cardId: ActionCardId, run: () => Promise<ActionCardResult>): Promise<ActionCardResult> {
    const key = JSON.stringify([agent.id, cardId])
    const existing = this.actions.get(key)
    if (existing !== undefined) return existing
    const operation = this.ctx.agents.withInitiator(agent, run).finally(() => { this.actions.delete(key) })
    this.actions.set(key, operation)
    return operation
  }

  /**
   * Await the kind's reconciliation. A kind that unloads meanwhile still handles the action and refuses it itself.
   * @returns a refusal when reconciliation failed or the root closed meanwhile; undefined to continue.
   */
  private async reconciled(
    agent: Agent, kind: RegisteredKind, proposal: ActionCardProposal, verb: string,
  ): Promise<ActionCardResult | undefined> {
    if (kind.reconcile === undefined) return undefined
    try { await kind.reconcile(agent, proposal) }
    catch (error) {
      this.ctx.logger.warn('Cannot reconcile action card %s before %s: %s', proposal.cardId, verb, String(error))
      return refused('unavailable')
    }
    return this.isLiveRoot(agent) ? undefined : refused('not-live-root')
  }

  private async dismiss(
    agent: Agent, kind: RegisteredKind | undefined, proposal: ActionCardProposal, payload: ActionCardFields | undefined,
  ): Promise<ActionCardResult> {
    const refusal = kind === undefined ? undefined : await this.reconciled(agent, kind, proposal, DISMISS)
    if (refusal !== undefined) return refusal
    const decision = ownEntry(this.projection.stateOf(agent.session).view.decisions, proposal.cardId)
    // Without its kind no recorded phase is known to be open, and the kind may return to act on it.
    if (decision !== undefined && (FINAL_PHASES.includes(decision.phase) || kind?.openPhases.includes(decision.phase) !== true)) {
      return { status: 'settled', decision }
    }
    const data = kind?.dismissal(proposal, payload)
    const dismissed: ActionCardDecision = { cardId: proposal.cardId, action: proposal.action, phase: 'dismissed', ...data === undefined ? {} : { data } }
    this.append(agent, dismissed)
    return { status: 'settled', decision: dismissed }
  }

  private async perform(
    agent: Agent, kind: RegisteredKind, proposal: ActionCardProposal, verb: string, policy: ActionCardVerb,
    payload: ActionCardFields | undefined,
  ): Promise<ActionCardResult> {
    const refusal = await this.reconciled(agent, kind, proposal, verb)
    if (refusal !== undefined) return refusal
    const decision = ownEntry(this.projection.stateOf(agent.session).view.decisions, proposal.cardId)
    if (decision !== undefined && FINAL_PHASES.includes(decision.phase)) return { status: 'settled', decision }
    if (policy.writes === true && this.ctx.get('sandboxPolicy')?.resolve({ session: agent.session }).mode === 'read-only') return refused('read-only')
    return await kind.act(agent, proposal, verb, payload)
  }

  private append(agent: Agent, decision: ActionCardDecision): void {
    appendPluginRecord(agent.session, 'plugin:action-cards/decision', decision)
  }

  private isStopping(): boolean {
    return isPluginStopping(this.owner, this.closing)
  }
}

export default ActionCards
