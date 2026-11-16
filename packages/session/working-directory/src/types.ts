/**
 * Import-free type declarations of the `workingDirectory` Session projection, for Client programs that read it.
 * @module @deepseek-ai/dsh-working-directory/types
 */

import type {} from '@deepseek-ai/dsh-session-projection/types'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Recorded directory of the Session for observations, or null when none is recorded. */
    workingDirectory: string | null
  }
}
