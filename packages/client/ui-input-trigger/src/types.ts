/**
 * Input-trigger provider contract. Types only — no runtime code. The
 * conversation input layer owns and exports the shared machine currency;
 * this module re-exports it for trigger providers.
 *
 * Providers receive a {@link ClientSessionContext} projection per call —
 * never a Cordis context or the mutable Session. RPC and service access go
 * through the provider plugin's own root context captured at registration.
 */
import type {
  PickOutcome, TokenSpan,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export type {
  ArbitrateKey, ArbitrateOutcome, BeginCommandRequest, CommandClaim, ConsumeTokenRequest,
  InsertReferenceRequest, InsertTextRequest, PickOutcome, ReferenceInsert, SubmitAttachment,
  SubmitOutcome, TokenSpan,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

/**
 * The provider-facing projection of one client session. It carries stable
 * identity alone; a source that calls Agent-bound RPCs must consult its own
 * service's capability state because an addressed persisted subagent may
 * have a client scope without a live Host Agent.
 */
export interface ClientSessionContext {
  readonly sessionId: SessionId
}

/** Trigger character a source binds to. */
export type TriggerChar = '/' | '@'

/** Where the trigger token sits in the draft: leading (trimmed draft starts with it) or inline. */
export type TriggerPosition = 'leading' | 'inline'

/** Which of the three pick paths produced a pick. */
export type PickVia = 'menu' | 'space' | 'enter'

/** What a pick asks for: resolve the candidate, or drill into it in place. */
export type PickAction = 'pick' | 'drill'

/** Leading glyph token of one menu candidate, mapped to its SVG by the menu view. */
export type InputTriggerCandidateIcon = 'file' | 'folder' | 'session'

/** One menu candidate. Pure display data — zero behavior declaration. */
export interface InputTriggerCandidate {
  readonly name: string
  readonly description?: string
  readonly icon?: InputTriggerCandidateIcon
  readonly hint?: string
  /** Optional visual heading shared by adjacent candidates; sectioned groups omit their source-title row. */
  readonly section?: string
  /** Opaque source-owned pick payload. */
  readonly value?: string
  /**
   * The row offers a drill action beside the settling pick: Tab or the row's
   * chevron refines the query in place (directory descent) instead of
   * resolving the candidate.
   */
  readonly drill?: boolean
}

/**
 * One crumb of a source's menu header. The pipeline treats `value` as opaque
 * and hands it straight back on pick, so a source names its own destinations.
 */
export interface InputTriggerCrumb {
  /** Rendered text of this step. */
  readonly label: string
  /** Opaque source-owned pick payload, returned through `onPick`. */
  readonly value: string
  /** The step the menu is currently showing; rendered as the trailing, unclickable crumb. */
  readonly current?: boolean
}

/** What a source needs to decide the header of the open menu. */
export interface HeaderRequest {
  /** Text between the trigger char and the caret, live-filtered. */
  readonly query: string
  /** Whether the active @file token is an open quoted path. */
  readonly quoted?: boolean
  /**
   * True while this menu was opened or last re-scoped by a drill pick. It
   * survives further typing and clears when the menu closes, so a query typed
   * after a drill still reads as drilled. The pipeline owns the fact; what it
   * means for a header is the source's to decide.
   */
  readonly drilled: boolean
}

/**
 * Non-text composer submission state visible to enter adjudication. The
 * composer owns the actual attachment payloads; adjudication only needs their
 * presence to accept or refuse a whole submission.
 */
export interface SubmitEnvelope {
  /** Number of attachments accompanying the draft. */
  readonly attachments: number
}

/** Candidate request passed to a source. The signal is superseded on query change / menu close. */
export interface CandidateRequest {
  readonly query: string
  /** Whether the active @file token is an open quoted path. */
  readonly quoted?: boolean
  readonly position: TriggerPosition
  /** Whether this menu was opened or last re-scoped by a drill pick; see {@link HeaderRequest.drilled}. */
  readonly drilled: boolean
  readonly signal: AbortSignal
}

/** Everything a source receives on pick: candidate + session projection + the span snapshot for CAS. */
export interface InputTriggerPick {
  readonly candidate: InputTriggerCandidate
  readonly session: ClientSessionContext
  readonly position: TriggerPosition
  readonly via: PickVia
  /** Settling pick, or the candidate's drill action (Tab / row chevron). */
  readonly action: PickAction
  readonly span: TokenSpan
}

/**
 * Reference codec owned by a source that produces {@link ReferenceInsert}
 * outcomes: the clipboard projection for copy/cut/persistence, and the model
 * serialization invoked per occurrence by the submit attempt (async, abort
 * rides the attempt signal; failure blocks the send — never a silent
 * downgrade to the clipboard text).
 */
export interface ReferenceCodec {
  /** Clipboard / persistence projection of one reference (e.g. `/name`). */
  clipboardText(ref: string): string
  /** Model serialization of one reference (e.g. `<skill>name</skill>`). */
  serialize(ref: string, signal: AbortSignal): Promise<string>
}

/**
 * One trigger source. Every callback receives the session's
 * ClientSessionContext projection; sources keep no copy across calls.
 *
 * Space/enter adjudication rides the optional match hooks: implementing one
 * IS the participation claim — the pipeline polls each implementing source
 * with the leading token; the first non-undefined answer wins (registration
 * order); no claimant → default sink. The hooks split because their timing
 * budgets differ: space fires mid-keystroke and must answer synchronously
 * from hot state, while enter may await the source's own warmup.
 */
export interface InputTriggerSource {
  readonly trigger: TriggerChar
  /** Menu group label; unique per trigger — duplicate registration throws. */
  readonly name: string
  /** Menu group display order (lower = higher in the list; default 0). */
  readonly order?: number
  /** Whether the menu renders the source-title row; defaults to true. */
  readonly showGroupTitle?: boolean
  candidates(session: ClientSessionContext, req: CandidateRequest): Promise<readonly InputTriggerCandidate[]>
  /**
   * Synchronous breadcrumb rendered above this source's group, re-polled on
   * every hit. Implementing IS the participation claim; `undefined` means
   * this request needs no header. A crumb pick routes back through
   * {@link InputTriggerSource.onPick} with `action: 'drill'` and the crumb's
   * `value` as the candidate value, so returning to a step and descending
   * into one are the same outcome.
   * @param session - stable session projection.
   * @param req - the live query and how the menu reached it.
   * @returns the crumbs to render, or undefined for no header.
   */
  header?(session: ClientSessionContext, req: HeaderRequest): readonly InputTriggerCrumb[] | undefined
  /** Every pick lands here; claim/insert outcomes are executed by the pipeline via the scoped input events. */
  onPick(pick: InputTriggerPick): PickOutcome
  /** Synchronous space-time adjudication over hot state only. `token` is the just-completed leading token (e.g. '/goal'). */
  matchSpace?(session: ClientSessionContext, token: string): PickOutcome
  /**
   * Enter-time adjudication; may strong-wait the source's own warmup and
   * reject on warmup failure. `line` is the full trimmed draft: the source
   * parses it and applies its own kind policy — args-tolerant kinds claim
   * with trailing text present, bare-token-only kinds answer undefined
   * unless the line is exactly the token. `envelope` describes the rest of
   * the composer submission; a source that would consume the line but cannot
   * consume the whole envelope throws to surface the refusal and leave the
   * submission intact.
   */
  matchEnter?(
    session: ClientSessionContext,
    line: string,
    signal: AbortSignal,
    envelope: SubmitEnvelope,
  ): Promise<PickOutcome>
  /**
   * Scope-birth prewarm hook (fire-and-forget): the per-session controller
   * calls it once when the session scope comes alive so sources can fetch
   * their backing data before the first interaction.
   */
  warm?(session: ClientSessionContext): void
  /**
   * Synchronous hot-snapshot name roll for plain-text reference decoration.
   * Implementing IS the participation claim: the render side
   * scans the draft for `<trigger><name>` tokens and decorates exact matches.
   * `undefined` = backing data not warm yet — no decoration, never a fetch
   * (the render path must stay synchronous and side-effect free).
   */
  lexicon?(session: ClientSessionContext): readonly string[] | undefined
  /**
   * Subscribe to changes of this source's {@link InputTriggerSource.lexicon} answer
   * for one session (backing data settled, invalidated, or refreshed). The
   * controller re-polls lexicon on each notification; a source whose roll
   * never changes after warm omits the hook.
   * @param session - stable session projection.
   * @param listener - invalidation callback.
   * @returns unsubscribe.
   */
  subscribeLexicon?(session: ClientSessionContext, listener: () => void): () => void
  /** Reference codec; required for sources producing insert outcomes. */
  readonly codec?: ReferenceCodec
}

/** Trigger availability tier, derived from the input phase by the wiring layer. */
export interface TriggerGuard {
  /** plain: '/' and '@' live; claimed: '/' suppressed, '@' live; frozen: none. */
  readonly tier: 'plain' | 'claimed' | 'frozen'
}
