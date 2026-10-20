/** Team root discovery from the current subagent address and retained Session summaries. */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'

/**
 * Follow subagent parents to the ordinary root that owns the shared Team board.
 * @param sessionId - current conversation id.
 * @param parentId - direct parent from the current conversation's subagent address.
 * @param summaries - shared Session list metadata, including unopened ancestors.
 * @returns the root id, or undefined while ancestry is missing or cyclic.
 */
export function teamRootId(
  sessionId: SessionId,
  parentId: SessionId | undefined,
  summaries: Readonly<Record<SessionId, SessionSummary>>,
): SessionId | undefined {
  const seen = new Set<SessionId>([sessionId])
  while (parentId !== undefined) {
    if (seen.has(parentId)) return undefined
    seen.add(parentId)
    const parent = summaries[parentId]
    if (parent === undefined) return undefined
    if (parent.origin !== 'subagent') return parentId
    parentId = parent.parentId
    if (parentId === undefined) return undefined
  }
  return sessionId
}
