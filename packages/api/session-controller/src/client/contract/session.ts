/**
 * The outward session face. Feature packages never see the concrete Session
 * class: components read lifecycle state through `useSession` (the
 * ObservableSnapshot half), and orchestration code calls the behavior verbs
 * below — nothing else. Widening this interface is the explicit act of
 * widening what features may do to a session (and what every test fixture
 * must stub); implementation-internal entry points (history staging, wire-frame
 * dispatch) stay on the class, invisible out here.
 */
import type { AttachmentIdType, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { PromptContentPart, QueueAction, SessionRequestId } from '../../types.ts'
import type { PendingSubmissionImage, SessionSnapshot } from './snapshot.ts'

/**
 * Why a local submission echo left the snapshot: `observed` when its durable
 * `user/message` event or host queue occurrence arrived (with the admitted
 * image references in prompt order), `failed` when the prompt was rejected,
 * threw, or was aborted before acceptance.
 */
export type PendingSubmissionRetirement =
  | { readonly reason: 'observed'; readonly attachments: readonly ImageAttachmentRef[] }
  | { readonly reason: 'failed' }

/** Input registering one local submission echo ahead of its prompt call. */
export interface BeginSubmissionInput {
  /** Delivery mode used with the upcoming prompt. */
  readonly mode: 'queue' | 'steer'
  /** Prompt text exactly as the upcoming prompt will send it. */
  readonly text: string
  /** Ordered image previews matching the upcoming prompt's image parts. */
  readonly images: readonly PendingSubmissionImage[]
  /** Settlement callback fired exactly once when the echo retires. */
  readonly onRetire?: (retirement: PendingSubmissionRetirement) => void
}

/** One registered submission echo: the identity its prompt must carry, and the pre-prompt escape hatch. */
export interface SubmissionHandle {
  /** The prompt RPC identity; pass it to {@link ISession.prompt}. */
  readonly requestId: SessionRequestId
  /** Retire the echo as failed when the caller cannot reach prompt() (serialization failure); no-op after any other settlement. */
  abandon(): void
}

/** Key-addressed projection read face (the useProjection resolution path; see ProjectionValueStore). */
export interface ProjectionsFace {
  /**
   * The identity-stable bare observable for one projection key (absence is
   * an `undefined` snapshot, never a missing face).
   * @param key - projection key.
   * @returns the key's value face.
   */
  faceOf(key: string): ObservableSnapshot<unknown>
}

/** Identity plus the behavior verbs features may invoke on a session. */
export interface ISession {
  /** The session's host identity (agent id — same axis). */
  readonly sessionId: SessionId
  /** Host-computed projection values by key (the useProjection seat). */
  readonly projections: ProjectionsFace
  /**
   * Register one local submission echo in `snapshot.pendingSubmissions`,
   * synchronously, before the caller serializes and sends the prompt. The
   * echo retires when a durable `user/message` event or queue occurrence
   * carrying the returned identity arrives, or when the identified prompt
   * call fails.
   * @param input - echo content and the optional settlement callback.
   * @returns the minted identity for {@link prompt} plus the pre-prompt abandon path.
   */
  beginSubmission(input: BeginSubmissionInput): SubmissionHandle
  /**
   * Send a prompt into the session.
   * @param content - text plus browser-owned temporary image uploads.
   * @param mode - 'queue' appends a turn; 'steer' interrupts the running one.
   * @param signal - optional caller cancellation for the complete admission round-trip.
   * @param requestId - identity from {@link beginSubmission}; a failed identified prompt retires its echo.
   * @returns acceptance, or the business error (also mirrored into snapshot.promptError).
   */
  prompt(
    content: PromptContentPart[],
    mode: 'queue' | 'steer',
    signal?: AbortSignal,
    requestId?: SessionRequestId,
  ): Promise<RemoteResult<{ accepted: true }>>
  /**
   * Resolve one durable image referenced by this session.
   * @param attachmentId - opaque id found in the folded session log.
   * @returns the authenticated reference and decoded bytes.
   */
  readAttachment(
    attachmentId: AttachmentIdType,
  ): Promise<RemoteResult<{ attachment: ImageAttachmentRef; data: Uint8Array }>>
  /**
   * Apply one edit, remove, or strict steer action to a still-pending queue occurrence.
   * @param itemId - agent-owned inbox occurrence identity.
   * @param action - requested queue operation.
   * @returns acceptance, or a business/transport error.
   */
  updateQueue(itemId: MessageId, action: QueueAction): Promise<RemoteResult<{ accepted: true }>>
  /**
   * Cancel the running turn. Pending queued work remains and resumes in FIFO
   * order after the Host reaches cancellation quiescence.
   * @returns acceptance, or the business error.
   */
  cancel(): Promise<RemoteResult<{ accepted: true }>>
  /**
   * Rename this session (explicit user title; pins it against automatic
   * regeneration).
   * @param title - raw title text (the host normalizes acceptance).
   * @returns the normalized accepted title and its event seq, or the business error.
   */
  rename(title: string): Promise<RemoteResult<{ title: string; seq: number }>>
  /**
   * Extend the history window backwards (older messages pagination).
   * @returns completion; failures land in snapshot.openState/loadingOlder.
   */
  loadOlder(): Promise<void>
  /**
   * Page history backwards until the window covers `seq` (inclusive) — the
   * turn-jump loader. Repeated calls while a jump is paging lower its shared
   * target and return the in-flight completion; `snapshot.loadingOlder` is
   * the busy signal for the whole jump.
   * @param seq - durable event seq the window must reach (a turn's `turn/start` seq).
   * @returns completion once covered, exhausted, superseded, or failed soft.
   */
  loadThrough(seq: number): Promise<void>
  /**
   * Execute one slash-command line against this session's agent — pure
   * admission semantics (the host executor durably logs the lifecycle).
   * @param line - the full command line, leading slash included.
   * @returns the admission result, or the Remote face's error branch.
   */
  command(line: string): Promise<RemoteResult<{ matched: boolean }>>
}

/**
 * The full outward face: behavior verbs plus the Session lifecycle read side
 * (the `useSession` hook source). This is the type carried by
 * `SessionBinding.session` and the provide channel.
 */
export type SessionFace = ISession & ObservableSnapshot<SessionSnapshot>
