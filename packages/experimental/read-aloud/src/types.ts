/** JSON-safe inputs and results of the experimental read-aloud Remote namespace. */
import type { MessageId } from '@deepseek-ai/dsh-llm/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SynthesisFailureCode } from '@deepseek-ai/dsh-text-to-speech/types'
import type {} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The Session holds no assistant message with the requested identity. */
    'readAloud/message-not-found': { readonly reason: string }
    /**
     * The requested range is no segment of the message, or the provider no longer offers the plan's voice, under the
     * current configuration; a new plan resolves it.
     */
    'readAloud/stale-plan': { readonly reason: string }
    /** Synthesis did not complete; `code` is present when the provider classified the failure. */
    'readAloud/synthesis-failed': { readonly reason: string; readonly code?: SynthesisFailureCode }
  }
}

/**
 * Whether a reading can start now, and the voices to choose from. `sign-in-required`: neither a DeepSeek account
 * sign-in nor a DeepSeek API key is available. `unavailable`: the configured provider is not registered or its
 * settings do not resolve.
 */
export interface ReadAloudStatus {
  readonly state: 'ready' | 'sign-in-required' | 'unavailable'
  /** Voices and audio rate of the configured provider; absent while it is not registered. */
  readonly synthesis?: SynthesisFacts
}

/** What the configured provider speaks with. */
export interface SynthesisFacts {
  /** Voice ids in menu order; never empty. */
  readonly voices: readonly string[]
  /** Voice a reading started now uses; one of `voices`. */
  readonly voice: string
  /** Samples per second of the 16-bit mono PCM that `synthesize` and `sample` stream. */
  readonly sampleRate: number
}

/** The saved voice preference; `voice` is one of `SynthesisFacts.voices`. */
export interface VoiceSelection {
  readonly voice: string
}

/** One audition of a voice. */
export interface SampleRequest {
  /** One of `SynthesisFacts.voices`. */
  readonly voice: string
  /** Language of the Host's sample sentence, such as `zh`; a language without one hears the English sentence. */
  readonly language: string
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
  /** Voice that speaks every segment of this reading, fixed when the plan is made. */
  readonly voice: string
}

/** One segment of a plan. */
export interface SegmentRequest extends ReadingTarget, ReadingSegment {
  /** `ReadingPlan.seq` of the plan the segment came from. */
  readonly seq: number
  /** `ReadingPlan.voice` of that plan. */
  readonly voice: string
}

/** A run of whole 16-bit little-endian mono PCM samples. */
export interface AudioFrame {
  /** Base64 of the samples. */
  readonly pcm: string
}
