/**
 * Type-level contract of the Session summary projection values: the list row
 * carries every view value except the units that declare `summary: false`,
 * while an opened Session's full projection snapshot keeps all of them.
 */

import { describe, expect, it } from 'vitest'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/types'
import type {} from '@deepseek-ai/dsh-session-stats/types'
import type {} from '@deepseek-ai/dsh-session-turn-outline/types'
import type { SessionSummary } from '../src/client/sessions/service.ts'
import type { SessionProjectionSnapshot } from '../src/client/sessions/manager.ts'

/**
 * Compile-time contract, never called: each `@ts-expect-error` fails the
 * typecheck gate if a summary value type ever regains an excluded key.
 * @param summary - a Host list row summary.
 * @param full - an opened Session's complete projection snapshot.
 */
function contract(summary: SessionSummary, full: SessionProjectionSnapshot): void {
  // @ts-expect-error turnOutline is excluded from Session summary values
  void summary.projectionValues?.turnOutline
  // @ts-expect-error sessionStats is excluded from Session summary values
  void summary.projectionValues?.sessionStats
  // @ts-expect-error todos is excluded from Session summary values
  void summary.projectionValues?.todos
  // @ts-expect-error imageLimits is excluded from Session summary values
  void summary.projectionValues?.imageLimits

  // Included keys stay readable, and the full snapshot keeps the excluded ones
  // (with `todos` still nullable).
  const title: string | null | undefined = summary.projectionValues?.title
  const outline: readonly unknown[] | undefined = full.values.turnOutline
  const todos: readonly TodoItem[] | null | undefined = full.values.todos
  const limits = full.values.imageLimits
  void [title, outline, todos, limits]
}

describe('session summary projection types', () => {
  it('declares the excluded keys on the list row type only through the full snapshot', () => {
    expect(contract).toBeTypeOf('function')
  })
})
