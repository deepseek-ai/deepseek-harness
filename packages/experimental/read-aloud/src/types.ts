/** JSON-safe inputs and results of the experimental read-aloud Remote namespace. */
import type { MessageId } from '@deepseek-ai/dsh-llm/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SynthesisFailureCode } from '@deepseek-ai/dsh-text-to-speech/types'
import type {} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The Session holds no assistant message with the requested identity. */
    'readAloud/message-not-found': { readonly reason: string }
    /** The requested range is no segment of the message under the current configuration; a new plan resolves it. */
    'readAloud/stale-plan': { readonly reason: string }
    /** Synthesis did not complete; `code` is present when the provider classified the failure. */
    'readAloud/synthesis-failed': { readonly reason: string; readonly code?: SynthesisFailureCode }
  }
}

/**
 * Whether a reading can start now. `sign-in-required`: neither a DeepSeek account sign-in nor a DeepSeek API key is
 * available. `unavailable`: the configured provider is not registered or its settings do not resolve.
 */
export interface ReadAloudStatus {
  readonly state: 'ready' | 'sign-in-required' | 'unavailable'
}

/** One finalized assistant message. */
export interface ReadingTarget {
  readonly sessionId: SessionId
  readonly messageId: MessageId
}

/** A half-open range of UTF-16 code units in the message's read-aloud text; one synthesis request speaks it. */
export interface ReadingSegment {
  readonly start: number
  readonly end: number
}

/** How to read one message: its position in the Session log, its segments, and the pacing and audio facts. */
export interface ReadingPlan {
  /** Session event sequence number of the message; `synthesize` reads the message there. */
  readonly seq: number
  /** Segments in reading order; empty when the message holds no readable text. */
  readonly segments: readonly ReadingSegment[]
  /** The next segment is requested once this many milliseconds of received audio, or fewer, remain unplayed. */
  readonly dispatchBelowMs: number
  /** Samples per second of the 16-bit mono PCM that `synthesize` streams. */
  readonly sampleRate: number
}

/** One segment of a plan. */
export interface SegmentRequest extends ReadingTarget, ReadingSegment {
  /** `ReadingPlan.seq` of the plan the segment came from. */
  readonly seq: number
}

/** A run of whole 16-bit little-endian mono PCM samples. */
export interface AudioFrame {
  /** Base64 of the samples. */
  readonly pcm: string
}
