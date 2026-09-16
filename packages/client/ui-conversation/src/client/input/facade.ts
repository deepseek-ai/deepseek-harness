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
  CommandClaim, ConsumeTokenRequest, DraftAttachmentId,
  InputActions, InputEffect, InputNotice, InputState, InputTriggerController, PickOutcome,
  SessionInput, SubmitAttempt, SubmitAttachment, SubmitOutcome,
} from '../contract/input.ts'
import type {
  ArbitrateKey, ArbitrateOutcome, ComposerKeyboard, Occurrence, ReferenceInsert, TokenSpan,
} from '../contract/draft-editor.ts'
import type { InputSubmitMode } from '../contract/composer-submission.ts'
import { SubmitMachine } from './machine.ts'
import { DraftEditorRuntime } from './editor/runtime.ts'
import type { EditorProjection } from './editor/projection.ts'

/** Popup face the shell needs (dismissal only; typed structurally to avoid a value import). */
export interface PopupDismissFace {
  dismiss(): void
}

/**
 * Construction dependencies of one facade. The slash/popup faces are THUNKS: the
 * shell is created inside the sessions provide materialization (before the
 * scope record is queryable), where `slash.sessionOf`/`command.popupFor`
 * cannot resolve yet — resolution defers to first interactive use.
 */
export interface SessionInputDeps {
  /** Session-scope ctx handed to claim.submit transactions. */
  actx: Context
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
  /** The plain-message sink (send choreography / materialize fork — the hub owns it). */
  defaultSink(
    text: string,
    attachmentIds: readonly DraftAttachmentId[],
    mode: InputSubmitMode,
    signal: AbortSignal,
  ): Promise<SubmitOutcome>
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
    default: return 'frozen' // adjudicating / submitting
  }
}

/** Whether two projections differ in content (selection and caret excluded). */
function projectionContentChanged(prev: EditorProjection, next: EditorProjection): boolean {
  if (prev.clipboardText !== next.clipboardText || prev.detectText !== next.detectText) return true
  if (prev.occurrences.length !== next.occurrences.length) return true
  return next.occurrences.some((occ, i) => {
    const old = prev.occurrences[i]
    return old === undefined || old.occurrenceId !== occ.occurrenceId || old.invalid !== occ.invalid
  })
}

const EMPTY_QUEUE: InboxState['next-turn'] = []

/** No-pipeline lexicon: zero text-ref decorations. */
const EMPTY_LEXICON: ReadonlyMap<'/' | '@', readonly string[]> = new Map()

/** Editor and attachment snapshot owned by one detached default send. */
interface DetachedDraft {
  readonly draft: string
  readonly occurrences: readonly Occurrence[]
  readonly attachmentIds: readonly DraftAttachmentId[]
}

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
    setDraft: (text) => { this.setDraft(text) },
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
  private lastMirroredDraft = ''
  private attachmentIds: readonly DraftAttachmentId[] = []
  private disposed = false
  /** Draft persistence mirror (Conversation store write; receives the clipboard projection). */
  private mirrorFn: ((text: string) => void) | undefined
  /** The mounted composer's file-picker opener (scoped pick-files event target). */
  private filePicker: Parameters<ComposerKeyboard['bindFilePicker']>[0] | undefined
  /** Default sends retained until admission settles or scope disposal releases their attachments. */
  private readonly detachedDrafts = new Map<number, DetachedDraft>()
  /** Failed default sends waiting to be restored together in submission order. */
  private readonly failedDetached = new Map<number, DetachedDraft>()
  /** Revision of the last automatic failure restoration. */
  private failedRestoreRev: number | undefined
  private restoringFailures = false
  private attachmentFlightSeq = 0
  /** Attachment-only sends retained until admission settles or scope disposal releases their attachments. */
  private readonly attachmentFlights = new Map<number, {
    readonly controller: AbortController
    readonly attachmentIds: readonly DraftAttachmentId[]
  }>()

  private readonly unsubscribeInbox: (() => void) | undefined

  constructor(private readonly deps: SessionInputDeps) {
    this.draftEditor = new DraftEditorRuntime({
      onUpdate: () => { this.onEditorUpdate() },
      openReference: (source, reference) =>
        this.deps.inputTriggers?.()?.openReference(source, reference) ?? false,
      activeClaimToken: () => this.activeClaimToken(),
      lexicon: () => this.lexicon.getSnapshot(),
      resolveLexicon: () => this.deps.inputTriggers?.()?.lexicon,
    })
    this.unregister = this.draftEditor.register()
    this.state = createSnapshotStore<InputState>(this.compose())
    this.unsubscribeInbox = deps.inbox?.subscribe(() => { this.publish() })
  }

  // ---- editor plumbing ----

  /** Re-project, run the claim watch, publish, and feed trigger tracking after every editor commit. */
  private onEditorUpdate(): void {
    const prev = this.draftEditor.refreshProjection()
    // Selection-only commits advance neither the revision nor the published
    // state: menus still track the caret below, while draftRev moves only
    // with content so a snapshot-built span (apply.ts) stays CAS-valid across
    // caret motion and subscribers do not re-render per caret move.
    if (projectionContentChanged(prev, this.projection)) {
      this.rev += 1
      if (!this.restoringFailures && this.failedRestoreRev !== undefined) {
        this.failedDetached.clear()
        this.failedRestoreRev = undefined
      }
      this.dispatchRun(({ type: 'draft-changed', draft: this.projection.clipboardText }))
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
   * @param text - the full next draft.
   */
  setDraft(text: string): void {
    this.draftEditor.setDraft(text)
  }

  /** Append ordered attachment ids unless an admission transaction is locked. */
  addAttachments(ids: readonly DraftAttachmentId[]): boolean {
    if (this.snapshot.phase === 'adjudicating' || this.snapshot.phase === 'submitting') return false
    if (ids.length === 0) return true
    this.attachmentIds = [...this.attachmentIds, ...ids]
    this.publish()
    return true
  }

  /**
   * Remove one attachment id from this draft. Busy admission phases refuse, like
   * {@link addAttachments}: a removal landing while a command submit serializes
   * would otherwise vanish from the rail yet still ride the in-flight send.
   */
  removeAttachment(id: DraftAttachmentId): boolean {
    if (this.snapshot.phase === 'adjudicating' || this.snapshot.phase === 'submitting') return false
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
   * Clear the draft as a successful-send commit: the editor empties (no undo
   * unit) and the undo history is cut, so Ctrl/Cmd-Z cannot resurrect sent
   * content (the command path gets the same discipline from submit-settled).
   * @param attachmentIds - admitted attachment ids to remove from this draft.
   */
  commitSend(attachmentIds: readonly DraftAttachmentId[]): void {
    const submitted = new Set(attachmentIds)
    this.attachmentIds = this.attachmentIds.filter(id => !submitted.has(id))
    this.dispatchRun(({ type: 'send-committed' }))
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
   * Enter adjudication + submit transaction + default sink. Effects fan out
   * from the machine; this method only feeds the event. Lock entry
   * (adjudicating/submitting) force-closes the transient layers: the popup
   * dismisses and the menu tracks frozen.
   */
  submit(mode: InputSubmitMode = 'queue'): void {
    if (this.snapshot.draft.trim() === '' && this.attachmentIds.length > 0) {
      if (this.snapshot.phase === 'plain') {
        const attachmentIds = [...this.attachmentIds]
        const controller = new AbortController()
        this.attachmentFlightSeq += 1
        const flight = this.attachmentFlightSeq
        this.attachmentFlights.set(flight, { controller, attachmentIds })
        this.commitSend(attachmentIds)
        void this.deps.defaultSink('', attachmentIds, mode, controller.signal).then((outcome) => {
          if (this.disposed || !this.attachmentFlights.delete(flight)) return
          if (outcome.kind === 'success') return
          this.restoreAttachments(attachmentIds)
          if (outcome.text !== undefined) this.notify('error', outcome.text)
        }, (error: unknown) => {
          if (this.disposed || !this.attachmentFlights.delete(flight)) return
          this.restoreAttachments(attachmentIds)
          this.notify('error', error instanceof Error ? error.message : String(error))
        })
      }
      return
    }
    // Claimed pre-gate: a claim that does not declare attachment acceptance never
    // submits while attachments are present — one notice, everything retained.
    // Enter-time adjudication applies the same policy for unclaimed lines
    // inside the command source itself.
    const before = this.snapshot
    if (before.phase === 'claimed' && this.attachmentIds.length > 0 && before.claim?.attachments !== true) {
      this.notify('error', this.deps.commandAttachments.unsupportedNotice(before.claim?.token ?? before.draft))
      return
    }
    this.dispatchRun(({ type: 'enter', mode, draft: this.projection.clipboardText }))
    const phase = this.snapshot.phase
    if (phase === 'adjudicating' || phase === 'submitting') {
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
   * editor replaces [0, span.end) with the claim token, then the machine
   * enters claimed.
   * @param claim - the command claim from the pick path.
   * @param span - pick-time span snapshot (detect coordinates).
   * @returns whether the edit applied (phase, span CAS, and leading guard passed).
   */
  beginCommand(claim: CommandClaim, span: TokenSpan): boolean {
    const phase = this.core.state.phase
    if (phase !== 'plain' && phase !== 'claimed') return false
    if (span.draftRev !== this.rev) return false
    // Leading-trigger contract: only whitespace may precede the span; the
    // whitespace prefix is dropped so the claimed watch (startsWith) holds.
    if (this.projection.detectText.slice(0, span.start).trim() !== '') return false
    const applied = this.draftEditor.replaceText({ start: 0, end: span.end }, claim.token)
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

  // ---- wiring-layer extras (not on the frozen SessionInput face) ----

  /**
   * Teardown the shell and return every browser-owned attachment still retained by
   * the draft or an unsettled default send.
   * @returns attachment ids the scope disposer must release.
   */
  dispose(): readonly DraftAttachmentId[] {
    if (this.disposed) return []
    const retained = new Set(this.attachmentIds)
    for (const record of this.detachedDrafts.values()) {
      for (const attachmentId of record.attachmentIds) retained.add(attachmentId)
    }
    for (const flight of this.attachmentFlights.values()) {
      for (const attachmentId of flight.attachmentIds) retained.add(attachmentId)
      flight.controller.abort()
    }
    this.disposed = true
    this.dispatchRun(({ type: 'release' }))
    this.unsubscribeInbox?.()
    this.unregister()
    this.detachedDrafts.clear()
    this.failedDetached.clear()
    this.attachmentFlights.clear()
    return [...retained]
  }

  /** Read the live input state (guard derivation reads here). */
  get snapshot(): InputState {
    return this.state.getSnapshot()
  }

  /**
   * Bind the draft persistence mirror (Conversation store write). Adopt-on-bind: the
   * store draft may hold a persisted value from a previous mount; the caller
   * seeds it via setDraft BEFORE binding, and afterwards every editor-adopted
   * draft mirrors out.
   * @param write - store draft write.
   * @returns the unbind disposer.
   */
  bindMirror(write: (text: string) => void): () => void {
    this.mirrorFn = write
    return () => {
      if (this.mirrorFn === write) this.mirrorFn = undefined
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

  /** The claim token the decoration transform styles; null while unclaimed. */
  private activeClaimToken(): string | null {
    const core = this.core.state
    return (core.phase === 'claimed' || core.phase === 'submitting') && core.claim !== undefined
      ? core.claim.token
      : null
  }

  /** Dispatch + execute, refreshing the claim decoration when the styled token flips. */
  private dispatchRun(ev: Parameters<SubmitMachine['dispatch']>[0]): void {
    const beforeToken = this.activeClaimToken()
    this.run(this.core.dispatch(ev))
    if (this.activeClaimToken() !== beforeToken) this.draftEditor.refreshClaimDecoration()
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
   * Prompt serialization before the sink: expand each chip occurrence to its
   * owner's model form via the session controller's codec routing. Owner
   * missing or serialization failure rejects the detached send and restores
   * its editor snapshot. Chip-free drafts skip the async detour.
   */
  private sinkSerialized(
    attempt: SubmitAttempt,
    draft: string,
    mode: InputSubmitMode,
  ): void {
    const attachmentIds = [...this.attachmentIds]
    this.attachmentIds = []
    const occurrences = this.projection.occurrences
    const record = { draft, occurrences, attachmentIds }
    this.detachedDrafts.set(attempt.seq, record)
    if (this.failedRestoreRev === this.rev) {
      this.failedDetached.clear()
      this.failedRestoreRev = undefined
    }
    if (occurrences.length === 0) {
      this.settleSink(attempt, this.deps.defaultSink(draft.trim(), attachmentIds, mode, attempt.signal))
      return
    }
    const inputTriggers = this.deps.inputTriggers?.()
    void Promise.all(occurrences.map(async (o) => {
      if (inputTriggers === undefined) throw new Error(`no serializer for reference source "${o.source}"`)
      return {
        offset: o.offset,
        length: o.length,
        text: await inputTriggers.serializeReference(o.source, o.ref, attempt.signal),
      }
    })).then(
      (parts) => {
        if (this.disposed) return
        // Splice model forms over their clipboard ranges (offsets are
        // clipboard-projection; parts arrive offset-sorted since chips walk in
        // document order).
        let out = ''
        let cursor = 0
        for (const part of parts) {
          out += draft.slice(cursor, part.offset) + part.text
          cursor = part.offset + part.length
        }
        out += draft.slice(cursor)
        this.settleSink(attempt, this.deps.defaultSink(out.trim(), attachmentIds, mode, attempt.signal))
      },
      (error: unknown) => {
        if (this.dead(attempt)) return
        const message = error instanceof Error ? error.message : String(error)
        this.settleDetachedFailure(attempt, message)
      },
    )
  }

  /** Settle one detached default send independently of other sends. */
  private settleSink(
    attempt: SubmitAttempt,
    pending: Promise<SubmitOutcome>,
  ): void {
    pending.then(
      (outcome) => {
        if (this.dead(attempt)) return
        if (outcome.kind !== 'success') {
          this.settleDetachedFailure(attempt, outcome.text)
          return
        }
        this.detachedDrafts.delete(attempt.seq)
        this.dispatchRun(({ type: 'sink-settled', attempt, ok: true, outcome }))
      },
      (error: unknown) => {
        if (this.dead(attempt)) return
        this.settleDetachedFailure(attempt, error instanceof Error ? error.message : String(error))
      },
    )
  }

  /** Restore one failed detached send without overwriting text entered after a restoration. */
  private settleDetachedFailure(attempt: SubmitAttempt, message?: string): void {
    const record = this.detachedDrafts.get(attempt.seq)
    if (record === undefined) return
    this.detachedDrafts.delete(attempt.seq)
    this.restoreAttachments(record.attachmentIds)
    this.failedDetached.set(attempt.seq, record)
    if (this.projection.clipboardText === '' || this.failedRestoreRev === this.rev) {
      this.restoreFailedDrafts()
    }
    this.dispatchRun(({ type: 'sink-settled', attempt, ok: false, ...(message === undefined ? {} : { message }) }))
  }

  /** Rebuild all currently failed snapshots in submission order. */
  private restoreFailedDrafts(): void {
    const records = [...this.failedDetached.entries()].sort(([a], [b]) => a - b).map(([, record]) => record)
    if (records.length === 0) return
    const separator = '\n\n'
    let draft = ''
    const occurrences: Occurrence[] = []
    for (const record of records) {
      const base = draft.length + (draft === '' ? 0 : separator.length)
      if (draft !== '') draft += separator
      draft += record.draft
      for (const occurrence of record.occurrences) {
        occurrences.push({ ...occurrence, offset: base + occurrence.offset })
      }
    }
    this.restoringFailures = true
    try {
      this.draftEditor.restoreDraft(draft, occurrences)
      this.draftEditor.clearHistory()
      this.failedRestoreRev = this.rev
    } finally {
      this.restoringFailures = false
    }
  }

  /** Return failed-send attachments to the head of the rail; release happens only after success. */
  private restoreAttachments(attachmentIds: readonly DraftAttachmentId[]): void {
    if (attachmentIds.length === 0) return
    const current = new Set(this.attachmentIds)
    const restored = attachmentIds.filter(id => !current.has(id))
    if (restored.length === 0) return
    this.attachmentIds = [...restored, ...this.attachmentIds]
    this.publish()
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
    const attachmentIds = claim.attachments === true ? [...this.attachmentIds] : []
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
            draft: this.projection.clipboardText, outcome,
            ...(outcome.kind === 'error' && outcome.text === undefined ? { message: 'command failed' } : {}),
          }))
        },
        (error: unknown) => {
          if (this.dead(attempt)) return
          const message = error instanceof Error ? error.message : String(error)
          this.dispatchRun(({
            type: 'submit-settled', attempt, ok: false,
            draft: this.projection.clipboardText, message,
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
    if (next.draft !== this.lastMirroredDraft) {
      this.lastMirroredDraft = next.draft
      this.mirrorFn?.(next.draft)
    }
  }
}
