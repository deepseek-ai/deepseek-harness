/**
 * Frozen input-machine contract. Types
 * only. Three-tier visibility: business packages see InputState via the
 * InputZone currency; the scoped input events carry the mutation verbs; the
 * conversation wiring layer alone sees the full SessionInput. The draft text
 * and its reference chips live in the shell's Lexical editor; the machine
 * here is the submit plane (phase, claim, attempt) alone.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { InboxState } from '@deepseek-ai/dsh-agent/types'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ArbitrateKey, ArbitrateOutcome, Occurrence, ReferenceInsert, TokenSpan } from './draft-editor.ts'
import type { InputSubmitMode } from './composer-submission.ts'

/** Attachment payload passed to a claimed command submission. */
export type SubmitAttachment =
  | {
    readonly type: 'image'
    readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
    readonly data: string
    readonly name?: string
  }
  | { readonly type: 'file'; readonly receiptId: string }

/** Command serialization result for one ordered attachment draft. */
export interface DraftAttachmentSerializationResult {
  readonly attachments: readonly SubmitAttachment[]
}

/** Settled result of a command or default composer submission. */
export interface SubmitOutcome {
  readonly kind: 'success' | 'error'
  readonly text?: string
}

/** Command-mode credential supplied by one input-trigger source. */
export interface CommandClaim {
  /** Catalog command name without the leading slash (the key of per-command composer copy such as `hint.*`). */
  readonly name: string
  /** Inserted command text with its argument separator; the bare complete name also retains the claim. */
  readonly token: string
  readonly hint?: string
  readonly attachments?: boolean
  /**
   * Submit the claimed command.
   * @param args - command text after the claimed token.
   * @param actx - current Session scope.
   * @param attachments - serialized draft attachments accepted by the claim.
   * @returns command settlement.
   */
  submit(args: string, actx: Context, attachments: readonly SubmitAttachment[]): Promise<SubmitOutcome>
}

/** Result of trigger-source adjudication. */
export type PickOutcome =
  | { readonly claim: CommandClaim }
  | { readonly insert: ReferenceInsert }
  | { readonly text: string; readonly continue?: boolean }
  | 'handled'
  | undefined

/** Scoped request to enter command mode. */
export interface BeginCommandRequest {
  readonly claim: CommandClaim
  readonly span: TokenSpan
}

/** Scoped request to insert a structured reference. */
export interface InsertReferenceRequest {
  readonly reference: ReferenceInsert
  readonly span: TokenSpan
}

/** Scoped request to consume a command token after business settlement. */
export interface ConsumeTokenRequest {
  readonly guard:
    | { readonly kind: 'span'; readonly span: TokenSpan }
    | { readonly kind: 'bare-token'; readonly token: string }
}

/** Scoped request to insert ordinary completion text. */
export interface InsertTextRequest {
  readonly text: string
  readonly span: TokenSpan
  readonly continue?: boolean
}

/** Trigger hit used to open one source programmatically. */
export interface InputTriggerHit {
  readonly trigger: '/' | '@'
  readonly query: string
  readonly quoted: boolean
  readonly position: 'leading' | 'inline'
  readonly span: TokenSpan
}

/** Structural per-Session trigger provider consumed by the input shell. */
export interface InputTriggerController {
  readonly launcher: ObservableSnapshot<string | null>
  readonly lexicon: ObservableSnapshot<ReadonlyMap<'/' | '@', readonly string[]>>
  /** @param draft - current draft. @param caret - caret offset. @param guard - availability tier. @param draftRev - input revision. */
  track(
    draft: string,
    caret: number,
    guard: { readonly tier: 'plain' | 'claimed' | 'frozen' },
    draftRev: number,
  ): void
  /** @param key - intercepted key. @param composing - whether IME composition is active. @returns routing result. */
  arbitrate(key: ArbitrateKey, composing: boolean): ArbitrateOutcome
  /** @returns whether Space applied a trigger result. */
  onSpace(): boolean
  /** @param source - reference source. @param ref - source-local id. @param signal - submit cancellation. @returns model text. */
  serializeReference(source: string, ref: string, signal: AbortSignal): Promise<string>
  /** @param line - trimmed draft. @param signal - submit cancellation. @param envelope - attachment count. @returns winning result. */
  adjudicate(
    line: string,
    signal: AbortSignal,
    envelope: { readonly attachments: number },
  ): Promise<PickOutcome>
  /**
   * @param source - chip owner, or undefined for a text reference.
   * @param reference - source id and glyph.
   * @returns whether a preview opened.
   */
  openReference(source: string | undefined, reference: Pick<ReferenceInsert, 'ref' | 'appearance'>): boolean
  /** @param source - source name. @param hit - synthetic trigger hit. */
  toggleSource(source: string, hit: InputTriggerHit): void
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Claim a command token for the scoped input machine.
     * @param request - command claim and span.
     * @mode bail
     */
    'slash/input-begin-command'(request: BeginCommandRequest): true | undefined
    /**
     * Insert a structured reference into the scoped input machine.
     * @param request - reference and span.
     * @mode bail
     */
    'slash/input-insert-reference'(request: InsertReferenceRequest): true | undefined
    /**
     * Consume a trigger token without inserting replacement content.
     * @param request - token guard.
     * @mode bail
     */
    'slash/input-consume-token'(request: ConsumeTokenRequest): true | undefined
    /**
     * Insert plain text into the scoped input machine.
     * @param request - plain text and span.
     * @mode bail
     */
    'slash/input-insert-text'(request: InsertTextRequest): true | undefined
  }
}

/** Browser-runtime identity of one unsent attachment draft. */
export type DraftAttachmentId = Branded<'DraftAttachmentId'>

/**
 * The scoped-event application verbs: the hub's bail listeners call these,
 * and the boolean answer IS the event's bail value (true ⟺ the editor
 * applied the edit after phase and span guards).
 */
export interface InputTarget {
  /** Replace the trigger span with claim.token and enter claimed (span-CAS'd). */
  beginCommand(claim: CommandClaim, span: TokenSpan): boolean
  /** Replace the trigger span with one reference chip (span-CAS'd). */
  insertReference(ref: ReferenceInsert, span: TokenSpan): boolean
}

/** Per-session input facade owned by the conversation wiring layer. */
export interface SessionInput extends InputTarget {
  /** Replace the whole draft (persisted-draft seed and programmatic writes). */
  setDraft(text: string): void
  /** Append ordered browser-owned attachment ids; busy admission phases refuse. */
  addAttachments(ids: readonly DraftAttachmentId[]): boolean
  /** Remove one browser-owned attachment id; busy admission phases refuse. @returns whether the id was removed. */
  removeAttachment(id: DraftAttachmentId): boolean
  /** Drop ids whose browser-owned objects no longer exist. */
  pruneAttachments(ids: readonly DraftAttachmentId[]): void
  /**
   * THE complexity sink: enter adjudication, submit transaction, and the default sink live inside.
   * @param mode - delivery intent retained through asynchronous adjudication and serialization.
   */
  submit(mode?: InputSubmitMode): void
  /**
   * Surface a notice outside the machine's own effect stream: detached
   * command results and business notifications render through here.
   * Session-routed — resolving the facade via SessionInputResolver.for(actx) lands
   * the notice on that session's composer, so a result arriving after a
   * session switch still reaches its own session.
   * @param level - severity tier.
   * @param text - notice body.
   */
  notify(level: 'info' | 'error', text: string): void

  /**
   * Return the keyboard to the composer with the caret it last held, for
   * callers that took focus away from it (an overlay that held its own).
   */
  focus(): void
  /** Input state store (InputZone currency + decorations read here). */
  readonly state: SnapshotStore<InputState>
}

/** Session-addressed access to the per-session input facade. */
export interface SessionInputResolver {
  /** Resolve the facade for one session-scope ctx. */
  for(actx: Context): SessionInput
}

/**
 * The public input action face provided to every session-scope slot
 * component: stable-identity void callbacks, mirroring the
 * useStore+actions convention. Command-style handles (arbitrate/space/
 * paste/…) stay InputBar-private and never ride this face.
 */
export interface InputActions {
  /** @returns a revision-guarded copy of the current editor selection. */
  captureInsertion(): TokenSpan
  /**
   * Insert asynchronous text without replacing subsequent edits or reference chips.
   * @param text - plain text to insert in one undo step.
   * @param span - captured selection and draft revision.
   * @returns false when the draft changed or submission locked the editor.
   */
  insertText(text: string, span: TokenSpan): boolean
  /** Replace the whole draft (persisted-draft seed and programmatic writes). */
  setDraft(text: string): void
  /** Append ordered browser-owned attachment ids; busy admission phases refuse. */
  addAttachments(ids: readonly DraftAttachmentId[]): boolean
  /** Remove one browser-owned attachment id; busy admission phases refuse. */
  removeAttachment(id: DraftAttachmentId): void
  /** Drop ids whose browser-owned objects no longer exist. */
  pruneAttachments(ids: readonly DraftAttachmentId[]): void
  /** Enter submission (adjudication / claim transaction / default sink inside). */
  submit(): void
}

/** One surfaced notice (command results, adjudication failures). seq keys re-render of repeats. */
export interface InputNotice {
  readonly level: 'info' | 'error'
  readonly text: string
  readonly seq: number
}

/** Guard union of the scoped consume-token event, checked by the shell. */
export type ConsumeTokenGuard = ConsumeTokenRequest['guard']

/** Published input state (the currency; per-session). */
export interface InputState {
  /** Clipboard-text projection of the editor document (chips expanded to their clipboard form). */
  readonly draft: string
  /** Ordered runtime-only attachment ids; browser objects stay in ConversationController. */
  readonly attachmentIds: readonly DraftAttachmentId[]
  /** Monotonic editor revision (span CAS compares against this). */
  readonly draftRev: number
  readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
  /** Present exactly while claimed/submitting (claim snapshot during flight; submit closure withheld). */
  readonly claim?: { readonly name: string; readonly token: string; readonly hint?: string; readonly attachments?: boolean }
  /** Reference occurrence view of the editor's chips, sorted by offset. */
  readonly occurrences: readonly Occurrence[]
  /** Messages still waiting for their own turn. */
  readonly queue: InboxState['next-turn']
}

/**
 * One in-flight submission attempt: the ONLY id concept in the submit plane.
 * Created on enter; carried by adjudicated/submit-settled/sink-settled
 * events; stale attempts are dropped (anti-backwash). Command attempts hold
 * the single frozen in-flight slot; default-sink attempts run detached and
 * concurrently. release/session teardown aborts them all, keeping every
 * promise bounded.
 */
export interface SubmitAttempt {
  readonly seq: number
  readonly signal: AbortSignal
  /** Clipboard-projection draft captured before an optimistic default-send commit. */
  readonly draftSnapshot: string
  /** Default-message delivery intent retained while slash adjudication is pending. */
  readonly mode: InputSubmitMode
}

/**
 * Submit-machine input events (the machine's single write path). Text
 * mutation lives in the editor; the machine only observes the draft through
 * event payloads (claim integrity, enter snapshots, settlement decisions).
 */
export type InputEvent =
  /** Clipboard projection changed: the claimed integrity watch runs (zero effects). */
  | { readonly type: 'draft-changed'; readonly draft: string }
  /** The editor applied a claim-token replacement: enter claimed. */
  | { readonly type: 'claim'; readonly claim: CommandClaim }
  /** Enter submission with the current clipboard projection. */
  | { readonly type: 'enter'; readonly mode: InputSubmitMode; readonly draft: string }
  | { readonly type: 'adjudicated'; readonly attempt: SubmitAttempt; readonly outcome: PickOutcome }
  | { readonly type: 'adjudication-failed'; readonly attempt: SubmitAttempt; readonly message: string }
  /** Settlement carries the live clipboard projection for suffix-retention and claim re-entry decisions. */
  | { readonly type: 'submit-settled'; readonly attempt: SubmitAttempt; readonly ok: boolean; readonly draft: string; readonly outcome?: SubmitOutcome; readonly message?: string }
  /** Settlement of one optimistic default send, independent of the frozen command slot. */
  | { readonly type: 'sink-settled'; readonly attempt: SubmitAttempt; readonly ok: boolean; readonly outcome?: SubmitOutcome; readonly message?: string }
  /** Commit an attachment-only send whose empty draft did not need an attempt. */
  | { readonly type: 'send-committed' }
  | { readonly type: 'release' }

/**
 * Submit-machine output effects (executed by the SessionInput shell; the
 * machine stays pure).
 */
export type InputEffect =
  | { readonly type: 'adjudicate'; readonly attempt: SubmitAttempt; readonly draft: string }
  | { readonly type: 'begin-submit'; readonly attempt: SubmitAttempt; readonly claim: CommandClaim; readonly args: string }
  /** Detached default send; the shell captures its editor projection before the following commit effect. */
  | {
    readonly type: 'default-sink'
    readonly attempt: SubmitAttempt
    readonly draft: string
    readonly mode: InputSubmitMode
  }
  | { readonly type: 'notice'; readonly level: 'info' | 'error'; readonly text: string }
  /**
   * Clear the committed draft in the editor and cut undo history. A string
   * snapshot keeps a pure suffix typed during the Host round-trip (content
   * appended after the sent snapshot survives; interleaved edits cannot be
   * separated and clear whole); null clears unconditionally (attachment-only
   * sends have no draft to retain).
   */
  | { readonly type: 'commit-draft'; readonly retainSuffixOf: string | null }
