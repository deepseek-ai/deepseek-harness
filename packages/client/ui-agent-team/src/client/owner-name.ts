/** Model-facing agent name of a Team task owner, derived from loaded subagent catalogs. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'

/** The root agent's fixed name, equal to `ROOT_AGENT_NAME` of the Host-only `@deepseek-ai/dsh-subagent` entry. */
const ROOT_AGENT_NAME = 'lead'

/**
 * Name a task owner as agent tools name it.
 * @param projections - Loaded projections by Session; each `subagentCatalog` lists that Session's direct children.
 * @param rootId - Root Session of the subagent tree that owns the task board.
 * @param ownerId - Session ID recorded as the task owner.
 * @returns `lead` for the root; the slash-separated catalog names below the root, such as
 *   `reviewer/checker`, when every link to the owner is loaded and named; otherwise `ownerId`.
 */
export function ownerName(
  projections: SessionListState['projectionsBySession'], rootId: SessionId, ownerId: SessionId,
): string {
  if (ownerId === rootId) return ROOT_AGENT_NAME
  // A Session listed by more than one loaded catalog is searched once, which also ends a cyclic listing.
  const visited = new Set<SessionId>([rootId])
  const search = (parentId: SessionId): string | undefined => {
    for (const entry of projections[parentId]?.values.subagentCatalog ?? []) {
      const name = entry.mode === 'continuable' || entry.mode === 'external' ? entry.name : undefined
      if (name === undefined || visited.has(entry.id)) continue
      if (entry.id === ownerId) return name
      visited.add(entry.id)
      const below = search(entry.id)
      if (below !== undefined) return `${name}/${below}`
    }
    return undefined
  }
  return search(rootId) ?? ownerId
}
