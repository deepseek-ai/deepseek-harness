/**
 * One Session's scheduled-task state for its header, Sidebar row mark, and hover card.
 *
 * These views project the Host catalog the page already owns — `schedule/catalog()`
 * returns every Host task with its target and involved Sessions — so N
 * visible rows share one Remote read and follow one `schedule/changed`
 * invalidation instead of issuing a query per row or header.
 */

import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule/client'
import { taskInvolvesSession } from './task-record.ts'
import type { CatalogSnapshot } from './catalog-source.ts'

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
 * `schedule/catalog()` returns every Host task in every lifecycle state, so
 * both facts come from this one snapshot filtered to the tasks that target or
 * involve the Session with `status === 'active'`. A read that never settled
 * answers no active task; a refresh republishes `loading` over the records of
 * the last successful read, and the Host emits `schedule/changed` after every
 * delivery, so following `status` here would blank a Session's mark for each
 * roundtrip. A Session whose tasks are all paused or ended lists nothing.
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
    record => taskInvolvesSession(record, sessionId) && record.status === 'active',
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
