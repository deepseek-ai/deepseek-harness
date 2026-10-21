/**
 * Pure types of the todo domain: the ONE home of the `todos` projection-key
 * declaration plus its payload types, free of this package's host-side value
 * imports (dsh-tools, zod). Two namespace projections serve it — `./types`
 * for host consumers, `./client/types` (the browser half-entry's re-export)
 * for client aggregates — with zero content duplication.
 *
 * @module @deepseek-ai/dsh-tool-todo/types
 */

import type { SessionProjectionSummaryExcluded } from '@deepseek-ai/dsh-session-projection/types'

/**
 * One entry in an agent's todo list — the unit of the `todo/write`
 * whole-list snapshot declared by this package.
 *
 * Deliberately minimal: a human-readable `content` line and a three-state
 * `status`. No id, priority, or `activeForm` — the list is replaced wholesale
 * on every write (last-write-wins), so entries need no stable identity. The
 * three statuses describe the complete portable lifecycle needed by model and
 * UI consumers.
 */
export interface TodoItem {
  /** What this task is — a short imperative line shown in the UI. */
  content: string
  /** Lifecycle state. `in_progress` marks a task being worked now; parallel work may mark several. */
  status: 'pending' | 'in_progress' | 'completed'
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Whole-list snapshot; latest write wins on replay. Log-only UI state; never derived history. */
    'todo/write': { todos: TodoItem[] }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The agent's current whole todo list (the latest `todo/write` snapshot),
     * or `null` before the first write. Whole-value rule: every `todo/write`
     * carries the complete replacement list, so the fold is last-wins.
     * Excluded from Session summary payloads, with `null` kept outside the
     * exclusion mark so the pre-first-write value stays expressible.
     */
    todos: SessionProjectionSummaryExcluded<TodoItem[]> | null
  }
}
