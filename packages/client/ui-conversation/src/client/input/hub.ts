/**
 * Session-bound input registry and default-send routing for Conversation.
 * Each retained Session binding owns one shell, its input listeners, and its
 * catalog subscription. Saved drafts enter the model before the first lookup
 * returns; Session-scope disposal releases the shell and its resources.
 */
import type {} from '@deepseek-ai/dsh-client-product-analytics/client'
import type { PlanProjection } from '@deepseek-ai/dsh-plan-mode/types'
import type { GoalProjection } from '@deepseek-ai/dsh-goal/types'
import type { Context } from '@deepseek-ai/cordis'
import type {
  ISessions, SessionBinding, SessionFace,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { InboxState } from '@deepseek-ai/dsh-agent/types'
import type { ModelSelectionProjection } from '@deepseek-ai/dsh-agent/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {
  DraftAttachmentId, DraftAttachmentSerializationResult, DraftInitializationOptions, DraftInitializationResult, InputTriggerController,
  SessionInputResolver, SessionInput, SubmitOutcome,
} from '../contract/input.ts'
import type { ComposerKeyboard } from '../contract/draft-editor.ts'
import type { ComposerBlocks } from '../contract/composer-blocks.ts'
import type { InputSubmitMode } from '../contract/composer-submission.ts'
import type { PopupDismissFace } from './facade.ts'
import { SessionInputShell } from './facade.ts'
import { reportMessageSubmission } from './submission-analytics.ts'
import { readConversationDraft } from '../stores.ts'

/** Structural command face for per-session popup resolution. */
interface CommandFace {
  popupFor(actx: Context): PopupDismissFace
}

/** Optional input-trigger service resolved without importing its implementation. */
interface InputTriggerServiceFace {
  /** @param actx - Session scope. @returns that Session's trigger provider. */
  sessionOf(actx: Context): InputTriggerController
}

/** Attachment-send face resolved lazily to keep hub/service construction acyclic. */
interface ConversationAttachmentFace {
  readonly blocks: ComposerBlocks
  sendSession(
    session: SessionFace,
    text: string,
    attachmentIds: readonly DraftAttachmentId[],
    mode: InputSubmitMode,
    signal?: AbortSignal,
    accept?: () => void,
  ): Promise<SubmitOutcome>
  serializeDraftAttachments(attachmentIds: readonly DraftAttachmentId[]): Promise<DraftAttachmentSerializationResult>
  releaseDraftAttachment(id: DraftAttachmentId): void
  draftAttachmentIds(sessionId: SessionId): readonly DraftAttachmentId[]
  draftAttachmentSessions(): readonly SessionId[]
  releaseDraftSession(sessionId: SessionId): void
}

/** Per-Session marker that a page unload discarded the draft's browser-owned attachments. */
const UNLOAD_MARK_PREFIX = 'dsh.composer-draft-attachments-unloaded'

/** Record that an unloading page held draft attachments for these Sessions. */
function writeUnloadMarks(sessionIds: readonly SessionId[]): void {
  try {
    for (const sessionId of sessionIds) localStorage.setItem(`${UNLOAD_MARK_PREFIX}.${sessionId}`, '1')
  } catch (error) {
    console.error('conversation draft attachment unload marks could not be saved; a reload cannot report the loss', error)
  }
}

/** Remove one Session's unload marker. @returns whether the marker was present. */
function takeUnloadMark(sessionId: SessionId): boolean {
  try {
    const key = `${UNLOAD_MARK_PREFIX}.${sessionId}`
    const marked = localStorage.getItem(key) !== null
    localStorage.removeItem(key)
    return marked
  } catch (error) {
    console.error('conversation draft attachment unload mark could not be read', error)
    return false
  }
}

/** Session-addressed input facade registry (SessionInputResolver face + composer-layer extras). */
export class InputHub implements SessionInputResolver {
  private readonly shells = new WeakMap<SessionBinding, SessionInputShell>()
  private knownSessionIds: Set<SessionId> | undefined
  private lifecycleWatchInstalled = false

  /**
   * @param ctx - client root context (services resolved lazily per call — boot order stays free).
   * @param t - conversation-namespace translate thunk (reads the active locale at call time).
   */
  constructor(
    private readonly rootCtx: Context,
    private readonly t: TranslateNS<'conversation'>,
  ) {}

  /**
   * Resolve the facade for one session-scope ctx (SessionInputResolver face).
   * @param actx - session-scope context.
   * @returns the resident per-session facade.
   */
  for(actx: Context): SessionInput {
    const sessions = this.sessions()
    const session = sessions.sessionOf(actx)
    const binding = session === undefined ? undefined : sessions.binding(session.sessionId)
    if (binding === undefined || binding.session !== session) {
      throw new Error('conversation.input.for requires a retained Session scope')
    }
    return this.shellFor(binding)
  }

  requestDraftInitialization(binding: SessionBinding, options: DraftInitializationOptions): DraftInitializationResult {
    if (this.sessions().binding(binding.sessionId) !== binding) {
      throw new Error('conversation.input.requestDraftInitialization requires a retained Session binding')
    }
    return this.shellFor(binding).requestDraftInitialization(options)
  }

  /**
   * Resolve the resident shell for an already-retained, addressable Session binding.
   * Draft import completes before return. The Session scope owns input listeners,
   * the inject-managed catalog subscription, and shell teardown.
   * @param binding - session assembly handle.
   * @returns the shell.
   */
  shellFor(binding: SessionBinding): SessionInputShell {
    const existing = this.shells.get(binding)
    if (existing !== undefined) return existing
    const { session, ctx: actx } = binding
    const shell = new SessionInputShell({
      actx,
      submissionState: () => {
        const state = session.getSnapshot()
        const model = session.projections.faceOf('modelSelection').getSnapshot() as ModelSelectionProjection | undefined
        const plan = session.projections.faceOf('plan').getSnapshot() as PlanProjection | undefined
        const goal = session.projections.faceOf('goal').getSnapshot() as GoalProjection | null | undefined
        const agentPreset = session.projections.faceOf('agentPreset').getSnapshot()
        const selection = model?.next ?? model?.lastUsed
        return Object.freeze({
          ...state.blank ? {} : { sessionId: state.sessionId },
          ...selection == null ? {} : { model: Object.freeze({
            provider: selection.provider, name: selection.model,
            ...selection.reasoningEffort === undefined ? {} : { effort: selection.reasoningEffort },
          }) },
          runMode: plan?.active ? 'plan' : goal?.goal.phase === 'active' ? 'goal' : 'default',
          running: state.running,
          newSession: state.blank,
          ...typeof agentPreset === 'string' ? { agentPreset } : {},
        })
      },
      messageSubmitted: (submission) => { reportMessageSubmission(this.rootCtx, submission) },
      inputTriggers: () => this.controller(actx),
      popup: () => this.popup(actx),
      inbox: session.projections.faceOf('inbox') as ObservableSnapshot<InboxState | undefined>,
      defaultSink: (text, attachmentIds, mode, signal, accept) => this.sink(session, text, attachmentIds, mode, signal, accept),
      quoteRemoveLabel: () => this.t('quote.remove'),
      quoteInsertionAllowed: () => {
        const state = session.getSnapshot()
        return !state.removed && (state.subagent === null
          || state.subagent.address.mode === 'continuable')
          && this.conversation().blocks.storeFor(session.sessionId).getSnapshot() === undefined
      },
      steerQueue: () => { void this.steerQueue(session, shell) },
      commandAttachments: {
        serialize: async (ids) => {
          const result = await this.conversation().serializeDraftAttachments(ids)
          return result.attachments
        },
        // Asymmetric with serialize on purpose: release settles AFTER the
        // submit RPC, where session teardown may already have unloaded the
        // conversation service (the same tolerance as the scope disposer
        // above); leaked preview URLs then die with the document.
        release: (ids) => {
          const conversation = this.rootCtx.get('conversation') as ConversationAttachmentFace | undefined
          for (const attachmentId of ids) conversation?.releaseDraftAttachment(attachmentId)
        },
        unsupportedNotice: token => this.t('command.attachmentsUnsupported', {
          command: token.trim().replace(/^\//u, ''),
        }),
      },
    })
    this.shells.set(binding, shell)
    // The one teardown axis: listeners, shell, and map entries all ride the
    // scope fiber (nothing here outlives the scope).
    actx.effect(() => {
      const offs = [
        actx.on('slash/input-begin-command', req =>
          shell.beginCommand(req.claim, req.span) ? true : undefined),
        actx.on('slash/input-insert-reference', req =>
          shell.insertReference(req.reference, req.span) ? true : undefined),
        actx.on('slash/input-consume-token', req =>
          shell.consumeToken(req.guard) ? true : undefined),
        actx.on('slash/input-insert-text', req =>
          shell.insertText(req.text, req.span, req.continue === true) ? true : undefined),
      ]
      return () => {
        for (const off of offs) off()
        // Snapshot the phase before dispose resets the machine.
        const phaseAtTeardown = shell.snapshot.phase
        const drafts = shell.dispose()
        this.shells.delete(binding)
        const conversation = this.rootCtx.get('conversation') as ConversationAttachmentFace | undefined
        if (conversation === undefined) return
        if (binding.session.getSnapshot().removed) {
          conversation.releaseDraftSession(binding.sessionId)
          return
        }
        // Teardown aborts adjudication before any message leaves, so those attachments stay with the draft.
        // A message or command already submitted cannot settle through its retirement path after teardown,
        // and the Client cannot tell whether a submitted command consumed its attachments, so both release
        // here rather than risk a duplicate submission; every other draft attachment stays registered for
        // the Session's next composer.
        if (phaseAtTeardown === 'sending' || phaseAtTeardown === 'submitting') {
          for (const attachmentId of drafts) conversation.releaseDraftAttachment(attachmentId)
        }
      }
    }, 'conversation.input: session shell')
    actx.inject(['inputTriggers'], (scope) => {
      scope.effect(() => {
        shell.refreshLexiconSubscription()
        return () => { shell.refreshLexiconSubscription() }
      }, 'conversation.input: reference catalogs')
    })
    shell.setDraft(readConversationDraft(binding.sessionId))
    this.ensureLifecycleWatch()
    const conversation = this.rootCtx.get('conversation') as ConversationAttachmentFace | undefined
    const retained = conversation?.draftAttachmentIds(binding.sessionId) ?? []
    // A Session switch keeps the draft's attachments registered; this composer re-adopts them.
    if (retained.length > 0) shell.addAttachments(retained)
    // A reload discarded the browser-owned attachments; say so instead of dropping them silently.
    if (takeUnloadMark(binding.sessionId) && retained.length === 0) shell.notify('error', this.t('attachments.unavailable'))
    return shell
  }

  /**
   * Install the root-lifetime watchers once: a Session removed while no composer
   * is mounted releases its draft attachments, and an unloading page marks the
   * Sessions whose attachments it discards.
   */
  private ensureLifecycleWatch(): void {
    if (this.lifecycleWatchInstalled) return
    this.lifecycleWatchInstalled = true
    const sessions = this.sessions()
    this.knownSessionIds = new Set(sessions.list.getSnapshot().ids)
    this.rootCtx.effect(() => {
      const stop = sessions.list.subscribe(() => { this.cleanupRemovedSessions() })
      const conversation = (): ConversationAttachmentFace | undefined =>
        this.rootCtx.get('conversation') as ConversationAttachmentFace | undefined
      const onHide = (): void => { writeUnloadMarks(conversation()?.draftAttachmentSessions() ?? []) }
      // A back-forward cache restore keeps the registry, so the marks just written are stale.
      const onShow = (event: PageTransitionEvent): void => {
        if (!event.persisted) return
        for (const sessionId of conversation()?.draftAttachmentSessions() ?? []) takeUnloadMark(sessionId)
      }
      window.addEventListener('pagehide', onHide)
      window.addEventListener('pageshow', onShow)
      return () => {
        stop()
        window.removeEventListener('pagehide', onHide)
        window.removeEventListener('pageshow', onShow)
        this.knownSessionIds = undefined
        this.lifecycleWatchInstalled = false
      }
    }, 'conversation.input: draft attachment lifecycle')
  }

  /** Release draft attachments and unload marks for every Session removed from the catalog. */
  private cleanupRemovedSessions(): void {
    const known = this.knownSessionIds
    /* v8 ignore next -- the catalog subscription is stopped before the known set is cleared. */
    if (known === undefined) return
    const liveIds = new Set(this.sessions().list.getSnapshot().ids)
    const conversation = this.rootCtx.get('conversation') as ConversationAttachmentFace | undefined
    for (const id of [...known]) {
      if (liveIds.has(id)) continue
      known.delete(id)
      conversation?.releaseDraftSession(id)
      takeUnloadMark(id)
    }
    for (const id of liveIds) known.add(id)
  }

  /**
   * Resident shell by session id (service-face path; the provide channel has
   * normally created it already — this covers direct id-addressed access).
   * @param id - session id.
   * @returns the shell.
   */
  shell(id: SessionId): SessionInputShell {
    const binding = this.sessions().binding(id)
    if (binding === undefined) throw new Error(`conversation.input: session "${id}" resolved no binding`)
    return this.shellFor(binding)
  }

  /**
   * The InputBar-exclusive keyboard command face: the shell
   * satisfies it structurally; package-internal — handed through the
   * composer-bar entry's inject, never across a plugin boundary.
   * @param id - session id.
   * @returns the shell as the keyboard face.
   */
  keyboard(id: SessionId): ComposerKeyboard {
    return this.shell(id)
  }

  /**
   * Submit empty input to retry a failed generation through the ordinary composer. Stale
   * failures, active work, and drafts keep their current input unchanged.
   * @param id - retained ordinary Session identity.
   * @param failureSeq - failed turn/end sequence the displayed button addresses.
   */
  retry(id: SessionId, failureSeq: SessionSeq): void {
    const binding = this.sessions().binding(id)
    if (binding === undefined
      || binding.session.projections.faceOf('conversationContinuation').getSnapshot() !== failureSeq) return
    const session = binding.session.getSnapshot()
    const shell = this.shellFor(binding)
    const input = shell.snapshot
    const inbox = binding.session.projections.faceOf('inbox').getSnapshot() as InboxState | undefined
    if (session.running || session.removed || session.openState !== 'open' || session.subagent !== null
      || session.pendingSubmissions.length > 0 || input.phase !== 'plain'
      || input.draft.trim() !== '' || input.attachmentIds.length > 0
      || (inbox?.['next-turn'].length ?? 0) > 0
      || inbox?.['next-step'].some(message => message.source.kind === 'user')
      || this.conversation().blocks.storeFor(id).getSnapshot() !== undefined) return
    shell.submit('queue', 'click', true)
  }

  /**
   * Query file intake without creating a Session input.
   * @param id - target Session.
   * @returns whether its mounted composer currently accepts files.
   */
  canPickFiles(id: SessionId): boolean {
    const binding = this.sessions().binding(id)
    return binding !== undefined && this.shells.get(binding)?.canPickFiles() === true
  }

  /**
   * Open the target composer's file dialog under its live intake policy.
   * @param id - target Session.
   */
  pickFiles(id: SessionId): void {
    const binding = this.sessions().binding(id)
    if (binding !== undefined) this.shells.get(binding)?.pickFiles()
  }

  /**
   * Resolve the optional slash controller for composer chrome that launches
   * the shared candidate menu without typing a trigger.
   * @param id - session id.
   * @returns the resident controller, or undefined when no trigger provider is installed.
   */
  inputTriggers(id: SessionId): InputTriggerController | undefined {
    const binding = this.sessions().binding(id)
    return binding === undefined ? undefined : this.controller(binding.ctx)
  }

  /**
   * Default sink: prompt while the composer holds the sent draft. The session
   * is always a real host entity (materialized when its workspace was picked),
   * so there is exactly one path; a refused or failed prompt is an ordinary
   * prompt failure (banner via promptError, draft kept in the composer).
   */
  private sink(
    session: SessionFace,
    text: string,
    attachmentIds: readonly DraftAttachmentId[],
    mode: InputSubmitMode,
    signal: AbortSignal,
    accept: () => void,
  ): Promise<SubmitOutcome> {
    if (text === '' && attachmentIds.length === 0) {
      return session.prompt([], mode, signal).then(result => result.ok ? { kind: 'success' } : { kind: 'error' })
    }
    return this.conversation().sendSession(session, text, attachmentIds, mode, signal, accept)
  }

  /**
   * Submit every still-pending queued message through QueueDock Steer, in FIFO
   * request order — the same operation as the queue dock's per-row button.
   * An Agent stopping before a command (`session/steer-unavailable`) or a row already
   * claimed by the agent (`session/queue-item-not-found`) converges silently, while a
   * genuine failure surfaces as one composer notice. Repeated triggers
   * (e.g. two rapid empty-draft chords) rely on that `session/queue-item-not-found`
   * convergence: the snapshot may still list a row the host already steered,
   * and the duplicate Steer is a silent no-op.
   * @param session - the addressed host session.
   * @param shell - the resident shell (notice outlet).
   */
  private async steerQueue(session: SessionFace, shell: SessionInputShell): Promise<void> {
    const inbox = session.projections.faceOf('inbox').getSnapshot() as InboxState | undefined
    const queued = inbox?.['next-turn'] ?? []
    if (queued.length === 0) return
    for (const item of queued) {
      const result = await session.updateQueue(item.id, { kind: 'steer' })
      if (result.ok) continue
      if (result.error.code === 'session/steer-unavailable' || result.error.code === 'session/queue-item-not-found') return
      shell.notify('error', this.t('queue.steerFailed'))
      return
    }
  }

  private controller(actx: Context): InputTriggerController | undefined {
    if (this.sessions().sessionOf(actx) === undefined) return undefined
    const inputTriggers = this.rootCtx.get('inputTriggers') as InputTriggerServiceFace | undefined
    return inputTriggers?.sessionOf(actx)
  }

  private popup(actx: Context): PopupDismissFace | undefined {
    if (this.sessions().sessionOf(actx) === undefined) return undefined
    const command = this.rootCtx.get('commandUi') as CommandFace | undefined
    return command?.popupFor(actx)
  }

  private sessions(): ISessions {
    const sessions = this.rootCtx.get('sessions')
    if (sessions === undefined) throw new Error('conversation.input: sessions service unavailable')
    return sessions
  }

  private conversation(): ConversationAttachmentFace {
    const conversation = this.rootCtx.get('conversation') as ConversationAttachmentFace | undefined
    if (conversation === undefined) throw new Error('conversation.input: conversation service unavailable')
    return conversation
  }
}
