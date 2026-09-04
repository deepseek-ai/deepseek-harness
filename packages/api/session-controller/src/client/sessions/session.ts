// Sessions remain resident after creation so their open Remote sources keep running off-screen.

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { AttachmentIdType, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { SessionLogOffset, SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionEventStream } from '../transport.ts'
import type { SessionJournalChange } from '../transport.ts'
import type {
  PromptContentPart,
  QueueAction,
  SessionAddress,
  SessionAssistantStreamBaseline,
  SessionControlFrame,
  SessionProjectionBaseline,
  SessionQueuedItem,
  SessionRequestId,
} from '../../types.ts'
import type {
  BeginSubmissionInput, PendingSubmissionRetirement, SessionFace, SubmissionHandle,
} from '../contract/session.ts'
import type {
  OpenState, PendingSubmission, PromptError, SessionSnapshot,
} from '../contract/snapshot.ts'
import { MutableSessionEventSource } from '../contract/events.ts'
import type {
  SessionEventLikeEntry, SessionLiveEventEntry,
} from '../contract/events.ts'
import { Notifier } from './notifier.ts'
import { isRemoteFailure } from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionRemotes } from './remotes.ts'
import { ProjectionValueStore } from './projection-store.ts'
import type { ProjectionsBaseline } from './projection-store.ts'
import { resolvedClientTimeZone } from '../time-zone.ts'
import { SessionQueueMirror } from './queue-mirror.ts'
import {
  ClientAssistantStream,
  type ClientAssistantStreamResult,
} from './assistant-stream.ts'

function projectionsBaseline(value: SessionProjectionBaseline): ProjectionsBaseline {
  return {
    ...value,
    asOfSeq: value.asOfSeq === -1 ? -1 : SessionSeq(value.asOfSeq),
  }
}

/** Messages requested per history page. */
export const PAGE_MESSAGES = 50

/** Messages requested per page while a turn jump loops backwards (fewer, larger round trips). */
export const JUMP_PAGE_MESSAGES = 200

/** Manager-owned observers of a Session object's local state edges. */
export interface SessionOptions {
  /** Catalog-discovered address selecting non-activating subagent transport. */
  address?: SubagentAddress
  /** Whether the exact direct parent Agent was live at the latest catalog read; absent before that read. */
  parentAvailable?: boolean
  /**
   * First ACCEPTED prompt on a blank session (fires at most once, on the
   * prompt RPC's success response): the manager mirrors the blank→false flip
   * into its list row so the session surfaces without waiting for a host
   * frame. Acceptance is the flip point because it proves the user message
   * is in the host log; a rejected first prompt keeps the session blank
   * (hidden, still reusable by connectWorkspace).
   */
  onEngaged?(session: Session): void
  /**
   * Manager-owned projection value store to adopt (frames route through the
   * manager and values outlive instantiation); omitted, the Session owns a
   * private store (bare object-layer construction).
   */
  projections?: ProjectionValueStore
}

/**
 * Owns a session's event window, lifecycle state, and observable
 * snapshot. React bindings remain outside this data layer. Features see only
 * the {@link SessionFace} slice (ISession verbs + the snapshot source); the
 * remaining public members are Session Controller internals.
 */
export class Session implements SessionFace {
  // ---- Window and derived state (all private; the snapshot is the only read API) ----
  private baseSeq = SessionLogOffset(0)
  private hasMore = false
  private openState: OpenState = 'cold'
  private openError: RemoteFailure | null = null
  private openPromise: Promise<void> | null = null
  /** Bumped by stream replacement to invalidate an in-flight doOpen. Stale
   *  passes drop all writes once the generation moves on. */
  private openGeneration = 0
  private loadingOlder = false
  /** Shared low-water target of the running jump loop; null when no jump is paging. */
  private jumpTargetSeq: SessionSeq | null = null
  /** The running jump loop's completion, shared by retargeting callers. */
  private jumpPromise: Promise<void> | null = null
  /** Authoritative stream-only inbox snapshot; pending work never hits history. */
  private readonly queueMirror = new SessionQueueMirror()
  private readonly assistantStream = new ClientAssistantStream()
  private running = false
  private address: SubagentAddress | undefined
  private parentAvailable: boolean | undefined
  /**
   * Sticky send marker, private input of the composerPhase derivation: set
   * synchronously before prompt()'s first await, never reset — the blank →
   * engaging edge of the phase machine (see ComposerPhase).
   */
  private promptAttempted = false
  /** A first accepted prompt stays in the engaging phase until its turn is observable. */
  private firstPromptPendingTurn = false
  /** Empty-log mirror (see ConversationSnapshot.blank); unknown bare sessions begin conservatively blank. */
  private blankBit = true
  private removed = false
  private promptError: PromptError | null = null
  private lastAgentError: string | null = null
  /** Local submission echoes, insertion-ordered (see SessionSnapshot.pendingSubmissions). */
  private pendingSubmissions: readonly PendingSubmission[] = []
  /** Per-echo settlement state; `retiring` latches the first observation so a
   *  queue frame and its durable event cannot both retire one echo. */
  private readonly submissionSettlements = new Map<SessionRequestId, {
    readonly onRetire?: ((retirement: PendingSubmissionRetirement) => void) | undefined
    retiring: boolean
  }>()
  /** Owns the addressed page/follow lifecycle while this Session is open. */
  private events: SessionEventStream | undefined

  /**
   * Per-session projection value store (push model; see the session-projection
   * subsystem page, docs/subsystems/session-projection.md): finished whole
   * values computed on the Host, seeded by the tail page's
   * projections block and updated by Session Controller control frames under the
   * one higher-seq-wins rule. Keys are read via `projections.faceOf(key)`
   * (the useProjection resolution face); the conversation snapshot never
   * carries projection values, and no client-side domain folding exists.
   * Manager-owned when constructed through SessionManager (frames route and
   * the store outlives instantiation, the title-snapshot precedent); a bare
   * construction gets a private store.
   */
  readonly projections: ProjectionValueStore

  /** Contiguous history and live tail consumed by Conversation assembly. */
  readonly eventSource = new MutableSessionEventSource()
  private snapshotCache: SessionSnapshot
  private readonly notifier: Notifier
  /**
   * Agent-scoped cordis context, bound once by ClientSessions when it
   * mints the scope (the client mirror of the host Agent's loopCtx). The
   * Session dispatches its own scoped events through it; undefined means
   * unbound (bare object-layer construction) or already pruned — both skip
   * dispatch-dependent behavior rather than fail.
   */
  private actx: Context | undefined

  /**
   * @param sessionId - Host session identity (client sessions are always Host-born).
   * @param remote - generated Remote namespaces this session calls.
   * @param options - optional manager-owned state observers.
   */
  constructor(
    readonly sessionId: SessionId,
    private readonly remote: SessionRemotes,
    private readonly options: SessionOptions = {},
  ) {
    this.projections = options.projections ?? new ProjectionValueStore()
    this.address = options.address
    this.parentAvailable = options.parentAvailable
    this.notifier = new Notifier(() => {
      this.snapshotCache = this.buildSnapshot()
    })
    this.snapshotCache = this.buildSnapshot()
  }

  /**
   * Bind the Agent-scoped context minted by ClientSessions (single write;
   * a second bind is a wiring error and throws). Direction stays one-way at
   * this binding boundary: consumers still reach the Session via `sessions.sessionOf`,
   * while the Session holds its own dispatch point (host Agent.loopCtx
   * mirror).
   * @param actx - the agent's scoped context.
   */
  bindScope(actx: Context): void {
    if (this.actx !== undefined) throw new Error(`session ${this.sessionId} already has a bound scope`)
    this.actx = actx
  }

  /** Release the bound scope at prune time (a later rebind accompanies a freshly minted scope). */
  unbindScope(): void {
    this.actx = undefined
  }

  // ---- Operations ----

  /**
   * Register one local submission echo (see the ISession declaration).
   * Synchronous through markDirty: the echo is in the very next snapshot, so
   * the conversation can paint it before the caller starts serializing.
   * @param input - echo content and the optional settlement callback.
   * @returns the minted identity for {@link prompt} plus the pre-prompt abandon path.
   */
  beginSubmission(input: BeginSubmissionInput): SubmissionHandle {
    const requestId = randomUUID() as SessionRequestId
    this.pendingSubmissions = [...this.pendingSubmissions, {
      requestId,
      placement: this.running
        ? input.mode === 'steer' ? 'steering' : 'queued'
        : 'transcript',
      time: Date.now(),
      text: input.text,
      images: input.images,
    }]
    this.submissionSettlements.set(requestId, { onRetire: input.onRetire, retiring: false })
    // The blank → engaging edge flips here, ahead of prompt(): the composer
    // docks and the echo renders on the click's own frame.
    this.promptAttempted = true
    this.notifier.markDirty()
    return { requestId, abandon: () => { this.retireFailedSubmission(requestId) } }
  }

  /**
   * Send (queue/steer passed through 1:1); failures land in the snapshot's promptError.
   * @param content - text plus browser-owned temporary image uploads.
   * @param mode - queue appends after the current turn; steer interrupts it.
   * @param signal - optional caller cancellation for the complete admission round-trip.
   * @param requestId - identity from {@link beginSubmission}; a failed identified prompt retires its echo.
   * @returns the prompt result (also mirrored into promptError on failure).
   */
  async prompt(
    content: PromptContentPart[],
    mode: 'queue' | 'steer',
    signal?: AbortSignal,
    requestId?: SessionRequestId,
  ): Promise<RemoteResult<{ accepted: true }>> {
    this.promptError = null
    this.lastAgentError = null
    // Synchronous, before the first await: the blank → engaging edge must be
    // visible on the session area's very first frame when a caller sends
    // ahead of navigation (first-send flow).
    this.promptAttempted = true
    if (this.blankBit) this.firstPromptPendingTurn = true
    this.notifier.markDirty()
    let result: RemoteResult<{ accepted: true }>
    if (this.address === undefined) {
      const clientTimeZone = resolvedClientTimeZone()
      result = await this.remote.session.prompt({
        requestId: requestId ?? randomUUID() as SessionRequestId,
        sessionId: this.sessionId,
        mode,
        content,
        clientTimeZone,
      }, signal)
    } else {
      const routed = await this.remote.subagents.prompt({
        requestId: randomUUID() as SessionRequestId,
        parentSessionId: this.address.parentSessionId,
        childSessionId: this.address.childSessionId,
        mode: 'continuable',
        content,
        clientTimeZone: resolvedClientTimeZone(),
      }, signal)
      result = routed.ok ? { ok: true, value: { accepted: true } } : routed
    }
    if (!result.ok) {
      if (requestId !== undefined) this.retireFailedSubmission(requestId)
      this.promptError = { op: 'send', error: result.error }
      this.notifier.markDirty()
      return result
    }
    // Blank flips on ACCEPTANCE, not attempt: an accepted prompt starts the
    // conversation's first turn on the host (the host criterion — a logged
    // turn/start — is fact, not optimism; standalone command and projection
    // events never flip it), while a rejected first prompt must keep the
    // session blank — the client-side blank mirror only ever lowers, so
    // flipping early on a failure would surface the session forever and
    // strip its connectWorkspace reuse eligibility against the host's
    // authority.
    if (this.blankBit) {
      this.blankBit = false
      this.options.onEngaged?.(this)
      this.notifier.markDirty()
    }
    return result
  }

  /**
   * Resolve one image referenced by this session into browser-consumable bytes.
   * @param attachmentId - opaque id found in the folded session log.
   * @returns the authenticated reference and decoded bytes.
   */
  async readAttachment(
    attachmentId: AttachmentIdType,
  ): Promise<RemoteResult<{ attachment: ImageAttachmentRef; data: Uint8Array }>> {
    const result = await this.remote.session.attachment({
      sessionId: this.sessionId,
      attachmentId,
    })
    if (!result.ok) return result
    const binary = atob(result.value.data)
    const data = Uint8Array.from(binary, char => char.charCodeAt(0))
    return { ok: true, value: { attachment: result.value.attachment, data } }
  }

  /** Apply one operation to a still-pending queue occurrence. */
  async updateQueue(itemId: MessageId, action: QueueAction): Promise<RemoteResult<{ accepted: true }>> {
    return this.remote.session.updateQueue({ sessionId: this.sessionId, itemId, action })
  }

  /**
   * Stop the active turn while the Host preserves pending inbox work; failures
   * land in promptError (same error-strip display slot). A subagent address
   * routes through `subagents.interruptByParent`, whose durable parent-address
   * authority works without a live parent Agent.
   * @returns the cancel result.
   */
  async cancel(): Promise<RemoteResult<{ accepted: true }>> {
    const address = this.address
    const result = address !== undefined
      ? await this.remote.subagents.interruptByParent(
        address.childSessionId,
        address.parentSessionId,
        'continuable',
      )
      : await this.remote.session.cancel({ sessionId: this.sessionId })
    if (!result.ok) {
      this.promptError = { op: 'stop', error: result.error }
      this.notifier.markDirty()
    }
    return result
  }

  /**
   * Rename: contract session.rename 1:1. On success settle the 'title'
   * projection cell from the response's `{title, seq}` under the store's
   * higher-seq-wins rule (the push frame arriving later is a no-op replay),
   * so the list row and any useProjection('title') reader update without
   * waiting for the control-stream projection update.
   * @param title - raw title text (the host normalizes acceptance).
   * @returns the rename result (normalized accepted title + title event seq).
   */
  async rename(title: string): Promise<RemoteResult<{ title: string; seq: SessionSeq }>> {
    const result = await this.remote.session.rename({ sessionId: this.sessionId, title })
    if (!result.ok) return result
    const seq = SessionSeq(result.value.seq)
    this.projections.apply('title', result.value.title, seq)
    return { ok: true, value: { title: result.value.title, seq } }
  }

  /**
   * Execute one slash-command line against this session's agent — pure
   * admission semantics (the host executor durably logs the lifecycle;
   * outcomes render as flow nodes, never as a response echo).
   * @param line - the full command line, leading slash included.
   * @returns the admission result.
   */
  async command(line: string): Promise<RemoteResult<{ matched: boolean }>> {
    const result = await this.remote.commands.execute(this.sessionId, line, [])
    if (!result.ok) return result
    return { ok: true, value: { matched: result.value !== undefined } }
  }

  /** First open: pull the tail page (idempotent — in-flight/already-open returns the existing promise). */
  open(): Promise<void> {
    if (this.openState === 'open') return Promise.resolve()
    if (this.openPromise !== null) return this.openPromise
    const promise = this.doOpen(this.openGeneration).finally(() => {
      // Identity-guarded: a superseded open must not null out the promise resync just started.
      if (this.openPromise === promise) this.openPromise = null
    })
    this.openPromise = promise
    return promise
  }

  /** Page up: pull one earlier page with the window's first seq as beforeSeq and prepend. */
  async loadOlder(): Promise<void> {
    if (this.openState !== 'open' || !this.hasMore || this.loadingOlder) return
    const events = this.events
    if (events === undefined) return
    this.loadingOlder = true
    this.notifier.markDirty()
    try {
      await events.prepend({ beforeSeq: this.baseSeq, maxMessages: PAGE_MESSAGES })
    } catch (error) {
      if (!isRemoteFailure(error)) {
        console.error('[session-controller] loadOlder failed:', error)
      }
    } finally {
      this.loadingOlder = false
      this.notifier.markDirty()
    }
  }

  /** Jump loader: page backwards until the window covers seq (see ISession.loadThrough). */
  loadThrough(seq: SessionSeq): Promise<void> {
    if (this.openState !== 'open' || !this.hasMore || this.baseSeq <= seq) return Promise.resolve()
    if (this.jumpPromise !== null) {
      // Retarget the running loop to the lowest requested seq.
      this.jumpTargetSeq = SessionSeq(Math.min(this.jumpTargetSeq ?? seq, seq))
      return this.jumpPromise
    }
    // A plain single-page pull owns the busy flag; the jump does not queue
    // behind it (the caller retries once it settles) and must leave no
    // target behind — only the loop's finally clears that field, and no
    // loop starts here.
    if (this.loadingOlder) return Promise.resolve()
    this.jumpTargetSeq = seq
    this.loadingOlder = true
    this.notifier.markDirty()
    // Stale-pass guard (the doOpen pattern): a resync mid-loop replaces the
    // stream generation; this pass then stops instead of paging the new
    // generation toward its old target.
    const generation = this.openGeneration
    this.jumpPromise = (async () => {
      try {
        while (this.hasMore && this.jumpTargetSeq !== null && this.baseSeq > this.jumpTargetSeq) {
          if (generation !== this.openGeneration) return
          const events = this.events
          if (events === undefined) return
          const before = this.baseSeq
          await events.prepend({ beforeSeq: this.baseSeq, maxMessages: JUMP_PAGE_MESSAGES })
          // No-progress guard: an empty or dropped page that still claims more
          // history must end the loop, not spin it.
          if (this.baseSeq >= before) return
        }
      } catch (error) {
        if (!isRemoteFailure(error)) {
          console.error('[session-controller] loadThrough failed:', error)
        }
      } finally {
        this.jumpTargetSeq = null
        this.jumpPromise = null
        this.loadingOlder = false
        this.notifier.markDirty()
      }
    })()
    return this.jumpPromise
  }

  /** Rebuild an opened history source after address replacement.
   *  Invalidates any in-flight open first; queue state belongs to the independently
   *  reconnecting control stream and remains untouched. */
  async resync(): Promise<void> {
    if (this.openState === 'cold') return // never opened: no window to rebuild (doOpen flips to 'loading' synchronously, so cold implies no in-flight open)
    this.openGeneration++
    const events = this.events
    this.events = undefined
    await events?.dispose()
    this.openPromise = null
    this.openState = 'cold'
    this.openError = null
    this.baseSeq = SessionLogOffset(0)
    this.notifier.markDirty()
    await this.open()
  }

  // ---- Subscription API (useSyncExternalStore direct wiring) ----

  /**
   * uSES subscription entry.
   * @param listener - change callback.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    return this.notifier.subscribe(listener)
  }

  /**
   * Cached Session snapshot (rebuilt lazily when dirty with no listeners).
   * @returns the cached reference (stable until the next flush).
   */
  getSnapshot(): SessionSnapshot {
    this.notifier.ensureFresh()
    return this.snapshotCache
  }

  // ---- Manager-only entry points (@internal; never called by the UI) ----

  /**
   * Replace every transient control value for this Session from one stream baseline.
   * @param queue - complete pending queue for this Session.
   */
  replaceControl(queue: readonly SessionQueuedItem[]): void {
    this.queueMirror.replace(queue)
    this.observeSubmissionQueue(queue)
    this.notifier.markDirty()
  }

  /**
   * Apply one Session-addressed live control update.
   * @param frame - queue replacement addressed to this Session.
   */
  handleControlFrame(frame: Extract<SessionControlFrame, { type: 'queue' }>): void {
    this.queueMirror.replace(frame.items)
    this.observeSubmissionQueue(frame.items)
    this.notifier.markDirty()
  }

  /**
   * Running-bit relay from the host stream (list entry and snapshot stay consistent).
   * @param running - the new running state.
   */
  handleRunning(running: boolean): void {
    // Turn-start conversion: a blank session never runs, so the first
    // running:true proves another side's first message landed.
    if (running && this.blankBit) {
      this.blankBit = false
      this.notifier.markDirty()
    }
    if (running) this.firstPromptPendingTurn = false
    if (this.running === running) return
    this.running = running
    this.notifier.markDirty()
  }

  /**
   * Install or clear the catalog-discovered transport address. A changed
   * address rebuilds an already-open window through its new history route.
   * @param address - direct parent/child address, or undefined for ordinary transport.
   * @param parentAvailable - latest exact-parent availability hint, or undefined before a catalog read.
   */
  configureSubagent(address: SubagentAddress | undefined, parentAvailable?: boolean): void {
    const same = this.address?.parentSessionId === address?.parentSessionId
      && this.address?.childSessionId === address?.childSessionId
      && this.address?.mode === address?.mode
    this.address = address
    this.parentAvailable = parentAvailable
    if (!same && this.openState !== 'cold') void this.resync()
    else this.notifier.markDirty()
  }

  /**
   * Update only the parent availability hint from a catalog refresh.
   * @param available - whether the exact direct parent is live.
   */
  handleSubagentParentAvailable(available: boolean): void {
    if (this.parentAvailable === available) return
    this.parentAvailable = available
    this.notifier.markDirty()
  }

  /**
   * Blank-bit relay from the authoritative summary source (`session.list` and
   * `api-session/added`). Monotone: once any signal (local first send,
   * running flip, an earlier summary) cleared it, a stale true never
   * re-blanks.
   * @param blank - the summary's derived empty-log bit.
   */
  handleBlank(blank: boolean): void {
    if (blank === this.blankBit) return
    if (blank && (this.promptAttempted || this.running)) return
    this.blankBit = blank
    this.notifier.markDirty()
  }

  /** `api-session/removed` relay: flag the snapshot while retaining the resident instance. */
  handleRemoved(): void {
    this.removed = true
    this.notifier.markDirty()
  }

  /**
   * `api-session/error` relay: the outlet for live failures with no turn position.
   * @param message - the stringified error.
   */
  handleAgentError(message: string): void {
    this.lastAgentError = message
    this.notifier.markDirty()
  }

  /**
   * Stop the Session's live Remote source.
   * @returns when the Remote iterator has completed teardown.
   */
  async dispose(): Promise<void> {
    // Unsettled echoes retire as failed so their owners can restore or
    // release browser resources; echoes already scheduled as observed keep
    // that settlement.
    for (const requestId of [...this.submissionSettlements.keys()]) {
      this.retireFailedSubmission(requestId)
    }
    this.openGeneration++
    const events = this.events
    this.events = undefined
    await events?.dispose()
  }

  // ---- Private ----

  /** @param generation - openGeneration at launch; stale passes cannot publish after replacement. */
  private async doOpen(generation: number): Promise<void> {
    this.openState = 'loading'
    this.openError = null
    this.notifier.markDirty()
    const events = new SessionEventStream(this.remote, this.sessionAddress(), {
      publish: (change) => {
        if (generation !== this.openGeneration || this.events !== events) return
        this.acceptEventChange(change)
      },
      failed: (error) => {
        this.failEventStream(events, generation, error)
      },
    })
    this.events = events
    try {
      await events.open({ maxMessages: PAGE_MESSAGES })
      if (generation !== this.openGeneration || this.events !== events) return
      this.openState = 'open'
    } catch (error) {
      if (generation !== this.openGeneration || this.events !== events) return
      if (!isRemoteFailure(error)) throw error
      this.events = undefined
      this.openState = 'error'
      this.openError = error
    } finally {
      if (generation === this.openGeneration) this.notifier.markDirty()
    }
  }

  /** Apply one contiguous journal update already reconciled by the Remote stream. */
  private acceptEventChange(change: SessionJournalChange): void {
    switch (change.type) {
      case 'replace':
        this.installWindow(
          change.entries,
          change.hasMore,
          change.page.projections === undefined ? undefined : projectionsBaseline(change.page.projections),
          change.page.assistantStream,
        )
        return
      case 'prepend':
        this.prependWindow(change.entries, change.hasMore)
        return
      case 'append':
        this.publishAssistantEntry(this.assistantStream.acceptDurable(change.entry))
        return
      case 'assistant-stream':
        this.publishAssistantEntry(this.assistantStream.acceptFrame(change.frame))
    }
  }

  /** Replace the complete contiguous window and apply page-owned projection metadata. */
  private installWindow(
    entries: readonly SessionEventLikeEntry[],
    hasMore: boolean,
    projections?: ProjectionsBaseline,
    assistantStream?: SessionAssistantStreamBaseline,
  ): void {
    // A durable gap-repair page has no assistant baseline. Clearing transient
    // attempts makes a held notification reopen follow once for an atomic
    // page/baseline pair instead of applying it to an unrelated repair cut.
    const visible = this.assistantStream.replace(entries, assistantStream)
    this.baseSeq = SessionLogOffset(entries[0]?.event.seq ?? 0)
    this.hasMore = hasMore
    if (visible.some(entry => entry.event.type === 'turn/start')) this.firstPromptPendingTurn = false
    if (projections !== undefined) this.projections.seed(projections)
    this.eventSource.replace(visible, hasMore)
    for (const entry of visible) this.observeSubmissionEvent(entry.event)
    this.notifier.markDirty()
  }

  private publishAssistantEntry(result: ClientAssistantStreamResult): void {
    if (result?.type === 'rebaseline') {
      const events = this.events
      queueMicrotask(() => {
        if (events !== undefined && this.events === events) events.restart()
      })
      return
    }
    if (result?.type === 'settlement') {
      this.eventSource.settleAssistant(result.attemptId, result.entry)
      this.observeSubmissionEvent(result.entry.event)
      this.notifier.markDirty()
      return
    }
    if (result?.type === 'abandonment') {
      this.eventSource.settleAssistant(result.attemptId)
      this.notifier.markDirty()
      return
    }
    if (result?.type === 'publish' && this.appendLive(result.entry)) {
      this.notifier.markDirty()
    } else if (result?.type === 'transient') {
      this.eventSource.append(result.entry)
      this.notifier.markDirty()
    }
  }

  /** Prepend one stream-validated history page. */
  private prependWindow(entries: readonly SessionEventLikeEntry[], hasMore: boolean): void {
    this.baseSeq = entries[0] === undefined ? this.baseSeq : SessionLogOffset(entries[0].event.seq)
    this.hasMore = hasMore
    this.eventSource.prepend(entries, hasMore)
  }

  /** Append one stream-validated live event. */
  private appendLive(entry: SessionLiveEventEntry): boolean {
    const event = entry.event
    const awaitingFirstTurn = this.firstPromptPendingTurn
    if (event.type === 'turn/start') this.firstPromptPendingTurn = false
    const queueChanged = this.queueMirror.acceptDurable(event)
    this.eventSource.append(entry)
    // After the feed append: the conversation assembly's animation frame is
    // registered by the feed subscribers above, so the echo-retirement frame
    // scheduled here always runs after the durable node became renderable.
    this.observeSubmissionEvent(event)
    return queueChanged || awaitingFirstTurn !== this.firstPromptPendingTurn
  }

  /** Retire the matching echo when a durable browser-prompt `user/message` becomes visible. */
  private observeSubmissionEvent(event: { readonly type: string; readonly data?: unknown }): void {
    if (this.submissionSettlements.size === 0 || event.type !== 'user/message') return
    // Structural read: window entries may be compact history records, so the
    // fields are narrowed rather than trusted (same posture as Conversation
    // assembly matchers).
    const data = event.data as { readonly source?: unknown; readonly content?: unknown } | undefined
    const source = data?.source as { readonly kind?: unknown; readonly rpcId?: unknown } | undefined
    if (source?.kind !== 'user' || typeof source.rpcId !== 'string') return
    this.scheduleObservedRetirement(source.rpcId as SessionRequestId, imageRefsIn(data?.content))
  }

  /** Retire echoes whose prompts landed in the host inbox instead of the log (running-turn submissions). */
  private observeSubmissionQueue(items: readonly SessionQueuedItem[]): void {
    if (this.submissionSettlements.size === 0) return
    for (const item of items) {
      if (item.rpcId !== undefined) {
        this.scheduleObservedRetirement(item.rpcId, imageRefsIn(item.message.content))
      }
    }
  }

  /**
   * Latch one observed settlement and remove the echo an animation frame
   * later. The delay keeps the echo in the snapshot until the frame in which
   * the durable node (whose assembly frame was registered first) is
   * renderable; the render-time rpcId dedupe hides the one-frame overlap.
   */
  private scheduleObservedRetirement(
    requestId: SessionRequestId,
    attachments: readonly ImageAttachmentRef[],
  ): void {
    const settlement = this.submissionSettlements.get(requestId)
    if (settlement === undefined || settlement.retiring) return
    settlement.retiring = true
    scheduleFrame(() => { this.finishSubmission(requestId, { reason: 'observed', attachments }) })
  }

  /** Remove one unsettled echo immediately (prompt rejection, abort, or disposal). */
  private retireFailedSubmission(requestId: SessionRequestId): void {
    const settlement = this.submissionSettlements.get(requestId)
    if (settlement === undefined || settlement.retiring) return
    settlement.retiring = true
    this.finishSubmission(requestId, { reason: 'failed' })
  }

  /** Single removal point: drop the echo, publish, then notify the owner. */
  private finishSubmission(requestId: SessionRequestId, retirement: PendingSubmissionRetirement): void {
    const settlement = this.submissionSettlements.get(requestId)
    /* v8 ignore next -- retiring latches before every schedule, so one settlement never finishes twice. */
    if (settlement === undefined) return
    this.submissionSettlements.delete(requestId)
    this.pendingSubmissions = this.pendingSubmissions.filter(echo => echo.requestId !== requestId)
    this.notifier.markDirty()
    settlement.onRetire?.(retirement)
  }

  /** Publish a terminal background failure only while this stream still owns the Session. */
  private failEventStream(events: SessionEventStream, generation: number, error: unknown): void {
    if (generation !== this.openGeneration || this.events !== events) return
    if (!isRemoteFailure(error)) throw error
    this.openGeneration++
    this.events = undefined
    this.openPromise = null
    this.openState = 'error'
    this.openError = error
    void events.dispose()
    this.notifier.markDirty()
  }

  private buildSnapshot(): SessionSnapshot {
    return {
      sessionId: this.sessionId,
      queue: this.queueMirror.snapshot(),
      pendingSubmissions: this.pendingSubmissions,
      running: this.running,
      subagent: this.address === undefined
        ? null
        : {
          address: this.address,
          ...(this.parentAvailable === undefined ? {} : { parentAvailable: this.parentAvailable }),
        },
      removed: this.removed,
      openState: this.openState,
      openError: this.openError,
      hasMore: this.hasMore,
      loadingOlder: this.loadingOlder,
      promptError: this.promptError,
      blank: this.blankBit,
      lastAgentError: this.lastAgentError,
      promptAttempted: this.promptAttempted,
      awaitingFirstTurn: this.firstPromptPendingTurn,
    }
  }

  private sessionAddress(): SessionAddress {
    return this.address === undefined
      ? { kind: 'session', sessionId: this.sessionId }
      : { kind: 'subagent', ...this.address }
  }
}

/** Run one callback on the next animation frame, or a macrotask where no frame clock exists. */
function scheduleFrame(fn: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { fn() })
  else setTimeout(fn, 0)
}

/** Image attachment references in one structurally-read content block list, in block order. */
function imageRefsIn(content: unknown): readonly ImageAttachmentRef[] {
  if (!Array.isArray(content)) return []
  const refs: ImageAttachmentRef[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const candidate = block as { readonly type?: unknown; readonly attachment?: unknown }
    if (candidate.type === 'image' && typeof candidate.attachment === 'object' && candidate.attachment !== null) {
      refs.push(candidate.attachment as ImageAttachmentRef)
    }
  }
  return refs
}
