/**
 * Host-only Session projection of the route that produced the latest assistant message.
 *
 * @module @deepseek-ai/dsh-compaction-basic/answered-route
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

/** Provider/model pair recorded on the latest assistant message; `null` before the first one. */
export type AnsweredRoute = { provider: string; model: string } | null

/**
 * Fold of every `assistant/message` source. A request that ends without an
 * assistant message, such as one the provider rejects, leaves the state unchanged.
 */
export const answeredRouteProjectionDefinition = {
  key: 'compactionAnsweredRoute',
  stateVersion: 1,
  stateSchema: z.object({ provider: z.string(), model: z.string() }).strict().nullable(),
  init: (): AnsweredRoute => null,
  apply: (state, event) => {
    if (event.type !== 'assistant/message') return state
    const { provider, model } = event.data.message.source
    return state?.provider === provider && state.model === model ? state : { provider, model }
  },
} satisfies ProjectionDefinition<'compactionAnsweredRoute', AnsweredRoute>
