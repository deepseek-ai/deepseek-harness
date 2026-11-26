/** Footer choices the Statistics table remembers beyond one mount. */

import type { ContextMode } from './stats-aggregate.ts'

/** Expand-all default for turns: the newest turn only, all turns, or none. */
export type ViewMode = 'newest' | 'all' | 'none'

/** Footer choices that survive a tab switch, a Session change, and a reload. */
export interface StatsPreferences {
  /** Expand-all default for turns. */
  readonly mode: ViewMode
  /** The totals row. */
  readonly showTotals: boolean
  /** Non-step event rows. */
  readonly showEvents: boolean
  /** Per-turn and per-step context deltas. */
  readonly showContextDelta: boolean
  /** Whether a turn row aggregates its steps' latest or cumulative prompt size. */
  readonly contextMode: ContextMode
}
