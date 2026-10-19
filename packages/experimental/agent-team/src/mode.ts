/** Durable Team enablement, including Sessions created before the mode selector. */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { TeamModeProjection } from './types.ts'

/** Null means no Session-specific selection or historical task exists. */
export interface TeamModeState {
  readonly enabled: boolean | null
}

type ModeDefinition = ProjectionDefinition<'agentTeamMode', TeamModeState>

/**
 * Create the mode projection using the deployment's initial selection.
 * @param enabledByDefault - initial mode for Sessions without a saved selection or task.
 * @returns the projection definition; historical task boards stay enabled until explicitly disabled.
 */
export function teamModeProjection(enabledByDefault: boolean): ModeDefinition & { wire: NonNullable<ModeDefinition['wire']> } {
  const on = { enabled: true }
  const off = { enabled: false }
  const selectionSchema = z.object({ enabled: z.boolean() }).strict()
  return {
    key: 'agentTeamMode',
    stateVersion: 1,
    stateSchema: z.object({ enabled: z.boolean().nullable() }).strict(),
    init: () => ({ enabled: null }),
    apply: (state, event) => {
      if (event.type === 'team/mode') return selectionSchema.parse(event.data)
      if (state.enabled === null && event.type === 'team/task') return { enabled: true }
      return state
    },
    wire: {
      viewSchema: selectionSchema,
      view: (state): TeamModeProjection => (state.enabled ?? enabledByDefault) ? on : off,
    },
  } satisfies ProjectionDefinition<'agentTeamMode', TeamModeState>
}
