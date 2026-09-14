/**
 * Heuristic composition of the current retained surface, independent of route
 * image pricing and provider usage. Positional entries preserve system-prompt
 * classification across replacements without retaining historical messages.
 */

import { z } from 'zod'
import { canonicalHeader, isSurfaceEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { estimateToolsTokens } from './estimate.ts'
import { commitSurfaceTokens, planSurfaceTokens } from './surface-fold.ts'
// Import for the `contextBreakdown` SessionProjectionStateMap key merge.
import type {} from './projection.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    contextBreakdown: ContextBreakdownState
  }
}

const tokenCount = z.number().int().nonnegative()
const sessionSeq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq)

const breakdownSchema = z.object({
  systemTokens: tokenCount,
  toolsTokens: tokenCount,
  messageTokens: tokenCount,
}).strict()

/** Plain-JSON checkpoint: one compact entry per retained surface position. */
const contextBreakdownStateSchema = z.object({
  nodes: z.array(z.object({
    seq: sessionSeq,
    heuristicTokens: tokenCount,
    system: z.boolean(),
  }).strict()),
  breakdown: breakdownSchema,
}).strict()
type ContextBreakdownState = z.infer<typeof contextBreakdownStateSchema>

/**
 * Context composition with the last nonempty surviving system in surface
 * order classified as system tokens; all other visible prices are messages.
 * Replacements use the measurement planner, not shadow-price claims. State
 * and surface transitions cost O(current retained surface), not O(log length).
 * Tools are priced from the latest request header. No route pricing applies.
 */
export const contextBreakdownProjectionDefinition = {
  key: 'contextBreakdown',
  stateVersion: 5,
  stateSchema: contextBreakdownStateSchema,
  init: (): ContextBreakdownState => ({
    nodes: [],
    breakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 },
  }),
  apply: (state, event) => {
    if (event.type === 'request/header') {
      const toolsTokens = estimateToolsTokens(canonicalHeader(event.data.header))
      return toolsTokens === state.breakdown.toolsTokens
        ? state
        : { ...state, breakdown: { ...state.breakdown, toolsTokens } }
    }
    if (!isSurfaceEvent(event)) return state
    const plan = planSurfaceTokens(state.nodes, event)
    const nodes = [...state.nodes]
    commitSurfaceTokens(nodes, {
      ...plan,
      node: { seq: event.seq, heuristicTokens: plan.tokens, system: event.type === 'system/message' },
    })
    const systemTokens = nodes.findLast(node => node.system && node.heuristicTokens > 0)?.heuristicTokens ?? 0
    const messageTokens = state.breakdown.systemTokens + state.breakdown.messageTokens + plan.deltaTokens - systemTokens
    const breakdown = systemTokens === state.breakdown.systemTokens && messageTokens === state.breakdown.messageTokens
      ? state.breakdown
      : { systemTokens, toolsTokens: state.breakdown.toolsTokens, messageTokens }
    return { nodes, breakdown }
  },
  wire: {
    viewSchema: breakdownSchema,
    view: state => state.breakdown,
  },
} satisfies ProjectionDefinition<'contextBreakdown', ContextBreakdownState>
