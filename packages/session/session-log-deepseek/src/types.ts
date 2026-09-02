/** Wire types for lossless incremental DeepSeek session-log upload. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Version-0 Session header fields serialized on the external request wire. */
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
  | { readonly op: 'replace'; readonly start: number; readonly end: number }

/** One complete canonical event translated to raw JSON primitives for upload. */
export interface DeepSeekSessionLogWireEvent {
  readonly type: SessionEvent['type']
  readonly seq: number
  readonly time: number
  readonly data: JsonValue
  readonly ignorable?: true
  readonly sourceEventSeqs?: readonly number[]
  readonly surfaceOp?: DeepSeekSessionLogWireSurfaceOp
}

/** Versioned incremental session-log field carried by an official DeepSeek request. */
export interface DeepSeekSessionLogExtension {
  readonly version: 1
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
      /** Last canonical event included in the accepted request. */
      throughSeq: import('@deepseek-ai/dsh-session/types').SessionSeq
    }
  }
}
