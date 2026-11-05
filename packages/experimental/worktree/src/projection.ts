/** The `worktree` projection: every checkout this service recorded creating for a Session, and which of them the Session created itself. */

import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { CreatedWorktree, WorktreeCreation } from './types.ts'

/** Plugin record type of a checkout this service created for the Session, written after the Session entered it. */
export const CREATED_RECORD = 'plugin:worktree/created'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** A checkout the worktree service created for the Session, which entered it in the same operation. */
    'plugin:worktree/created': CreatedWorktree
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Checkouts recorded in the Session's log, in creation order. */
    worktree: readonly WorktreeCreation[]
  }
}

/** Host state of the `worktree` unit: creations so far and the fork boundary that decides ownership. */
export interface WorktreeProjectionState {
  readonly created: readonly WorktreeCreation[]
  readonly inheritedEventCount: number
}

/** Validates a `plugin:worktree/created` payload; a reader of the record applies it before trusting the data. */
export const createdWorktreeSchema: z.ZodType<CreatedWorktree> = z.object({
  path: z.string().min(1),
  branch: z.string().min(1),
  baseCommit: z.string().min(1),
  repositoryRoot: z.string().min(1),
}).strict()

const creationSchema: z.ZodType<WorktreeCreation> = z.object({
  worktree: createdWorktreeSchema,
  owned: z.boolean(),
}).strict()

const stateSchema: z.ZodType<WorktreeProjectionState> = z.object({
  created: z.array(creationSchema),
  inheritedEventCount: z.number().int().nonnegative(),
}).strict()

/**
 * Fold `plugin:worktree/created` records; a record whose payload fails
 * validation is skipped, as a restored record carries whatever an earlier
 * build wrote. A creation whose seq lies inside the fork-inherited prefix is a
 * reference the fork carries, not a checkout it created, so `owned` is false
 * there and true for the Session's own records.
 */
export const worktreeProjection = {
  key: 'worktree',
  stateVersion: 1,
  stateSchema,
  init: (_header, inheritedEventCount) => ({ created: [], inheritedEventCount }),
  apply: (state, event: SessionEvent) => {
    const record = pluginRecordOf(event)
    if (record?.type !== CREATED_RECORD) return state
    const parsed = createdWorktreeSchema.safeParse(record.data)
    if (!parsed.success) return state
    return { ...state, created: [...state.created, { worktree: parsed.data, owned: record.seq >= state.inheritedEventCount }] }
  },
  wire: { viewSchema: z.array(creationSchema), view: state => state.created },
} satisfies ProjectionDefinition<'worktree', WorktreeProjectionState>
