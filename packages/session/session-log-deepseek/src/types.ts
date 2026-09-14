/** Wire types for lossless incremental DeepSeek session-log upload. */

import type { SessionEvent, SurfaceEventType } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Session header fields serialized as raw JSON primitives on the external request wire. */
export interface DeepSeekSessionLogWireHeader {
  readonly version: number
  readonly id: string
  readonly createdAt: number
  readonly cwd?: string
  readonly parentSession?: string
  /** Exact inherited prefix length; absent for an unseeded Session. */
  readonly seedLength?: number
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
  readonly agentPreset?: string
}

/** Raw-number surface mutation serialized on the external request wire. */
export type DeepSeekSessionLogWireSurfaceOp =
  | 'append'
  | { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number }

/**
 * One canonical event translated to raw JSON primitives for upload. Surface
 * events require an operation; system, user, and tool events may cite sources.
 * Assistant provider metadata is embedded in its data; log-only events carry neither field.
 */
export type DeepSeekSessionLogWireEvent = {
  [K in SessionEvent['type']]: {
    readonly type: K
    readonly seq: number
    readonly time: number
    readonly data: JsonValue
    readonly ignorable?: true
  } & (K extends SurfaceEventType ? {
    readonly surfaceOp: DeepSeekSessionLogWireSurfaceOp
  } & (K extends 'assistant/message' ? {
    readonly sourceEventSeqs?: never
  } : {
    readonly sourceEventSeqs?: readonly number[]
  }) : {
    readonly surfaceOp?: never
    readonly sourceEventSeqs?: never
  })
}[SessionEvent['type']] | {
  /** Unrecognized ignorable records retain opaque metadata without surface semantics. */
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: JsonValue
  readonly ignorable: true
  readonly surfaceOp?: JsonValue
  readonly sourceEventSeqs?: JsonValue
}

/** Versioned incremental session-log field carried by an official DeepSeek request. */
export interface DeepSeekSessionLogExtension {
  readonly version: 1
  /** Session format generation represented by this suffix. */
  readonly sessionFormatVersion: number
  readonly session: DeepSeekSessionLogWireHeader
  /** Highest sequence durably recorded as accepted before this request, or `-1`. */
  readonly afterSeq: number
  /** Highest sequence represented by {@link events}. */
  readonly throughSeq: number
  /** Complete canonical event envelopes for every sequence from `afterSeq + 1` through `throughSeq`. */
  readonly events: readonly DeepSeekSessionLogWireEvent[]
}

declare module '@deepseek-ai/dsh-deepseek-llm-api-extensions/types' {
  interface DeepSeekLlmApiExtensionMap {
    dsh_session_log: DeepSeekSessionLogExtension
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Records that the configured endpoint accepted one delivery through `throughSeq`. */
    'session-log-deepseek/delivery-accepted': {
      /** Session identity the accepted delivery carried; inherited fork markers retain the parent's id. */
      sessionId: import('@deepseek-ai/dsh-session/types').SessionId
      /** Accepted Session format generation; absence identifies version 0. */
      sessionFormatVersion?: number
      /** Last canonical event included in the accepted request. */
      throughSeq: import('@deepseek-ai/dsh-session/types').SessionSeq
    }
  }
}
