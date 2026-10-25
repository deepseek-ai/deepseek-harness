/** Root-Session aliases restored independently of subagent execution. @module */

import { z } from 'zod'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

/** One immutable full name bound to an accepted child identity. */
export interface SubagentNameBinding {
  readonly childId: SessionId
  readonly name: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A root-owned alias for an accepted subagent identity.
     * @param data - versioned child identity and complete name.
     */
    'subagent-name/bound': SubagentNameBinding & { readonly version: 1 }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    subagentNames: SubagentNameBinding[]
  }
}

/** Requested sibling names use one lower-case path segment. */
export const nameSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/)

/** Bound paths include the root prefix and may include an unnamed parent's id. */
export const fullNameSchema = z.string().startsWith('lead/').min(6)

const bindingSchema = z.object({ childId: z.string().transform(SessionId), name: fullNameSchema }).strict()
const boundSchema = bindingSchema.extend({ version: z.literal(1) })
const bindingsSchema = z.array(bindingSchema).refine(
  bindings => new Set(bindings.map(binding => binding.childId)).size === bindings.length
    && new Set(bindings.map(binding => binding.name)).size === bindings.length,
  'child identities and names must each be unique',
)
const stateSchema = z.object({
  inheritedEventCount: z.number().int().nonnegative().transform(SessionLogOffset),
  bindings: bindingsSchema,
}).strict()

/** Recoverable root aliases, excluding inherited fork records. */
export type SubagentNamesState = z.infer<typeof stateSchema>

/** Alias recovery does not start agents or read other Sessions. */
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
      const previous = state.bindings.find(entry => entry.childId === binding.childId || entry.name === binding.name)
      if (previous !== undefined) {
        if (previous.name !== binding.name || previous.childId !== binding.childId) throw new Error('subagent names and identities must have one immutable binding')
        return state
      }
      return { ...state, bindings: [...state.bindings, binding] }
    }
    return state
  },
  wire: { viewSchema: z.array(bindingSchema), view: (state: SubagentNamesState) => state.bindings },
} satisfies ProjectionDefinition<'subagentNames', SubagentNamesState>
