/**
 * The host's definition registry as this page last read it, owned by the
 * plugin's apply closure.
 *
 * The panel is a frame-wide surface, so it cannot derive this from any session:
 * the registry is global and the read is a single global call. The rows are
 * re-read rather than patched, because the wire announcements
 * (`cordis/dynamic-package` / `/retract`) carry no labels and a definition
 * can appear or disappear between them — a patch-in-place cache would drift into
 * showing definitions the host no longer holds.
 *
 * Reads are single-flight: several announcements settling at once, or a badge
 * opening while a reconnect re-reads, must not multiply the call. Single-flight
 * alone would be wrong across a reconnect, though — the in-flight read belongs to
 * the previous connection, so a reset both discards its answer and frees the slot
 * for a fresh one. Without that, a reconnect either loses its re-read to the old
 * call or has the old host's rows published on top of it.
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { CordisDynamicPort, CordisInventoryRow } from './dynamic-port.ts'
import type { CordisDynamicPluginId } from './events.ts'

/** What the panel reads: the rows, and whether the first read has happened. */
export interface CordisInventorySnapshot {
  readonly rows: readonly CordisInventoryRow[]
  /** Plugins explicitly removed through this page, retained for historical cards. */
  readonly removed: ReadonlySet<CordisDynamicPluginId>
  /**
   * False until a read settles. The panel shows a loading line rather than an
   * empty state, so "nothing defined yet" is never claimed before it is known.
   */
  readonly read: boolean
  /** Last read failure, so the panel can say why it is empty. */
  readonly error?: string | undefined
}

/** Inventory source: an observable of the rows plus the read trigger. */
export interface CordisInventory extends HostObservable<CordisInventorySnapshot> {
  /** Read the registry unless a read is already in flight. */
  refresh(): void
  /** Record an explicit remove and drop the live row immediately. */
  retire(pluginId: CordisDynamicPluginId): void
  /** Drop what was read; the next refresh starts from nothing (a reconnect may be a new host). */
  reset(): void
}

/**
 * Create the inventory source.
 * @param port - the RPC seam the read goes through.
 * @param onError - reporter for a failed read (console in production, captured in specs).
 * @returns the inventory observable and its read trigger.
 */
export function createCordisInventory(
  port: CordisDynamicPort,
  onError: (error: unknown) => void,
): CordisInventory {
  const listeners = new Set<() => void>()
  let snapshot: CordisInventorySnapshot = { rows: [], removed: new Set(), read: false }
  let inFlight: Promise<void> | undefined
  // Bumped by reset; a read whose generation is stale publishes nothing.
  let generation = 0

  const publish = (next: CordisInventorySnapshot): void => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    refresh: () => {
      if (inFlight !== undefined) return
      const issued = generation
      inFlight = port.inventory().then(
        (rows) => {
          if (issued !== generation) return
          const removed = new Set(snapshot.removed)
          const live = new Set(rows.map(row => row.pluginId))
          for (const previous of snapshot.rows) {
            if (!live.has(previous.pluginId)) removed.add(previous.pluginId)
          }
          publish({ rows, removed, read: true })
        },
        (error: unknown) => {
          if (issued !== generation) return
          onError(error)
          // A failed read keeps whatever was shown and says why: dropping the
          // rows would turn a transient wire failure into "nothing is defined".
          publish({
            rows: snapshot.rows,
            removed: snapshot.removed,
            read: snapshot.read,
            error: error instanceof Error ? error.message : 'reading the cordis inventory failed',
          })
        },
      ).then(() => { if (issued === generation) inFlight = undefined })
    },
    retire: (pluginId) => {
      const removed = new Set(snapshot.removed)
      removed.add(pluginId)
      publish({ ...snapshot, rows: snapshot.rows.filter(row => row.pluginId !== pluginId), removed })
    },
    reset: () => {
      generation += 1
      inFlight = undefined
      publish({ rows: [], removed: snapshot.removed, read: false })
    },
  }
}
