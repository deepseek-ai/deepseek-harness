/** Ephemeral result inspection shared by Trajectory's Host and Client. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Live-only tool result inspection; never part of Session history or projections. */
export interface SessionToolResultRequest {
  readonly sessionId: SessionId
  readonly seq: number
}

/** Availability distinguishes missing results from valid JSON null. */
export type SessionToolResultValue =
  | { readonly available: false }
  | { readonly available: true; readonly value: JsonValue }
