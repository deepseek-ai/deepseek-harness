/** Host-wide removal of every ended task, as the management page's one action reports it. */
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { ScheduleDeleteInactiveResult } from '@deepseek-ai/dsh-schedule/client'

/** How one bulk removal settled; the wiring reports it as an app-wide notice. */
export type ClearEndedOutcome =
  | { readonly cleared: true; readonly count: number }
  | { readonly cleared: false }

/** Remote removal and the authoritative readback that follows it. */
export interface ClearEndedDependencies {
  /** Ask the Host to remove every ended task; it answers how many rows it removed. */
  readonly removeInactive: () => Promise<RemoteResult<ScheduleDeleteInactiveResult>>
  /**
   * Read the catalog again, naming the newest request ordinal so a read sent
   * before the removal is superseded rather than reused.
   * @returns resolution after the read result is published.
   */
  readonly refresh: () => Promise<void>
}

/**
 * Create the management page's bulk removal callback.
 *
 * The call names no task ids: the Host owns which rows are ended, and a
 * delivery can have moved the catalog between the confirmation and the
 * request. The readback follows the acknowledged removal and supersedes a read
 * issued before it, so the list follows the removal rather than a stale read.
 * @param deps - Remote removal and its catalog readback.
 * @returns a callback that resolves once the settled outcome is available.
 */
export function createClearEnded(deps: ClearEndedDependencies): () => Promise<ClearEndedOutcome> {
  return async () => {
    let result: RemoteResult<ScheduleDeleteInactiveResult>
    try {
      result = await deps.removeInactive()
    } catch (_error: unknown) {
      // A rejected request does not establish which rows changed.
      return { cleared: false }
    }
    if (!result.ok) return { cleared: false }
    await deps.refresh()
    return { cleared: true, count: result.value.deleted }
  }
}
