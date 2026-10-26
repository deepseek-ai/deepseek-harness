/** Host-derived eligibility for an explicit generation-continuation message. */
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Eligible latest turn/end, or null while no settled request can be continued. */
    conversationContinuation: SessionSeq | null
  }
}
