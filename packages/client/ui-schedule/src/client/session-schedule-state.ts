/**
 * One Session's scheduled-task state for the ambient surfaces: the Sidebar
 * row mark and the row hover-card task section.
 *
 * Both project the ONE Host catalog the page already owns — `schedule/catalog()`
 * returns active and ended tasks with their originating `sessionId` — so N
 * visible rows share one Remote read and follow one `schedule/changed`
 * invalidation instead of issuing a query per row. The Session-header catalog
 * keeps its own per-Session `schedule/list` source because it also lists the
 * open Session's tasks.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createCatalogSource, type CatalogInjected, type CatalogSnapshot } from './catalog-source.ts'

/** Per-Session source factory handed to the Session-header catalog occupant. */
export type SessionScheduleSourceFactory = (sessionId: SessionId) => CatalogInjected

/**
 * Create the durable reminder source for one Session.
 *
 * The stored read is `schedule/list`, which admits only tasks whose durable
 * status is active; loading and error reads carry no authoritative answer.
 * @param ctx - client context carrying the Remote schedule face.
 * @param sessionId - Session whose tasks are read; reading never activates it.
 * @returns observable catalog plus its mutation callbacks.
 */
export function createSessionScheduleSource(
  ctx: ClientContext,
  sessionId: SessionId,
): CatalogInjected {
  return createCatalogSource({
    list: () => ctx.remote.schedule.list({ sessionId }),
    remove: id => ctx.remote.schedule.delete({ sessionId, id }),
    subscribeChanged: listener => ctx.remote.$on('schedule/changed', listener),
    subscribeReset: listener => ctx.on('connection/reset', listener),
  })
}

/** Selector hook the renderer binds from a slot's `hooks.catalog` observable. */
export type SessionScheduleCatalogHook = SnapshotSelectorHook<CatalogSnapshot<ScheduleCatalogEntry>>

/** Shared Host catalog observable an ambient surface injects through its slot. */
export type SessionScheduleCatalogObservable = HostObservable<CatalogSnapshot<ScheduleCatalogEntry>>

/** One Session's active scheduled tasks as projected from the shared Host catalog. */
export interface SessionScheduleFacts {
  /** Whether the settled catalog holds at least one active task for the Session. */
  readonly hasActive: boolean
  /** Active tasks of the Session in catalog order; empty unless the read settled. */
  readonly records: readonly ScheduleCatalogEntry[]
}

const NO_RECORDS: readonly ScheduleCatalogEntry[] = []

/**
 * Project the shared Host catalog onto one Session's active tasks.
 *
 * `schedule/catalog()` returns active and ended tasks for every Session, so
 * both facts come from this one snapshot filtered by `sessionId` and
 * `status === 'active'`. A read that never settled answers no active task; a
 * refresh republishes `loading` over the records of the last successful read, and
 * the Host emits `schedule/changed` after every delivery, so following `status`
 * here would blank a Session's mark for each roundtrip. An ended-only Session
 * lists nothing.
 * @param snapshot - shared Host catalog snapshot.
 * @param sessionId - Session whose facts are selected.
 * @returns this Session's active-task facts.
 */
export function selectSessionScheduleFacts(
  snapshot: CatalogSnapshot<ScheduleCatalogEntry>,
  sessionId: SessionId,
): SessionScheduleFacts {
  if (!snapshot.settled) return { hasActive: false, records: NO_RECORDS }
  const records = snapshot.records.filter(
    record => record.sessionId === sessionId && record.status === 'active',
  )
  return { hasActive: records.length > 0, records }
}

/**
 * Compare two projections so a row keeps its previous render while its own
 * active tasks are unchanged, even when another Session's tasks move.
 * @param left - current projection.
 * @param right - previously selected projection.
 * @returns whether both projections describe the same active tasks.
 */
function sameSessionScheduleFacts(left: SessionScheduleFacts, right: SessionScheduleFacts): boolean {
  return left.hasActive === right.hasActive
    && left.records.length === right.records.length
    && left.records.every((record, index) => record === right.records[index])
}

/**
 * Select one Session's active-task facts from the shared Host catalog.
 * @param useCatalog - selector hook bound to the shared Host catalog observable.
 * @param sessionId - Session whose row is observed; reading activates nothing.
 * @returns this Session's facts, stable across other Sessions' updates.
 */
export function useSessionScheduleFacts(
  useCatalog: SessionScheduleCatalogHook,
  sessionId: SessionId,
): SessionScheduleFacts {
  return useCatalog(
    snapshot => selectSessionScheduleFacts(snapshot, sessionId),
    sameSessionScheduleFacts,
  )
}
