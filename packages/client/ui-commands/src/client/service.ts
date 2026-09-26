/**
 * CommandUiRuntime (`ctx.commandUi`): the '/' command source over the
 * session-keyed directory, the client-contribution registry, and the
 * per-session popupSelect controllers. Candidate synthesis merges the host
 * catalog with contributions by availability, gives built-in Host rows their
 * localized face (presentation.ts), then position-filters; an empty query
 * lists the Add and Commands sections in usage order, a typed query ranks
 * every row by the `/` menu's shared name-and-label ranking (ui-primitives
 * `rankByName`). A host/contribution name collision fails loud. Every
 * execute addresses the session's agent by sessionId — sessions are always
 * agent-backed.
 * Catalog RPCs retain an existing Client Session through completion and
 * wait for its initial history open to succeed before contacting the Host.
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge and the forwarded-event key face
// (`commands/change` rides the allowlist) into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { CommandResult } from '@deepseek-ai/dsh-commands/types'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions, SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { WeakMapWithValues } from '@deepseek-ai/dsh-util-values'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { rankByName } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  CandidateRequest, ClientSessionContext, CommandClaim, PickOutcome, InputTriggerCandidate, InputTriggerPick,
  SubmitAttachment, SubmitEnvelope, SubmitOutcome,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { CommandContribution, CommandDecoration, CommandUiContract } from './contract.ts'
import type { CommandDescriptor } from './directory.ts'
import { CommandDirectory } from './directory.ts'
import { PopupSelectController } from './popup.ts'
import { builtinRowFace, sectionRows } from './presentation.ts'
import { claimToken } from './resolution.ts'
import type { TokenSegment } from './popup.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** A command-catalog fetch waiting for initial history and its RPC result. */
    commandCatalog: unknown
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * This browser client completed one admitted Host command execution.
     * Other clients receive the durable command nodes but never this local
     * submission acknowledgment.
     * @param sessionId - Session addressed by the local submission.
     * @param name - Executed command name without the leading slash.
     * @param result - Host command result returned to this browser.
     * @mode emit
     */
    'command/executed'(sessionId: SessionId, name: string, result: CommandResult): void
  }
}

/** Recover the command name from a line the Host confirmed as executed. */
function submittedCommandName(line: string): string {
  const trimmed = line.trim()
  const separator = trimmed.search(/\s/u)
  return (separator === -1 ? trimmed : trimmed.slice(0, separator)).slice(1)
}

/** Live mutable state in one holder (service methods run behind the caller-ctx tracker). */
interface LiveState {
  readonly contributions: Map<string, CommandContribution>
  readonly decorations: Map<string, CommandDecoration>
  readonly popups: WeakMapWithValues<SessionBinding, PopupSelectController<ClientSessionContext>>
}

/** Command surface: session-keyed directory + '/' source + contribution registry + per-session popups. */
export class CommandUiRuntime extends Service implements CommandUiContract {
  static inject = ['inputTriggers', 'sessions', 'remote', 'remote.commands']

  private readonly directory: CommandDirectory
  private readonly live: LiveState = {
    contributions: new Map(),
    decorations: new Map(),
    popups: new WeakMapWithValues(),
  }
  /** `command`-namespace translator (composer refusal notices). */
  private readonly t: TranslateNS<'command'>

  /**
   * @param ctx - owning root context (plugin fiber; the service registers
   * itself as `command` and follows that fiber's lifetime).
   */
  constructor(ctx: Context) {
    super(ctx, 'commandUi')
    const locale = ctx.get('locale')
    if (locale === undefined) throw new Error('ui-commands: locale service unavailable')
    this.t = locale.bind('command')
    this.directory = new CommandDirectory(async (sessionId) => {
      const sessions = this.sessions()
      if (sessions.subagentAddress(sessionId) !== undefined) return []
      if (sessions.binding(sessionId) === undefined) {
        throw new Error(`command catalog requires a retained session "${sessionId}"`)
      }
      return sessions.using(sessionId, { source: 'commandCatalog' }, async (reference) => {
        const state = reference.binding.session.getSnapshot()
        if (state.openState !== 'open') {
          throw state.openError ?? new Error(`session "${sessionId}" is not open`)
        }
        const result = await ctx.remote.commands.list(sessionId)
        if (!result.ok) throw new Error(`command.list failed: ${result.error.code}: ${result.error.message}`)
        return result.value
      })
    })
    const inputTriggers = ctx.get('inputTriggers')
    if (inputTriggers === undefined) throw new Error('ui-commands: slash service unavailable')
    ctx.effect(() => inputTriggers.registerSource({
      trigger: '/',
      name: 'command',
      candidates: (session, req) => this.candidates(session, req),
      onPick: pick => this.dispatch(pick),
      matchSpace: (session, token) => this.matchSpace(session, token),
      matchEnter: (session, line, signal, envelope) => this.matchEnter(session, line, signal, envelope),
      warm: (session) => { this.directory.warm(session.sessionId) },
    }), 'command: slash source')
    ctx.remote.$on('commands/change', () => { this.directory.invalidateAll() })
    // A preset switch changes which commands one session's agent resolves and
    // registers nothing globally. Drop that key's old composition before
    // prewarming so a newly opened menu waits for the replacement catalog.
    ctx.remote.$on('agent-preset/selected', (sessionId) => { this.directory.resetSession(sessionId) })
    ctx.on('connection/reset', () => { this.directory.resetConnected() })
  }

  /**
   * Register one client command contribution; effect disposer (rides the
   * caller's fiber). Duplicate names throw.
   * @param contribution - the contribution (descriptor + availability + popup spec).
   * @returns the disposer removing the registration.
   */
  register(contribution: CommandContribution): () => void {
    const dispose = this.ctx.effect(() => {
      const { contributions } = this.live
      if (contributions.has(contribution.name)) {
        throw new Error(`ui-commands: duplicate contribution for /${contribution.name}`)
      }
      contributions.set(contribution.name, contribution)
      return () => { contributions.delete(contribution.name) }
    }, 'command.register()')
    return () => { void dispose() }
  }

  /**
   * Hang a bare-invocation decoration on one host command; effect disposer
   * (rides the caller's fiber). Duplicate names throw.
   * @param decoration - host command name + availability + popup spec.
   * @returns the disposer removing the registration.
   */
  decorate(decoration: CommandDecoration): () => void {
    const dispose = this.ctx.effect(() => {
      const { decorations } = this.live
      if (decorations.has(decoration.name)) {
        throw new Error(`ui-commands: duplicate decoration for /${decoration.name}`)
      }
      decorations.set(decoration.name, decoration)
      return () => { decorations.delete(decoration.name) }
    }, 'command.decorate()')
    return () => { void dispose() }
  }

  /**
   * Close every open popup for a command whose options have become stale.
   * Pending loads and confirmations lose their binding; drafts stay intact.
   * @param name - command name without the leading slash.
   */
  dismiss(name: string): void {
    for (const popup of this.live.popups.values) {
      // A catalog that went stale underneath the card takes its rows away; the
      // composer keeps the keyboard the card was holding, like every other
      // dismissal path.
      if (popup.state.getSnapshot().command === name) popup.dismiss({ focusComposer: true })
    }
  }

  /**
   * Resolve the per-session popup controller (lazy; dies with the session
   * scope). The controller's consume callback dispatches the scoped
   * consume-token event back to this session; focusComposer reaches the
   * session's composer through the conversation input face.
   * @param actx - session-scope ctx.
   * @returns the resident controller.
   * @throws when the Context no longer belongs to a retained Session generation.
   */
  popupFor(actx: ClientContext): PopupSelectController<ClientSessionContext> {
    const sessions = this.sessions()
    const session = sessions.sessionOf(actx)
    const binding = session === undefined ? undefined : sessions.binding(session.sessionId)
    if (binding === undefined || binding.session !== session) {
      throw new Error('command.popupFor requires a retained Session scope')
    }
    const { popups } = this.live
    const existing = popups.get(binding)
    if (existing !== undefined) return existing
    const controller = new PopupSelectController<ClientSessionContext>({
      consume: segment => binding.ctx.bail(binding.ctx, 'slash/input-consume-token', {
        guard: segment.via === 'menu'
          ? { kind: 'span', span: segment.span }
          : { kind: 'bare-token', token: segment.token },
      }) === true,
      // The shell took the keyboard; the composer restores it, caret included.
      focusComposer: () => { binding.ctx.get('conversation')?.input.for(binding.ctx).focus() },
    })
    popups.set(binding, controller)
    binding.ctx.effect(() => () => {
      controller.dispose()
      popups.delete(binding)
    }, 'command: session popup')
    return controller
  }

  /**
   * Menu candidates: host catalog + contribution availability, built-in rows
   * localized, then position filtering; sections for an empty query, the
   * shared name-and-label ranking for a typed one.
   */
  private async candidates(session: ClientSessionContext, req: CandidateRequest): Promise<readonly InputTriggerCandidate[]> {
    const list = await this.directory.ensureReady(session.sessionId, req.signal)
    const rows: InputTriggerCandidate[] = []
    const seen = new Set<string>()
    for (const c of list) {
      seen.add(c.name)
      rows.push({
        name: c.name,
        ...(builtinRowFace(c, this.t) ?? { description: c.description }),
        ...(c.input !== undefined ? { hint: c.input.hint } : {}),
      })
    }
    for (const contribution of this.live.contributions.values()) {
      if (!contribution.available(session)) continue
      if (seen.has(contribution.name)) {
        throw new Error(`ui-commands: contribution /${contribution.name} collides with a host command`)
      }
      rows.push({
        name: contribution.name,
        ...(contribution.label === undefined ? {} : { label: contribution.label() }),
        ...(contribution.description === undefined ? {} : { description: contribution.description() }),
        ...(contribution.icon === undefined ? {} : { icon: contribution.icon }),
      })
    }
    const visible = rows.filter(c => req.position === 'leading' || c.hint === undefined)
    return req.query === '' ? sectionRows(visible, this.t) : rankByName(visible, req.query)
  }

  /** Decision table, menu column: contribution/decorated-host → popup or action; host input → claim; host bare → detached execute. */
  private dispatch(pick: InputTriggerPick): PickOutcome {
    const name = pick.candidate.name
    const contribution = this.live.contributions.get(name)
    if (contribution !== undefined && contribution.available(pick.session)) {
      this.invoke(name, contribution.ui, pick.session, { via: 'menu', span: pick.span })
      return 'handled'
    }
    const desc = this.directory.resolve(pick.session.sessionId, name)
    if (desc === undefined) return undefined // snapshot swapped between menu and pick → miss
    // A decoration replaces the HOST row's bare invocation with its popup or
    // action; it decorates only a resolvable host command (checked above),
    // never manufactures one, and never touches the argument claim below.
    const decoration = this.live.decorations.get(name)
    if (decoration !== undefined && decoration.available(pick.session)) {
      this.invoke(name, decoration.ui, pick.session, { via: 'menu', span: pick.span })
      return 'handled'
    }
    if (desc.input !== undefined) return { claim: this.leadingClaim(desc, pick.session, claimToken(desc, this.t)) }
    // Menu-pick execute consumes the trigger span before the detached run
    // (scoped event; the input owns the CAS guard).
    this.consumeVia(pick.session.sessionId, { via: 'menu', span: pick.span })
    this.runDetached(desc, pick.session, `/${name}`)
    return 'handled'
  }

  /** Decision table, space column: hot-key sync check; only host leadingInput claims. */
  private matchSpace(session: ClientSessionContext, token: string): PickOutcome {
    if (!token.startsWith('/')) return undefined
    if (this.live.contributions.has(token.slice(1))) return undefined // popup and action kinds never claim on space
    const desc = this.directory.resolve(session.sessionId, token.slice(1))
    if (desc === undefined || desc.input === undefined) return undefined
    return { claim: this.leadingClaim(desc, session, token.slice(1)) }
  }

  /**
   * Decision table, enter column. Strong-waits the session's catalog (a
   * warmup failure rejects — never a silent downgrade). Contributions and
   * bare host commands act on the bare token only; leadingInput claims
   * args-tolerant.
   *
   * Envelope policy: an enter submission carrying attachments resolves only
   * through a command declaring attachment acceptance. Every other submitting
   * route — popup, non-accepting claim, bare detached execute — throws the
   * refusal so the machine surfaces one composer notice and the draft and
   * attachments stay in place; nothing executes and nothing is dropped. An
   * action submits nothing and runs regardless.
   *
   * A typed token is resolved through the localized claim tokens, so a line
   * written as `/计划` reaches the `plan` descriptor and executes as `/plan`.
   */
  private async matchEnter(
    session: ClientSessionContext,
    line: string,
    signal: AbortSignal,
    envelope: SubmitEnvelope,
  ): Promise<PickOutcome> {
    const trimmed = line.trim()
    if (!trimmed.startsWith('/')) return undefined
    const ws = trimmed.search(/\s/)
    const token = ws === -1 ? trimmed : trimmed.slice(0, ws)
    const bare = ws === -1
    const typedName = token.slice(1)
    if (typedName === '') return undefined
    const refuseAttachments = (): never => {
      throw new Error(this.t('notice.attachmentsUnsupported', { command: typedName }))
    }
    const contribution = this.live.contributions.get(typedName)
    if (contribution !== undefined && contribution.available(session)) {
      if (!bare) return undefined
      if (envelope.attachments > 0 && contribution.ui.kind !== 'action') refuseAttachments()
      this.invoke(typedName, contribution.ui, session, { via: 'enter', token })
      return 'handled'
    }
    await this.directory.ensureReady(session.sessionId, signal)
    const desc = this.directory.resolve(session.sessionId, typedName)
    if (desc === undefined) return undefined
    const name = desc.name
    const canonical = `/${name}${trimmed.slice(token.length)}`
    // Bare enter on a decorated host command opens its popup; an argued line
    // never consults the decoration (the claim/detached paths below own it).
    if (bare) {
      const decoration = this.live.decorations.get(name)
      if (decoration !== undefined && decoration.available(session)) {
        if (envelope.attachments > 0 && decoration.ui.kind !== 'action') refuseAttachments()
        this.invoke(name, decoration.ui, session, { via: 'enter', token })
        return 'handled'
      }
    }
    if (desc.input !== undefined) {
      if (envelope.attachments > 0 && desc.input.attachments !== true) refuseAttachments()
      return { claim: this.leadingClaim(desc, session, token.slice(1)) }
    }
    if (!bare) return undefined
    if (envelope.attachments > 0) refuseAttachments()
    this.consumeVia(session.sessionId, { via: 'enter', token })
    this.runDetached(desc, session, canonical)
    return 'handled'
  }

  /**
   * Invoke one contribution or decoration (menu pick / bare enter): open the
   * session's popup, or consume the token and run the action.
   */
  private invoke(
    name: string,
    ui: CommandContribution['ui'],
    session: ClientSessionContext,
    segment: TokenSegment,
  ): void {
    if (ui.kind === 'action') {
      this.consumeVia(session.sessionId, segment)
      ui.run(session)
      return
    }
    const actx = this.scopeFor(session.sessionId)
    if (actx === undefined) return
    this.popupFor(actx).open(name, ui, session, segment)
  }

  /**
   * Build the leadingInput claim. The composer keeps the claimed token in
   * the draft and reads the arguments after it, so the token is the spelling
   * the draft will carry: the locale's token for a menu pick, the typed
   * spelling for Space and Enter. The command.execute submit transaction
   * always sends the catalog name.
   */
  private leadingClaim(desc: CommandDescriptor, session: ClientSessionContext, shown: string): CommandClaim {
    const token = `/${shown} `
    const line = `/${desc.name} `
    return {
      name: desc.name,
      token,
      ...(desc.input !== undefined ? { hint: desc.input.hint } : {}),
      ...(desc.input?.attachments === true ? { attachments: true } : {}),
      submit: (args, _actx, attachments) => this.execute(session, line + args, attachments),
    }
  }

  /**
   * The command.execute transaction, addressed to the session's agent — pure
   * admission semantics. An unmatched line reports an error outcome (the
   * composer's immediate admission feedback); an admitted command reports
   * plain success regardless of its handler outcome, because the host
   * executor durably logged the lifecycle (`command/run`/`command/done`) and
   * the outcome renders as a persistent flow node — the composer never
   * echoes it. A handler error result reports an error outcome so the
   * composer keeps the draft and attachments for correction.
   * A refused call throws.
   */
  private async execute(
    session: ClientSessionContext,
    line: string,
    attachments: readonly SubmitAttachment[] = [],
  ): Promise<SubmitOutcome> {
    const result = await this.ctx.remote.commands.execute(session.sessionId, line, attachments)
    if (!result.ok) throw new Error(`command.execute failed: ${result.error.code}: ${result.error.message}`)
    if (result.value === undefined) return { kind: 'error', text: `unknown or malformed command: ${line}` }
    this.notifyExecuted(session.sessionId, submittedCommandName(line), result.value.result)
    // A submission consumes its attachments only after handler success; an
    // error outcome keeps the draft and attachments in the composer.
    if (attachments.length > 0 && result.value.result.kind === 'error') {
      return { kind: 'error', text: result.value.result.text }
    }
    return { kind: 'success' }
  }

  /** Publish the local acknowledgment without letting an observer change command admission. */
  private notifyExecuted(sessionId: SessionId, name: string, result: CommandResult): void {
    const args = ['command/executed', sessionId, name, result]
    for (const listener of this.ctx.events.dispatch('emit', args) as Array<(...listenerArgs: unknown[]) => unknown>) {
      try {
        const returned = listener(sessionId, name, result)
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(returned as PromiseLike<unknown>).then(undefined, (error: unknown) => {
            this.warnExecutedListenerFailure(name, error)
          })
        }
      } catch (error) {
        this.warnExecutedListenerFailure(name, error)
      }
    }
  }

  /** Log one contained `command/executed` observer failure. */
  private warnExecutedListenerFailure(name: string, error: unknown): void {
    this.ctx.logger.warn('client command: a command/executed listener for "%s" failed', name)
    this.ctx.logger.warn(error)
  }

  /**
   * Fire-and-forget execute for the internal ('handled') paths. Outcomes are
   * NOT surfaced here: the host executor durably logs the command lifecycle
   * (`command/run`/`command/done`), and the mux-broadcast events render as a
   * persistent flow node on every tab. Only an admission failure — which never
   * entered a handler and therefore never logged — falls back to the composer
   * notice as immediate feedback.
   */
  private runDetached(desc: CommandDescriptor, session: ClientSessionContext, line: string): void {
    void this.execute(session, line).then(
      (outcome) => {
        // matched:false maps to an error outcome with no logged lifecycle.
        if (outcome.kind === 'error') this.noticeFor(session.sessionId, 'error', outcome.text ?? `/${desc.name} failed`)
      },
      (error: unknown) => {
        this.noticeFor(session.sessionId, 'error', error instanceof Error ? error.message : String(error))
      },
    )
  }

  /** Dispatch a consume-token event to one session (menu-pick / bare-enter execute paths). */
  private consumeVia(id: SessionId, segment: TokenSegment): void {
    const actx = this.scopeFor(id)
    if (actx === undefined) return
    actx.bail(actx, 'slash/input-consume-token', {
      guard: segment.via === 'menu'
        ? { kind: 'span', span: segment.span }
        : { kind: 'bare-token', token: segment.token },
    })
  }

  /** Route an admission failure to the session's composer notice channel (scope gone = attempt died with it). */
  private noticeFor(id: SessionId, level: 'info' | 'error', text: string): void {
    const actx = this.scopeFor(id)
    if (actx === undefined) return
    const conversation = actx.get('conversation')
    if (conversation === undefined) return
    conversation.input.for(actx).notify(level, text)
  }

  /** id → actx interchange (registered exchange point: this service coordinates for projection-only sources). */
  private scopeFor(id: SessionId): ClientContext | undefined {
    return this.sessions().scope(id)
  }

  private sessions(): ISessions {
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) throw new Error('ui-commands: sessions service unavailable')
    return sessions
  }
}
