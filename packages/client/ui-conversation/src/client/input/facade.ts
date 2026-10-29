/**
 * SessionInput shell: owns the per-session Lexical editor (text + chip
 * truth) and the pure SubmitMachine (phase/claim/attempt), and choreographs
 * everything between them — projections and InputState publication, the
 * scoped-event application verbs, the submit transaction plumbing
 * (adjudicate via the session's InputTriggerController; claim.submit; default
 * sink), the notice channel, and the draft persistence mirror.
 * Package-private; the hub alone constructs it and wires the scoped event
 * listeners onto it.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { InboxState } from '@deepseek-ai/dsh-agent/types'
import {
  createSnapshotStore, type ObservableSnapshot, type SnapshotStore,
} from '@deepseek-ai/dsh-client-store'
import type { LexicalEditor } from 'lexical'
import type {
  CommandClaim, ConsumeTokenRequest, DraftAttachmentId, DraftInitializationOptions, DraftInitializationResult,
  InputActions, InputEffect, InputNotice, InputState, InputTriggerController, PickOutcome,
  SessionInput, SubmitAttempt, SubmitAttachment, SubmitOutcome,
} from '../contract/input.ts'
import type {
  ArbitrateKey, ArbitrateOutcome, ComposerKeyboard, DraftInput, DraftSnapshot, ReferenceInsert, TokenSpan,
} from '../contract/draft-editor.ts'
import type { InputSubmitMode, MessageSubmission, MessageSubmissionState } from '../contract/composer-submission.ts'
import { serializeDraftPrompt } from './prompt.ts'
import { SubmitMachine } from './machine.ts'
import { resolveDraftInput, snapshotDraft } from '../draft.ts'
import { DraftEditorRuntime } from './editor/runtime.ts'
import type { EditorProjection } from './editor/projection.ts'

/** Popup face the shell needs (dismissal only; typed structurally to avoid a value import). */
export interface PopupDismissFace {
  dismiss(): void
}

/**
 * Construction dependencies of one input model. Trigger and popup callbacks
 * resolve the currently available Session-scoped services on demand. InputHub
 * owns the lexicon subscription through the Session scope's inject lifecycle.
 */
export interface SessionInputDeps {
  /** Session-scope ctx handed to claim.submit transactions. */
  actx: Context
  /** Snapshot the Session facts before asynchronous command arbitration. */
  submissionState?: () => MessageSubmissionState
  /** Notify one ordinary message attempt before reference serialization. */
  messageSubmitted?: (submission: MessageSubmission) => void
  /** Enter adjudication face resolver; absent/undefined answer = every '/' line falls to the default sink. */
  inputTriggers?: (() => InputTriggerController | undefined) | undefined
  /** PopupSelect shell face resolver (dismissal on submit lock / escape). */
  popup?: (() => PopupDismissFace | undefined) | undefined
  /** Agent Inbox projection; its next-turn list is overlaid onto InputState.queue. */
  inbox?: ObservableSnapshot<InboxState | undefined> | undefined
  /**
   * Steer every still-pending queued message into the running turn, in FIFO
   * order (the empty-draft accelerated-Enter gesture); absent = unsupported.
   */
  steerQueue?: (() => void) | undefined
  /**
   * The plain-message sink (send choreography / materialize fork — the hub owns it).
   * `accept` settles the message as accepted at once; the sink calls it when
   * the Host's acceptance is known before the returned outcome, so the editor
   * shrinks before the message's echo renders.
   */
  defaultSink(
    text: string,
    attachmentIds: readonly DraftAttachmentId[],
    mode: InputSubmitMode,
    signal: AbortSignal,
    accept: () => void,
  ): Promise<SubmitOutcome>
  /** Live Session and composer-block policy for transcript insertion. */
  quoteInsertionAllowed?: () => boolean
  /** Current localized quote removal copy. */
  quoteRemoveLabel?: () => string
  /** Command-plane attachment plumbing (the hub owns the conversation face and the copy). */
  commandAttachments: {
    /** Resolve ordered draft ids to wire payloads without sending them; rejects when an id no longer resolves. */
    serialize(ids: readonly DraftAttachmentId[]): Promise<readonly SubmitAttachment[]>
    /** Free consumed draft attachments after a successful command submit. */
    release(ids: readonly DraftAttachmentId[]): void
    /** Localized composer notice for a claimed command that does not accept attachments. */
    unsupportedNotice(token: string): string
  }
}

/** Guard tier from the machine phase. */
function guardOf(phase: InputState['phase']): 'plain' | 'claimed' | 'frozen' {
  switch (phase) {
    case 'plain': return 'plain'
    case 'claimed': return 'claimed'
    default: return 'frozen' // adjudicating / submitting / sending
  }
}

/** Whether an attempt owns the draft: the editor and attachments are read-only until it settles. */
function frozen(phase: InputState['phase']): boolean {
  return phase === 'adjudicating' || phase === 'submitting' || phase === 'sending'
}

/** Whether two projections differ in content (selection and caret excluded). */
function projectionContentChanged(prev: EditorProjection, next: EditorProjection): boolean {
  if (prev.clipboardText !== next.clipboardText || prev.detectText !== next.detectText) return true
  if (prev.command !== next.command) return true
  if (prev.quotes.length !== next.quotes.length || prev.quotes.some((quote, i) => {
    const old = next.quotes[i]
    return old?.text !== quote.text || old.offset !== quote.offset
  })) return true
  if (prev.occurrences.length !== next.occurrences.length) return true
  return next.occurrences.some((occ, i) => {
    const old = prev.occurrences[i]
    return old === undefined || old.occurrenceId !== occ.occurrenceId || old.invalid !== occ.invalid
  })
}

/** Message of a failure surfaced as a composer notice. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const EMPTY_QUEUE: InboxState['next-turn'] = []

/** Unavailable catalogs contain no named text references. */
const EMPTY_LEXICON: ReadonlyMap<'/' | '@', readonly string[]> = new Map()

/**
 * The per-session input facade: scoped-event application verbs +
 * setDraft/submit + the published InputState store, over a shell-owned
 * Lexical editor.
 */
export class SessionInputShell implements SessionInput {
  /** Published editor projection + submit-plane state + queue overlay (the InputZone currency source). */
  readonly state: SnapshotStore<InputState>
  /** Latest surfaced notice (null after clear); the bar renders errors as banners and information inline. */
  readonly notices: SnapshotStore<InputNotice | null> = createSnapshotStore<InputNotice | null>(null)
  /** The shell-owned editor (text + chip truth); the composer binds its contenteditable to it. */
  get editor(): LexicalEditor {
    return this.draftEditor.editor
  }
  /** The public provide-channel action face (one stable identity per session). */
  readonly actions: InputActions = {
    insertQuote: text => this.insertQuote(text),
    captureInsertion: () => ({ ...this.caretSpan(), draftRev: this.rev }),
    insertText: (text, span) => {
      if (frozen(this.snapshot.phase) || this.disposed) return false
      if (span.draftRev !== this.rev) return false
      return this.draftEditor.insertAsyncText(span, text)
    },
    setDraft: (text) => { this.setDraft(text) },
    persistDraft: () => { this.persistCurrentDraft() },
    addAttachments: ids => this.addAttachments(ids),
    removeAttachment: (id) => { this.removeAttachment(id) },
    pruneAttachments: (ids) => { this.pruneAttachments(ids) },
    submit: () => { this.submit('queue') },
  }

  private readonly core = new SubmitMachine()
  private readonly draftEditor: DraftEditorRuntime
  private get projection(): EditorProjection {
    return this.draftEditor.projection
  }
  private rev = 0
  private readonly unregister: () => void
  private noticeSeq = 0
  private lastPublishedDraft: DraftSnapshot | undefined
  private draftSnapshotCache: { revision: number; value: DraftSnapshot } | undefined
  private attachmentIds: readonly DraftAttachmentId[] = []
  private disposed = false
  /** Conversation store writer for the current semantic document. */
  private persistDraft: ((draft: DraftSnapshot) => void) | undefined
  /** A restored draft's command token waiting for the trigger pipeline, with the revision its restore produced. */
  private pendingCommand: { readonly token: string; readonly rev: number } | undefined
  /** The in-flight claim resolution for a restored command chip. */
  private commandRestore: AbortController | undefined
  /** The mounted composer's file-picker opener (scoped pick-files event target). */
  private filePicker: Parameters<ComposerKeyboard['bindFilePicker']>[0] | undefined
  private readonly unsubscribeInbox: (() => void) | undefined

  constructor(private readonly deps: SessionInputDeps) {
    this.draftEditor = new DraftEditorRuntime({
      onUpdate: () => { this.onEditorUpdate() },
      quoteLabels: () => ({ remove: this.deps.quoteRemoveLabel?.() ?? '' }),
      openReference: (source, reference) =>
        this.deps.inputTriggers?.()?.openReference(source, reference) ?? false,
      lexicon: () => this.lexicon.getSnapshot(),
      resolveLexicon: () => this.deps.inputTriggers?.()?.lexicon,
    })
    this.unregister = this.draftEditor.register()
    this.state = createSnapshotStore<InputState>(this.compose())
    this.unsubscribeInbox = deps.inbox?.subscribe(() => { this.publish() })
  }

  // ---- editor plumbing ----

  /** Re-project, sync the claim with the leading command chip, publish, and feed trigger tracking after every editor commit. */
  private onEditorUpdate(): void {
    const prev = this.draftEditor.refreshProjection()
    // Selection-only commits advance neither the revision nor the published
    // state: menus still track the caret below, while draftRev moves only
    // with content so a snapshot-built span (apply.ts) stays CAS-valid across
    // caret motion and subscribers do not re-render per caret move.
    if (projectionContentChanged(prev, this.projection)) {
      this.rev += 1
      this.dispatchRun(({ type: 'draft-changed', command: this.projection.command }))
    }
    const caret = this.projection.caret
    if (caret !== null) {
      this.deps.inputTriggers?.()?.track(
        this.projection.detectText, caret, { tier: guardOf(this.core.state.phase) }, this.rev,
      )
    }
  }

  // ---- SessionInput face ----

  /**
   * Replace the whole draft (persisted-draft seed and programmatic writes).
   * Placeholder-sanitized; newlines split paragraphs; the caret lands at the
   * end. Merged into history so a seed is not an undoable step of its own.
   * @param text - plain text or the complete semantic document.
   */
  setDraft(text: DraftInput): void {
    const draft = resolveDraftInput(text)
    this.cancelCommandRestore()
    if (draft.references.length === 0 && (draft.quotes?.length ?? 0) === 0) this.draftEditor.setDraft(draft.text)
    else this.draftEditor.restoreDraft(draft.text, draft.references, draft.quotes, { remove: this.deps.quoteRemoveLabel?.() ?? '' })
    if (draft.command === undefined) return
    this.pendingCommand = { token: draft.command.token, rev: this.rev }
    this.restoreCommand()
  }

  /** @param text - selected transcript text. @returns whether the editable draft accepted the quote. */
  insertQuote(text: string): boolean {
    if (this.disposed || this.snapshot.phase !== 'plain' || this.deps.quoteInsertionAllowed?.() === false || text.trim() === '') return false
    const inserted = this.draftEditor.insertQuote(text.replace(/\r\n?/gu, '\n'), { remove: this.deps.quoteRemoveLabel?.() ?? '' })
    if (inserted) this.focus()
    return inserted
  }

  /**
   * Reconnect optional catalog notifications and resume a pending command
   * chip restore without waiting for another edit.
   */
  refreshLexiconSubscription(): void {
    if (this.disposed) return
    this.draftEditor.refreshLexiconSubscription()
    this.restoreCommand()
  }

  /**
   * Rebuild the command chip a restored draft carried once the trigger
   * pipeline can resolve its claim. The rebuild applies only at the revision
   * the restore produced: an edit made while the claim resolves keeps the
   * literal token, which Enter still adjudicates as the command.
   */
  private restoreCommand(): void {
    const pending = this.pendingCommand
    const inputTriggers = this.deps.inputTriggers?.()
    if (pending === undefined || inputTriggers === undefined || this.disposed) return
    this.pendingCommand = undefined
    const restore = new AbortController()
    this.commandRestore = restore
    const spelling = pending.token.trimEnd()
    inputTriggers.resolveClaim(spelling, restore.signal).then((claim) => {
      if (restore.signal.aborted) return
      this.commandRestore = undefined
      if (claim !== undefined) this.applyClaim(claim, { start: 0, end: spelling.length, draftRev: pending.rev }, true)
    }, (_error: unknown) => {
      // A catalog warmup failure or an abort leaves the literal token, which Enter still adjudicates.
      if (this.commandRestore === restore) this.commandRestore = undefined
    })
  }

  /** Drop a pending or in-flight command chip restore. */
  private cancelCommandRestore(): void {
    this.pendingCommand = undefined
    this.commandRestore?.abort()
    this.commandRestore = undefined
  }

  /** Current semantic document, stable until its content revision changes. */
  get draftSnapshot(): DraftSnapshot {
    if (this.draftSnapshotCache?.revision === this.rev) return this.draftSnapshotCache.value
    const value = snapshotDraft(
      this.projection.clipboardText, this.projection.occurrences, this.projection.command?.token, this.projection.quotes,
    )
    this.draftSnapshotCache = { revision: this.rev, value }
    return value
  }

  /** Persist the latest document without changing the editor or binding a writer. */
  persistCurrentDraft(): void {
    this.persistDraft?.(this.draftSnapshot)
  }

  /**
   * Apply one new-task request to this already-initialized input model.
   * @param options - content to adopt and the handling of an existing draft.
   * @returns applied when the requested text is adopted, even if unchanged;
   * preserved when the current draft is kept; blocked after disposal or during a pending submission.
   */
  requestDraftInitialization(options: DraftInitializationOptions): DraftInitializationResult {
    if (this.draftInitializationBlocked()) return 'blocked'
    const whenDraftExists = options.whenDraftExists ?? (options.clearPreviousDraft === true ? 'replace' : 'keep')
    if (whenDraftExists === 'replace') {
      this.setDraft(options.prompt ?? '')
      return 'applied'
    }
    if (options.prompt === undefined) return 'preserved'
    if (this.snapshot.draft === '' && this.attachmentIds.length === 0) {
      this.setDraft(options.prompt)
      return 'applied'
    }
    if (whenDraftExists === 'keep') return 'preserved'
    this.draftEditor.appendDraft(options.prompt)
    return 'applied'
  }

  private draftInitializationBlocked(): boolean {
    return this.disposed || frozen(this.core.state.phase)
  }

  /** Append ordered attachment ids unless an admission transaction is locked. */
  addAttachments(ids: readonly DraftAttachmentId[]): boolean {
    if (frozen(this.snapshot.phase)) return false
    if (ids.length === 0) return true
    this.attachmentIds = [...this.attachmentIds, ...ids]
    this.publish()
    return true
  }

  /**
   * Add validated file references and attachment ids while admission is editable.
   * @param references - reference chips in source order.
   * @param ids - newly allocated attachment ids.
   * @returns false when admission is locked or the editor refuses the insertion.
   */
  addFiles(references: readonly ReferenceInsert[], ids: readonly DraftAttachmentId[]): boolean {
    if (frozen(this.snapshot.phase)) return false
    if (!this.draftEditor.insertFileReferences(references)) return false
    this.attachmentIds = [...this.attachmentIds, ...ids]
    this.publish()
    return true
  }

  /**
   * Remove one attachment id from this draft. Busy admission phases refuse, like
   * {@link addAttachments}: a removal landing while a send serializes would
   * otherwise vanish from the rail yet still ride the in-flight send.
   */
  removeAttachment(id: DraftAttachmentId): boolean {
    if (frozen(this.snapshot.phase)) return false
    const next = this.attachmentIds.filter(candidate => candidate !== id)
    if (next.length === this.attachmentIds.length) return false
    this.attachmentIds = next
    this.publish()
    return true
  }

  /**
   * Keep only ids that still resolve in the browser attachment registry.
   * @param available - live registry ids.
   */
  pruneAttachments(available: readonly DraftAttachmentId[]): void {
    const keep = new Set(available)
    const next = this.attachmentIds.filter(id => keep.has(id))
    if (next.length === this.attachmentIds.length) return
    this.attachmentIds = next
    this.publish()
  }

  /**
   * Insert pasted plain text over the current editor selection
   * (placeholder-sanitized). The paste event's own default is suppressed by
   * the caller; PASTE_TAG makes the paste its own history boundary, so one
   * undo never removes both the paste and typing inside the merge window.
   * @param text - pasted plain text.
   */
  paste(text: string): void {
    this.draftEditor.paste(text)
  }

  /**
   * Enter adjudication + submit transaction + default sink with the draft, its
   * reference chips, and its attachments as the user sent them. Effects fan
   * out from the machine; this method only feeds the event. Lock entry
   * (adjudicating/submitting/sending) force-closes the transient layers: the
   * popup dismisses and the menu tracks frozen.
   */
  submit(mode: InputSubmitMode = 'queue', source?: 'click' | 'enter'): void {
    if (this.disposed) return
    const timestamp = Date.now()
    let state: MessageSubmissionState | undefined
    if (this.snapshot.phase === 'plain' && (this.snapshot.draft.trim() !== '' || this.attachmentIds.length > 0)) {
      try { state = this.deps.submissionState?.() } catch (_error) { /* Optional Session observations cannot interrupt submission. */ }
    }
    const submission: MessageSubmission = Object.freeze({
      timestamp, mode, ...source === undefined ? {} : { source }, ...state === undefined ? {} : { state },
    })
    // Claimed pre-gate: a claim that does not declare attachment acceptance never
    // submits while attachments are present — one notice, everything retained.
    // Enter-time adjudication applies the same policy for unclaimed lines
    // inside the command source itself.
    const before = this.snapshot
    if (before.phase === 'claimed' && this.attachmentIds.length > 0 && before.claim?.attachments !== true) {
      this.notify('error', this.deps.commandAttachments.unsupportedNotice(before.claim?.token ?? before.draft))
      return
    }
    this.dispatchRun({
      type: 'enter',
      mode,
      draft: this.projection.clipboardText,
      occurrences: [...this.projection.occurrences],
      quotes: [...this.projection.quotes],
      attachmentIds: [...this.attachmentIds],
      submission,
    })
    if (frozen(this.snapshot.phase)) {
      this.deps.popup?.()?.dismiss()
      this.deps.inputTriggers?.()?.track(this.projection.detectText, 0, { tier: 'frozen' }, this.rev)
    }
  }

  /**
   * Keyboard arbitration while the menu is open.
   * @param key - the intercepted key.
   * @param composing - IME composition guard state.
   * @returns the menu's verdict; 'pass' when no pipeline is mounted.
   */
  arbitrate(key: ArbitrateKey, composing: boolean): ArbitrateOutcome {
    return this.deps.inputTriggers?.()?.arbitrate(key, composing) ?? 'pass'
  }

  /**
   * Steer every still-pending queued message into the running turn (the
   * empty-draft accelerated-Enter gesture). Execution belongs to the hub's
   * queue choreography; absent dep = the gesture falls back to the machine's
   * empty-draft no-op.
   */
  steerQueue(): void {
    this.deps.steerQueue?.()
  }

  /**
   * Space adjudication over the controller's hot state.
   * @returns true = a claim/insert was applied — the caller preventDefaults.
   */
  space(): boolean {
    const inputTriggers = this.deps.inputTriggers?.()
    if (inputTriggers === undefined) return false
    return inputTriggers.onSpace()
    // No re-track here: applying the claim/insert mutates the editor, and the
    // update listener re-tracks at the settled caret on its own.
  }

  /** Dismiss the popupSelect shell (any interaction outside the box). */
  dismissPopup(): void {
    this.deps.popup?.()?.dismiss()
  }

  /**
   * The live selection as a detect-coordinate span (menu-launcher synthetic
   * hits replace it on pick); an absent selection answers a collapsed span at
   * the document end.
   * @returns the ordered [start, end) span in detect coordinates.
   */
  caretSpan(): { start: number; end: number } {
    return this.draftEditor.caretSpan()
  }

  /**
   * Hot plain-text reference lexicon source for the decoration scan:
   * delegates to the controller's aggregated store. Stable
   * identity per shell; without a pipeline the snapshot is the empty Map and
   * subscribers never fire.
   */
  readonly lexicon: ObservableSnapshot<ReadonlyMap<'/' | '@', readonly string[]>> = {
    getSnapshot: () => this.deps.inputTriggers?.()?.lexicon.getSnapshot() ?? EMPTY_LEXICON,
    subscribe: fn => this.deps.inputTriggers?.()?.lexicon.subscribe(fn) ?? (() => {}),
  }

  // ---- scoped-event application verbs ----

  /**
   * Apply one command claim (scoped begin-command event listener body): the
   * editor replaces [0, span.end) with the command chip and its separator,
   * then the machine enters claimed.
   * @param claim - the command claim from the pick path.
   * @param span - pick-time span snapshot (detect coordinates).
   * @returns whether the edit applied (phase, span CAS, and leading guard passed).
   */
  beginCommand(claim: CommandClaim, span: TokenSpan): boolean {
    return this.applyClaim(claim, span, false)
  }

  /**
   * Replace [0, span.end) with the command chip and enter claimed.
   * @param mergeHistory - merge the edit into the previous history entry.
   * @returns whether the edit applied.
   */
  private applyClaim(claim: CommandClaim, span: TokenSpan, mergeHistory: boolean): boolean {
    const phase = this.core.state.phase
    if (phase !== 'plain' && phase !== 'claimed') return false
    if (span.draftRev !== this.rev) return false
    // Leading-trigger contract: only whitespace may precede the span; the
    // whitespace prefix is dropped so the chip takes the leading seat.
    if (this.projection.detectText.slice(0, span.start).trim() !== '') return false
    const tail = this.projection.detectText.slice(span.end, span.end + 1)
    const applied = this.draftEditor.insertCommand({ start: 0, end: span.end }, claim, tail, mergeHistory)
    if (!applied) return false
    this.dispatchRun(({ type: 'claim', claim }))
    return true
  }

  /**
   * Apply one reference insertion (scoped insert-reference event listener
   * body): the editor replaces the span with one chip node, followed by a
   * separating space unless one is already next.
   * @param ref - the reference insertion from the pick path.
   * @param span - pick-time span snapshot (detect coordinates).
   * @returns whether the edit applied.
   */
  insertReference(ref: ReferenceInsert, span: TokenSpan): boolean {
    const phase = this.core.state.phase
    if (phase !== 'plain' && phase !== 'claimed') return false
    if (span.draftRev !== this.rev) return false
    const tail = this.projection.detectText.slice(span.end, span.end + 1)
    return this.draftEditor.insertReference(span, ref, tail)
  }

  /**
   * Consume one command token after business success (scoped consume-token
   * event listener body). Span guard: revision CAS then splice; bare-token
   * guard: trimmed-draft equality then clear.
   * @param guard - exact span or bare-token guard.
   * @returns whether the token was consumed.
   */
  consumeToken(guard: ConsumeTokenRequest['guard']): boolean {
    if (guard.kind === 'span') {
      if (guard.span.draftRev !== this.rev || guard.span.start === guard.span.end) return false
      return this.draftEditor.replaceText(guard.span, '')
    }
    if (guard.token === '' || this.projection.clipboardText.trim() !== guard.token) return false
    this.setDraft('')
    return true
  }

  /**
   * Insert plain reference text over the pick-time span (scoped insert-text
   * event listener body; the plain-text reference path). The editor gains
   * ordinary characters — no chip node; the chip look is a scan-derived
   * decoration, never state.
   * @param text - the plain reference text to splice in (e.g. `/name `).
   * @param span - pick-time span snapshot (detect coordinates).
   * @param keepCompleting - contract passenger; completion re-opening is
   * automatic here (the update listener re-tracks at the settled caret, so an
   * open token — a directory pick's trailing slash — reopens the menu without
   * an explicit re-track).
   * @returns whether the text was applied.
   */
  insertText(text: string, span: TokenSpan, keepCompleting = false): boolean {
    void keepCompleting
    if (span.draftRev !== this.rev) return false
    return this.draftEditor.replaceText(span, text)
  }

  /**
   * Surface a notice from outside the machine (detached command results).
   * @param level - severity tier.
   * @param text - notice body.
   */
  notify(level: 'info' | 'error', text: string): void {
    this.noticeSeq += 1
    this.notices.set({ level, text, seq: this.noticeSeq })
  }

  /**
   * Return the keyboard to the composer with the caret it last held. Lexical's
   * own focus restores its stored selection; a bare DOM focus on the
   * contenteditable would land the caret at the start instead.
   */
  focus(): void {
    this.editor.getRootElement()?.focus({ preventScroll: true })
    this.editor.focus()
  }

  // ---- wiring-layer extras (not on the frozen SessionInput face) ----

  /**
   * Teardown the shell, abort the in-flight attempt, and return every
   * browser-owned attachment the draft still holds, including those of a
   * message the Host has not accepted yet.
   * @returns attachment ids the scope disposer must release.
   */
  dispose(): readonly DraftAttachmentId[] {
    if (this.disposed) return []
    const retained = [...this.attachmentIds]
    this.disposed = true
    this.cancelCommandRestore()
    this.dispatchRun(({ type: 'release' }))
    this.unsubscribeInbox?.()
    this.unregister()
    return retained
  }

  /** Read the live input state (guard derivation reads here). */
  get snapshot(): InputState {
    return this.state.getSnapshot()
  }

  /**
   * Bind the Conversation store writer without importing or saving content.
   * @param write - semantic draft writer; persistCurrentDraft flushes the initial value.
   * @returns the unbind disposer.
   */
  bindDraftPersistence(write: (draft: DraftSnapshot) => void): () => void {
    this.persistDraft = write
    return () => {
      if (this.persistDraft === write) this.persistDraft = undefined
    }
  }

  /**
   * Bind the mounted composer's file action and live intake availability.
   * @param picker - availability query and native file-dialog opener.
   * @returns the unbind disposer.
   */
  bindFilePicker(picker: Parameters<ComposerKeyboard['bindFilePicker']>[0]): () => void {
    this.filePicker = picker
    return () => {
      if (this.filePicker === picker) this.filePicker = undefined
    }
  }

  /**
   * Read the mounted composer's live file-intake availability.
   * @returns false when no accepting composer is mounted.
   */
  canPickFiles(): boolean {
    return this.filePicker?.available() === true
  }

  /**
   * Open the native file dialog when the mounted composer accepts files.
   * @returns whether the opener was called.
   */
  pickFiles(): boolean {
    if (this.filePicker === undefined || !this.filePicker.available()) return false
    this.filePicker.open()
    return true
  }

  // ---- effect executor ----

  /** Dispatch one machine event and execute its effects. */
  private dispatchRun(ev: Parameters<SubmitMachine['dispatch']>[0]): void {
    this.run(this.core.dispatch(ev))
  }

  private run(effects: readonly InputEffect[]): void {
    for (const fx of effects) this.execute(fx)
    this.publish()
  }

  private execute(fx: InputEffect): void {
    switch (fx.type) {
      case 'notice': {
        this.noticeSeq += 1
        this.notices.set({ level: fx.level, text: fx.text, seq: this.noticeSeq })
        return
      }
      case 'adjudicate': {
        this.adjudicate(fx.attempt, fx.draft)
        return
      }
      case 'begin-submit': {
        this.beginSubmit(fx.attempt, fx.claim, fx.args)
        return
      }
      case 'default-sink': {
        this.sinkSerialized(fx.attempt, fx.draft, fx.mode)
        return
      }
      case 'commit-draft': {
        this.commitDraft(fx.retainSuffixOf)
        return
      }
    }
  }

  /**
   * Execute the commit-draft effect: clear the committed content (retaining
   * a pure typed-during-flight suffix when the snapshot allows) and cut the
   * undo history so sent content cannot resurrect.
   */
  private commitDraft(retainSuffixOf: string | null): void {
    this.draftEditor.clearCommittedDraft((clip) => {
      if (retainSuffixOf !== null && clip !== retainSuffixOf && clip.startsWith(retainSuffixOf)) {
        return retainSuffixOf.length
      }
      return null
    })
    this.draftEditor.clearHistory()
  }

  /**
   * Prompt serialization before the sink: expand each chip occurrence of the
   * sent draft to its owner's model form via the session controller's codec
   * routing and format each quote as Markdown, then send it with the
   * attachments captured at Enter. Owner missing or serialization failure
   * settles the send as failed, which keeps the draft. Chip-free drafts skip
   * the async detour.
   */
  private sinkSerialized(
    attempt: SubmitAttempt,
    draft: string,
    mode: InputSubmitMode,
  ): void {
    this.notifySubmission(attempt.submission)
    const { occurrences, quotes, attachmentIds } = attempt
    const inputTriggers = this.deps.inputTriggers?.()
    const prompt = serializeDraftPrompt(snapshotDraft(draft, occurrences, undefined, quotes), async (source, ref) => {
      if (inputTriggers === undefined) throw new Error(`no serializer for reference source "${source}"`)
      return inputTriggers.serializeReference(source, ref, attempt.signal)
    })
    const send = (text: string): void => {
      if (this.dead(attempt)) return
      this.settleSink(attempt, this.deps.defaultSink(text, attachmentIds, mode, attempt.signal, () => { this.acceptSink(attempt) }))
    }
    if (!(prompt instanceof Promise)) { send(prompt); return }
    void prompt.then(send, (error: unknown) => { this.failSink(attempt, error) })
  }

  private notifySubmission(submission: MessageSubmission | undefined): void {
    if (submission === undefined) return
    try { this.deps.messageSubmitted?.(submission) } catch (_error) { /* Notification consumers cannot interrupt submission. */ }
  }

  /**
   * Settle the message being sent. Once the Host accepts it, its attachments
   * leave the draft before the editor clears; ConversationController releases
   * them when the message's echo retires. Any other outcome keeps the draft
   * and its attachments for correction.
   */
  private settleSink(
    attempt: SubmitAttempt,
    pending: Promise<SubmitOutcome>,
  ): void {
    pending.then(
      (outcome) => { if (!this.dead(attempt)) this.applySinkOutcome(attempt, outcome) },
      (error: unknown) => { this.failSink(attempt, error) },
    )
  }

  /** Settle the message being sent as accepted when the sink learns the Host's acceptance before its outcome. */
  private acceptSink(attempt: SubmitAttempt): void {
    if (this.dead(attempt) || this.core.sendingAttempt !== attempt) return
    this.applySinkOutcome(attempt, { kind: 'success' })
  }

  private applySinkOutcome(attempt: SubmitAttempt, outcome: SubmitOutcome): void {
    const accepted = outcome.kind === 'success'
    if (accepted && attempt.attachmentIds.length > 0) {
      const sent = new Set(attempt.attachmentIds)
      this.attachmentIds = this.attachmentIds.filter(id => !sent.has(id))
    }
    this.dispatchRun(({ type: 'sink-settled', attempt, ok: accepted, outcome }))
  }

  /** Settle a send that ended without a Host outcome; the draft stays for correction. */
  private failSink(attempt: SubmitAttempt, error: unknown): void {
    if (this.dead(attempt)) return
    this.dispatchRun(({ type: 'sink-settled', attempt, ok: false, message: errorText(error) }))
  }

  /** Enter adjudication: poll the session controller; failure = notice + draft retained (never a silent downgrade). */
  private adjudicate(attempt: SubmitAttempt, draft: string): void {
    const inputTriggers = this.deps.inputTriggers?.()
    if (inputTriggers === undefined) {
      // No pipeline mounted: the '/' line is an ordinary message.
      this.dispatchRun(({ type: 'adjudicated', attempt, outcome: undefined }))
      return
    }
    inputTriggers.adjudicate(draft.trim(), attempt.signal, { attachments: this.attachmentIds.length }).then(
      (outcome: PickOutcome) => {
        if (this.dead(attempt)) return
        this.dispatchRun(({ type: 'adjudicated', attempt, outcome }))
      },
      (error: unknown) => {
        if (this.dead(attempt)) return
        const message = error instanceof Error ? error.message : String(error)
        this.dispatchRun(({ type: 'adjudication-failed', attempt, message }))
      },
    )
  }

  /**
   * The submit transaction: claim.submit against the session scope; ok maps
   * from the outcome kind. An accepting claim receives the serialized draft
   * attachments, which are cleared and released only on a success outcome; a
   * failure (serialize, transport, or handler error) keeps draft and attachments
   * for correction.
   */
  private beginSubmit(attempt: SubmitAttempt, claim: CommandClaim, args: string): void {
    const attachmentIds = claim.attachments === true ? attempt.attachmentIds : []
    Promise.resolve()
      .then(async () => {
        const attachments = attachmentIds.length > 0 ? await this.deps.commandAttachments.serialize(attachmentIds) : []
        // Serialization may outlive the attempt (large files, session
        // teardown); a dead attempt must not reach the Host executor.
        if (this.dead(attempt)) return undefined
        return claim.submit(args, this.deps.actx, attachments)
      })
      .then(
        (outcome) => {
          if (outcome === undefined || this.dead(attempt)) return
          if (outcome.kind === 'success' && attachmentIds.length > 0) {
            const submitted = new Set(attachmentIds)
            this.attachmentIds = this.attachmentIds.filter(id => !submitted.has(id))
            this.deps.commandAttachments.release(attachmentIds)
          }
          this.dispatchRun(({
            type: 'submit-settled', attempt, ok: outcome.kind === 'success',
            command: this.projection.command, outcome,
            ...(outcome.kind === 'error' && outcome.text === undefined ? { message: 'command failed' } : {}),
          }))
        },
        (error: unknown) => {
          if (this.dead(attempt)) return
          const message = error instanceof Error ? error.message : String(error)
          this.dispatchRun(({
            type: 'submit-settled', attempt, ok: false,
            command: this.projection.command, message,
          }))
        },
      )
  }

  /** Late-settlement guard: superseded attempts and disposed facades drop silently. */
  private dead(attempt: SubmitAttempt): boolean {
    return this.disposed || attempt.signal.aborted
  }

  private compose(): InputState {
    const core = this.core.state
    return {
      draft: this.projection.clipboardText,
      attachmentIds: this.attachmentIds,
      draftRev: this.rev,
      phase: core.phase,
      ...(core.claim !== undefined ? { claim: core.claim } : {}),
      occurrences: this.projection.occurrences,
      queue: this.deps.inbox?.getSnapshot()?.['next-turn'] ?? EMPTY_QUEUE,
    }
  }

  private publish(): void {
    const next = this.compose()
    this.state.set(next)
    const draft = this.draftSnapshot
    if (draft !== this.lastPublishedDraft) {
      this.lastPublishedDraft = draft
      this.persistDraft?.(draft)
    }
  }
}
