/** Session-owned observable state excluding Conversation target data. */
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionRequestId } from '../../types.ts'

/** One transient inbox occurrence from the authoritative queue snapshot. */
export interface QueuedMessage {
  readonly id: MessageId
  readonly messageId: MessageId
  readonly placement: 'queued' | 'steering' | 'context'
  /** Prompt-RPC identity of a browser-submitted occurrence; correlates the local submission echo. */
  readonly rpcId?: SessionRequestId
  readonly content: readonly ContentBlock[]
  readonly preview: string
  readonly text: string | null
}

/** One image displayed by a local submission echo before durable admission. */
export interface PendingSubmissionImage {
  /** Browser-owned preview URL; its lifecycle belongs to the submitter, never this snapshot. */
  readonly previewUrl: string
  /** Browser file name, when the file had one. */
  readonly name?: string
  /** Intrinsic pixel width, when the submitter has probed it. */
  readonly width?: number
  /** Intrinsic pixel height, when the submitter has probed it. */
  readonly height?: number
}

/** Image branch of a local submission echo attachment. */
export interface PendingSubmissionImageAttachment {
  readonly type: 'image'
  readonly value: PendingSubmissionImage
}

/** File branch of a local submission echo attachment. */
export interface PendingSubmissionFileAttachment {
  readonly type: 'file'
  readonly value: FileAttachmentRef
}

/** One attachment displayed by a local submission echo, in prompt order. */
export type PendingSubmissionAttachment =
  | PendingSubmissionImageAttachment
  | PendingSubmissionFileAttachment

/** Client surface selected when a local submission begins. */
export type PendingSubmissionPlacement = 'transcript' | 'queued' | 'steering'

/**
 * One local prompt-submission echo: inserted synchronously when a submission
 * begins, so the conversation can show the message before serialization,
 * transport, and durable admission complete. Client-memory only — reload and
 * reconnect rebuild the conversation from durable events alone.
 */
export interface PendingSubmission {
  /** The prompt RPC identity; the durable `user/message` source echoes it as `rpcId`. */
  readonly requestId: SessionRequestId
  /** Expected surface until the Host reports the admitted queue or durable occurrence. */
  readonly placement: PendingSubmissionPlacement
  /** Client wall-clock ms when the submission began. */
  readonly time: number
  /** Prompt text exactly as it will be sent (one text block). */
  readonly text: string
  /** Ordered image previews and durable file metadata matching the prompt attachments. */
  readonly attachments: readonly PendingSubmissionAttachment[]
}

/** History-open lifecycle of a Session event window. */
export type OpenState = 'cold' | 'loading' | 'open' | 'error'

/** Send/stop failure surfaced by Session consumers. */
export interface PromptError {
  readonly op: 'send' | 'stop'
  readonly error: RemoteFailure
}

/** Immutable Session lifecycle and control snapshot. */
export interface SessionSnapshot {
  readonly sessionId: SessionId
  readonly queue: readonly QueuedMessage[]
  /** Local prompt-submission echoes not yet observed as durable events or queue occurrences. */
  readonly pendingSubmissions: readonly PendingSubmission[]
  readonly running: boolean
  readonly subagent: {
    readonly address: SubagentAddress
    /** Absent until the direct-parent catalog resolves. */
    readonly parentAvailable?: boolean
  } | null
  readonly removed: boolean
  readonly openState: OpenState
  readonly openError: RemoteFailure | null
  readonly hasMore: boolean
  readonly loadingOlder: boolean
  readonly promptError: PromptError | null
  readonly blank: boolean
  readonly lastAgentError: string | null
  /** A prompt call has begun on this Client Session object. */
  readonly promptAttempted: boolean
  /** The first accepted prompt has not reached a durable `turn/start` event. */
  readonly awaitingFirstTurn: boolean
}
