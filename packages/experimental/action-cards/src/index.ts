/** Optional action cards below an answer: the `propose_action` tool, card state, user actions and status notices for registered kinds. */
import { FiberState, Service, type Context } from '@deepseek-ai/cordis'
import { z, type ZodError, type ZodType } from 'zod'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createUserMessage, HarnessError, type ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { appendPluginRecord, SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { actionCardProjection, PROPOSE_ACTION, type ActionCardState } from './projection.ts'
import type { ActionCardDecision, ActionCardFields, ActionCardProposal, ActionCardResult, ActionCardView } from './types.ts'
export type * from './types.ts'

/** Deployment-tunable limits for offering cards. */
export const Config = z.object({
  /** Queued next-turn user messages at or above which `propose_action` refuses, so no card is offered. */
  queuedMessageLimit: z.number().int().min(1).default(2),
}).prefault({})
/** Validated card limits after schema defaults. */
export type Config = z.infer<typeof Config>

declare module '@deepseek-ai/cordis' {
  interface Context { actionCards: ActionCards }
}

/** The user action every card offers; the shared service records it. */
const DISMISS = 'dismiss'
/** Phases the projection derives from the log; no decision may record them. */
const DERIVED_PHASES: readonly string[] = ['replaced']
/** Phases after which no user action changes the card. */
const FINAL_PHASES: readonly string[] = ['dismissed', ...DERIVED_PHASES]
/** Tool whose successful loads activate `propose_action`; its `name` argument names the skill. */
const SKILL_TOOL = 'skill'
const skillArguments = z.object({ name: z.string() })

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

/** A refused `propose_action` call; the message tells the model what to do instead. */
export class ActionCardError extends HarnessError {}

/** Shared checks one user action of a kind requires before the kind handles it. */
export interface ActionCardVerb {
  /** The connection must hold global Remote access, as for profile changes. */
  readonly global?: true
  /** Refused while the Session sandbox mode is read-only. */
  readonly writes?: true
}

/** A proposal whose details passed its kind's schema. */
export type ActionCardProposalOf<Details> = Omit<ActionCardProposal, 'details'> & { readonly details: Details }

/** Host half of one action kind: the skill that proposes it, its fields and its user actions. */
export interface ActionCardKind<Details> {
  /** Value of the `action` argument. */
  readonly action: string
  /** Skill whose instructions propose this action; a load in the current turn admits the call. */
  readonly skill: string
  /**
   * Model-facing closing guidance that the result of an accepted call gives: one or two sentences on how to invite
   * the user to the card, in the user's language. Refused calls never carry it, so the model invites the user only to a
   * card that exists.
   */
  readonly invitation: string
  /** Validates `details` when the model proposes and before each user action. */
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
  readonly skill: string
  readonly invitation: string
  readonly verbs: Readonly<Record<string, ActionCardVerb>>
  readonly openPhases: readonly string[]
  readonly statusGuidance: string | undefined
  readonly statusFields: readonly string[] | undefined
  /** Describe why details fail the kind's schema; undefined when they pass. */
  readonly detailsIssues: (details: ActionCardFields) => string | undefined
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

function issuesOf(error: ZodError): string {
  return 'Invalid details: ' + error.issues.map(issue => `${['details', ...issue.path.map(String)].join('.')}: ${issue.message}`).join('; ')
}

/** Card tool, kind registry, Session projection, user actions and status notices. */
export class ActionCards extends TypertRemoteService {
  static inject = ['tools', 'agents', 'sessionProjections', 'remoteAccess']
  static Config = Config
  private projection!: ProjectionHandle<ActionCardState>
  private readonly kinds = new Map<string, RegisteredKind>()
  /**
   * Actions whose kind unregistered. Cordis disposes a plugin's effects concurrently, so a kind's unload drain can
   * still record the outcome of its in-flight work after its registration is gone.
   */
  private readonly retired = new Set<string>()
  /** Skills of registered kinds each live agent has loaded; `propose_action` is declared while one is still registered. */
  private readonly loaded = new Map<Agent, Set<string>>()
  /** Kind skills each agent loaded in its latest turn. */
  private readonly turnLoads = new Map<Agent, { readonly turn: number; readonly skills: Set<string> }>()
  /** The call accepted in each agent's latest turn, until its result fails. */
  private readonly accepted = new Map<Agent, { readonly turn: number; readonly callId: ToolCallId }>()
  private readonly actions = new Map<string, Promise<ActionCardResult>>()
  private closing = false
  private readonly owner: Context['fiber']

  /**
   * @param ctx - Owning plugin context.
   * @param config - Validated card limits; direct composition without a config gets the schema defaults.
   */
  constructor(ctx: Context, private readonly config: Config = Config.parse({})) {
    super(ctx, 'actionCards')
    this.owner = ctx.fiber
  }

  protected async [Service.init](): Promise<void> {
    this.projection = await this.ctx.sessionProjections.register(actionCardProjection)
    this.ctx.tools.register(defineTool({
      name: PROPOSE_ACTION,
      description: 'Show the user one optional action card under this answer. Call only as the skill that names the action instructs.',
      parameters: {
        action: { type: 'string', required: true, description: 'Action name from the skill.' },
        title: { type: 'string', required: true, description: 'Card title.' },
        brief: { type: 'string', required: true, description: 'What the action does, in the user\'s language.' },
        details: { type: 'object', additionalProperties: true, required: true, description: 'Fields the skill lists for this action.' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            action: { type: 'string', required: true }, title: { type: 'string', required: true }, invitation: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `Card shown below your answer. Do not restate it. ${value.invitation}` }],
      },
      execute: (args, exec) => Promise.resolve(this.propose(args, exec)),
    }), { when: ({ agent }) => this.declares(agent) })
    this.ctx.on('tools/result', (exec, result) => {
      const agent = exec.agent
      if (agent === undefined) return
      if (exec.name === PROPOSE_ACTION) {
        if (result.isError && this.accepted.get(agent)?.callId === exec.callId) this.accepted.delete(agent)
        return
      }
      // Loads by subagents or from code activate nothing: `propose_action` refuses both callers.
      if (exec.parent !== undefined || !this.ctx.agents.roots().includes(agent)) return
      const skill = exec.name === SKILL_TOOL && !result.isError ? skillArguments.safeParse(exec.arguments) : undefined
      if (skill?.success !== true || ![...this.kinds.values()].some(kind => kind.skill === skill.data.name)) return
      const turn = this.ctx.agents.turnBoundaryOf(agent.session).lastTurn
      const loads = this.turnLoads.get(agent)
      if (loads?.turn === turn) loads.skills.add(skill.data.name)
      else this.turnLoads.set(agent, { turn, skills: new Set([skill.data.name]) })
      this.loaded.set(agent, new Set([...this.loaded.get(agent) ?? [], skill.data.name]))
    })
    this.ctx.on('agent/disposed', ({ agent }) => {
      this.loaded.delete(agent)
      this.turnLoads.delete(agent)
      this.accepted.delete(agent)
    })
    this.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted || this.isStopping()) return decision
      const state = this.projection.stateOf(agent.session)
      const pending = Object.values(state.pendingStatus)
      if (pending.length === 0) return decision
      const receipts = Object.values(state.view.decisions).filter(receipt => Object.hasOwn(state.pendingStatus, receipt.callId))
      const guidance = new Set(receipts.flatMap(receipt => this.kinds.get(receipt.action)?.statusGuidance ?? []))
      const updates = receipts.map((receipt) => {
        const fields = this.kinds.get(receipt.action)?.statusFields
        const data = receipt.data === undefined || fields === undefined ? receipt.data
          : Object.fromEntries(Object.entries(receipt.data).filter(([key]) => fields.includes(key)))
        return { action: receipt.action, callId: receipt.callId, title: ownEntry(state.view.proposals, receipt.callId)?.title,
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
   * @param kind - the kind's skill, details schema, verbs and handler.
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
      skill: kind.skill, invitation: kind.invitation, verbs: kind.verbs, openPhases: kind.openPhases ?? [],
      statusGuidance: kind.statusGuidance, statusFields: kind.statusFields,
      detailsIssues: (details) => {
        const parsed = kind.details.safeParse(details)
        return parsed.success ? undefined : issuesOf(parsed.error)
      },
      dismissal: (proposal, payload) => {
        const card = typed(proposal)
        return card === undefined ? undefined : kind.dismissal?.(card, payload)
      },
      // A card whose details no longer validate never reached the kind, so the kind has nothing to reconcile.
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
   * @returns proposals and decisions by call id.
   */
  view(session: Session): ActionCardView {
    return this.projection.stateOf(session).view
  }

  /**
   * Apply a user action to a logged card. Shared checks run first, then the kind reconciles the card; `dismiss` is
   * recorded here and every other verb goes to the card's kind. `dismiss` also works on an unstarted card whose kind
   * is no longer registered. Concurrent actions on one card share one operation.
   * @param agent - live root resolved from the displayed Session.
   * @param callId - the card's `propose_action` call id.
   * @param verb - `dismiss` or one of the kind's verbs.
   * @param payload - kind-defined fields such as a chosen location.
   * @returns acceptance of background work, the decision in effect, or a refusal.
   */
  @Remote
  act(agent: Agent, callId: ToolCallId, verb: string, payload?: Record<string, JsonValue>): Promise<ActionCardResult> {
    if (this.isStopping()) return Promise.resolve(refused('closing'))
    if (!this.ctx.agents.roots().includes(agent)) return Promise.resolve(refused('not-live-root'))
    const proposal = ownEntry(this.projection.stateOf(agent.session).view.proposals, callId)
    if (proposal === undefined) return Promise.resolve(refused('unknown'))
    const kind = this.kinds.get(proposal.action)
    if (verb === DISMISS) return this.coalesce(agent, callId, () => this.dismiss(agent, kind, proposal, payload))
    const policy = kind === undefined ? undefined : ownEntry(kind.verbs, verb)
    if (kind === undefined || policy === undefined) return Promise.resolve(refused('unavailable'))
    if (policy.global === true && !this.ctx.remoteAccess.allows({ kind: 'global' })) return Promise.resolve(refused('access-denied'))
    return this.coalesce(agent, callId, () => this.perform(agent, kind, proposal, verb, policy, payload))
  }

  /** Share one operation per card, run under the Agent's initiator, until it settles. */
  private coalesce(agent: Agent, callId: ToolCallId, run: () => Promise<ActionCardResult>): Promise<ActionCardResult> {
    const key = JSON.stringify([agent.id, callId])
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
      this.ctx.logger.warn('Cannot reconcile action card %s before %s: %s', proposal.callId, verb, String(error))
      return refused('unavailable')
    }
    return this.ctx.agents.roots().includes(agent) ? undefined : refused('not-live-root')
  }

  private async dismiss(
    agent: Agent, kind: RegisteredKind | undefined, proposal: ActionCardProposal, payload: ActionCardFields | undefined,
  ): Promise<ActionCardResult> {
    const refusal = kind === undefined ? undefined : await this.reconciled(agent, kind, proposal, DISMISS)
    if (refusal !== undefined) return refusal
    const decision = ownEntry(this.projection.stateOf(agent.session).view.decisions, proposal.callId)
    // Without its kind no recorded phase is known to be open, and the kind may return to act on it.
    if (decision !== undefined && (FINAL_PHASES.includes(decision.phase) || kind?.openPhases.includes(decision.phase) !== true)) {
      return { status: 'settled', decision }
    }
    const data = kind?.dismissal(proposal, payload)
    const dismissed: ActionCardDecision = { callId: proposal.callId, action: proposal.action, phase: 'dismissed', ...data === undefined ? {} : { data } }
    this.append(agent, dismissed)
    return { status: 'settled', decision: dismissed }
  }

  private async perform(
    agent: Agent, kind: RegisteredKind, proposal: ActionCardProposal, verb: string, policy: ActionCardVerb,
    payload: ActionCardFields | undefined,
  ): Promise<ActionCardResult> {
    const refusal = await this.reconciled(agent, kind, proposal, verb)
    if (refusal !== undefined) return refusal
    const decision = ownEntry(this.projection.stateOf(agent.session).view.decisions, proposal.callId)
    if (decision !== undefined && FINAL_PHASES.includes(decision.phase)) return { status: 'settled', decision }
    if (policy.writes === true && this.ctx.get('sandboxPolicy')?.resolve({ session: agent.session }).mode === 'read-only') return refused('read-only')
    return await kind.act(agent, proposal, verb, payload)
  }

  private append(agent: Agent, decision: ActionCardDecision): void {
    appendPluginRecord(agent.session, 'plugin:action-cards/decision', decision)
  }

  /** Whether `propose_action` is declared for this agent's next step. */
  private declares(agent: Agent): boolean {
    const skills = this.loaded.get(agent)
    return skills !== undefined && [...this.kinds.values()].some(kind => skills.has(kind.skill))
  }

  private propose(
    args: { readonly action: string; readonly title: string; readonly brief: string; readonly details: ActionCardFields },
    exec: ToolRunContext,
  ): { action: string; title: string; invitation: string } {
    const agent = exec.agent
    // Step admission declares the tool only to an agent; calls dispatched from code are not logged as tool calls,
    // so no card could follow them.
    if (agent === undefined || exec.parent !== undefined) throw new ActionCardError('Call propose_action directly, not from code.', 'ACTION_CARD_NESTED')
    // Only a live root can act on a card, so a subagent's card could never be used.
    if (!this.ctx.agents.roots().includes(agent)) throw new ActionCardError('Cards are offered in the main conversation only.', 'ACTION_CARD_ROOT')
    if (this.projection.stateOf(agent.session).queued >= this.config.queuedMessageLimit) {
      throw new ActionCardError('The user has queued more messages; show no card and answer briefly.', 'ACTION_CARD_QUEUED')
    }
    const kind = this.kinds.get(args.action)
    // Admission is decided when the step starts, so the last kind can unregister before this call runs.
    if (kind === undefined) throw new ActionCardError(`Unknown action "${args.action}". Registered actions: ${[...this.kinds.keys()].join(', ') || 'none'}.`, 'ACTION_CARD_UNKNOWN')
    const turn = this.ctx.agents.turnBoundaryOf(agent.session).lastTurn
    const loads = this.turnLoads.get(agent)
    if (loads?.turn !== turn || !loads.skills.has(kind.skill)) {
      throw new ActionCardError(`Load skill ${kind.skill} first, then call propose_action.`, 'ACTION_CARD_SKILL')
    }
    if (args.title.trim() === '' || args.brief.trim() === '') throw new ActionCardError('Write a title and a brief.', 'ACTION_CARD_BLANK')
    const issues = kind.detailsIssues(args.details)
    if (issues !== undefined) throw new ActionCardError(issues, 'ACTION_CARD_DETAILS')
    if (this.accepted.get(agent)?.turn === turn || Object.values(this.view(agent.session).proposals).some(card => card.turn === turn)) {
      throw new ActionCardError('One card per turn; the earlier card stands.', 'ACTION_CARD_LIMIT')
    }
    this.accepted.set(agent, { turn, callId: exec.callId })
    return { action: args.action, title: args.title.trim(), invitation: kind.invitation }
  }

  private isStopping(): boolean {
    return isPluginStopping(this.owner, this.closing)
  }
}

export default ActionCards
