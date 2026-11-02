/**
 * Branch facts the owner host publishes for the branch children of a shared Session.
 *
 * These facts are not part of the Session log. Which branches a page may see, and whether each
 * branch's workspace stays read-only for it, come from the fork registry's record of the reader
 * that created the branch, so the owner host publishes them per reader on the projection channel
 * instead of adding fields to the shared Session-summary contract. The `forkLineage` key is
 * declared here through the merge-extensible projection table; the viewer's read path
 * (`host/viewer-read.ts`) is the only producer, and a client reads the value back from a session
 * list row's projection values.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/src/fork-lineage
 */

// Loads the projection package's type namespace, which the augmentation below merges into; the
// `/types` outlet it augments is reached through that package, never through its host runtime.
import type {} from '@deepseek-ai/dsh-session-projection'

/** Projection key carrying {@link ForkLineage} for one session list row. */
export const FORK_LINEAGE_KEY = 'forkLineage'

/**
 * Branch facts one reader was given for one branch of a shared Session.
 *
 * Presence of the value is what marks a Session as a branch: a Session the reader was not given
 * carries no `forkLineage` value at all.
 */
export interface ForkLineage {
  /** How the Session came to exist; only `fork` is published under this key. */
  readonly origin: 'fork'
  /** Session the branch was cut from. */
  readonly sourceSessionId: string
  /** True when the reader created the branch it is reading. */
  readonly authoredByViewer: boolean
  /** True when the branch's workspace stays read-only for its reader. */
  readonly workspaceReadOnly: boolean
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Branch facts one reader was given for a branch of a shared Session. */
    forkLineage: ForkLineage
  }
}

/**
 * Branch facts a reader was given for the branch cut from one Session.
 *
 * A reader reaches a branch only through the share it created it from, so the facts are the same
 * for every branch it is shown: the reader authored it, and its workspace stays read-only.
 * @param sourceSessionId - Session the branch was cut from.
 * @returns The value to publish under {@link FORK_LINEAGE_KEY}.
 */
export function forkLineageValue(sourceSessionId: string): ForkLineage {
  return {
    origin: 'fork',
    sourceSessionId,
    authoredByViewer: true,
    workspaceReadOnly: true,
  }
}
