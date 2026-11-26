/** Browser-wide Statistics table preferences, shared by every Session and View instance. */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { StatsPreferences } from './stats-preferences-contract.ts'

export type { StatsPreferences, ViewMode } from './stats-preferences-contract.ts'

/**
 * Create the persisted preferences of the Statistics table.
 * @returns A store that rehydrates the stored choices while it is constructed.
 */
export function createStatsPreferences(): SnapshotStore<StatsPreferences> {
  return createSnapshotStore<StatsPreferences>({
    mode: 'newest',
    showTotals: false,
    showEvents: false,
    showContextDelta: false,
    contextMode: 'latest',
  }, { persist: { name: 'dsh.stats.preferences' } })
}
