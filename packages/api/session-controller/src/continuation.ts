/** Constant-size continuation eligibility over the complete durable Session. */
import type {} from './types.ts'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { brandNumber } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'

// Explicit manual requests use a fixed product policy, independent of automatic retry configuration.
const CONTINUABLE_FAILURES: ReadonlySet<string> = new Set([
  'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE', 'STREAM_CLOSED',
])

const endingSchema = z.number().int().nonnegative().transform(brandNumber<SessionSeq>).nullable()
const stateSchema = z.object({
  admitted: z.boolean(),
  failedAttempt: z.boolean(),
  ending: endingSchema,
})

/** Recoverable manual-continuation facts over admitted user input and empty retry messages. */
export type ContinuationState = z.infer<typeof stateSchema>

const EMPTY: ContinuationState = { admitted: false, failedAttempt: false, ending: null }

/** Eligibility requires admitted human work and a failed settlement in the last request step. */
export const continuationProjectionDefinition = {
  key: 'conversationContinuation',
  stateVersion: 4,
  stateSchema,
  init: (): ContinuationState => EMPTY,
  apply: (state, event) => {
    switch (event.type) {
      case 'turn/start':
        return EMPTY
      case 'step/start':
      case 'assistant/message':
        return state.failedAttempt ? { ...state, failedAttempt: false } : state
      case 'user/message':
        return !state.admitted && event.surfaceOp === 'append'
          && ((event.data.source.kind === 'user' && event.data.content.length > 0)
            || (event.data.source.kind === 'retry' && event.data.content.length === 0))
          ? { ...state, admitted: true } : state
      case 'assistant/attempt':
        return state.failedAttempt ? state : { ...state, failedAttempt: true }
      case 'turn/end': {
        const ending = event.data.reason.kind === 'error' && CONTINUABLE_FAILURES.has(event.data.reason.error.code)
          && state.admitted && state.failedAttempt ? event.seq : null
        return ending === null ? EMPTY : { ...EMPTY, ending }
      }
      default:
        return state
    }
  },
  wire: {
    viewSchema: endingSchema,
    view: (state: ContinuationState) => state.ending,
  },
} satisfies ProjectionDefinition<'conversationContinuation', ContinuationState>
