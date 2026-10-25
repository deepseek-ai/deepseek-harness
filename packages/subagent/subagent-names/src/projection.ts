/** Parent-owned alias candidates; the subagent catalog establishes usable membership. @module */

import { z } from 'zod'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

/** One immutable sibling name requested for a child identity. */
export interface SubagentNameBinding {
  readonly childId: SessionId
  readonly name: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A name candidate, usable only while the parent catalog contains its child.
     * @param data - versioned child identity and sibling name.
     */
    'subagent-name/bound': SubagentNameBinding & { readonly version: 1 }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    subagentNames: SubagentNameBinding[]
  }
}

/** Names use one lower-case path segment; legacy ids have a separate prefix. */
export const nameSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/)

const bindingSchema = z.object({ childId: z.string().transform(SessionId), name: nameSchema }).strict()
const boundSchema = bindingSchema.extend({ version: z.literal(1) })
const bindingsSchema = z.array(bindingSchema).refine(
  bindings => new Set(bindings.map(binding => binding.childId)).size === bindings.length,
  'each child identity must have one name binding',
)
const stateSchema = z.object({
  inheritedEventCount: z.number().int().nonnegative().transform(SessionLogOffset),
  bindings: bindingsSchema,
}).strict()

/** Recoverable direct-parent alias candidates, excluding inherited fork records. */
export type SubagentNamesState = z.infer<typeof stateSchema>

/** Alias recovery is pure; catalog membership is checked when a name is read. */
export const subagentNamesProjection = {
  key: 'subagentNames',
  stateVersion: 1,
  stateSchema,
  init: (_header: SessionHeader, inheritedEventCount: SessionLogOffset): SubagentNamesState => ({
    inheritedEventCount, bindings: [],
  }),
  apply(state: SubagentNamesState, event: SessionEvent): SubagentNamesState {
    if (event.seq < state.inheritedEventCount) return state
    if (event.type === 'subagent-name/bound') {
      const { version: _version, ...binding } = boundSchema.parse(event.data)
      const previous = state.bindings.find(entry => entry.childId === binding.childId)
      if (previous !== undefined) {
        if (previous.name !== binding.name) throw new Error(`subagent name for ${binding.childId} is immutable`)
        return state
      }
      return { ...state, bindings: [...state.bindings, binding] }
    }
    return state
  },
  wire: { viewSchema: z.array(bindingSchema), view: (state: SubagentNamesState) => state.bindings },
} satisfies ProjectionDefinition<'subagentNames', SubagentNamesState>
