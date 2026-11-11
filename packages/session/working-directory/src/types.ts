/**
 * Pure types of the working-directory domain: the one home of the
 * `workingDirectory` and `workingDirectoryHistory` projection-key
 * declarations, free of this package's host-side value imports. `./client`
 * projects them to client aggregates.
 *
 * @module @deepseek-ai/dsh-working-directory/types
 */

import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionSummaryExcluded } from '@deepseek-ai/dsh-session-projection/types'

/** One effective directory and the log position from which it applies. */
export interface WorkingDirectoryHistoryEntry {
  /** Seq of the `working-directory/change` that selected `cwd`; `0` for the header directory. */
  readonly seq: SessionSeq
  /** Absolute directory used by events after `seq` until the next entry. */
  readonly cwd: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Recorded current directory for Session observations, or null when none is recorded. */
    workingDirectory: string | null
    /**
     * Every effective directory in ascending seq order: the header directory at
     * seq `0`, then one entry per `working-directory/change`. A path recorded by
     * an event resolves against the last entry whose seq is lower than that
     * event's. Excluded from Session summary payloads: it grows with directory
     * changes and no list row renders it.
     */
    workingDirectoryHistory: SessionProjectionSummaryExcluded<readonly WorkingDirectoryHistoryEntry[]>
  }
}
