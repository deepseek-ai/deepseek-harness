/**
 * Direct-child and recursive descendant discovery from parent-owned catalogs.
 * Each catalog read releases its Session observation before the next branch.
 * @module @deepseek-ai/dsh-subagent
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentListEntry } from './control-types.ts'
import { SubagentError } from './error.ts'
import type { SubagentCatalogEntry } from './projection-types.ts'

export type { SubagentListEntry } from './control-types.ts'

/** One catalog descendant with its direct parent and edge distance from the requested root. */
export type SubagentDescendantListEntry = SubagentListEntry & {
  /** Parent whose catalog contains this child. */
  readonly parentId: SessionId
  /** Edge distance from the requested root; direct children are `1`. */
  readonly depth: number
}

/**
 * Read one parent's durable catalog through a live-preferred Session observation.
 * @param ctx - context carrying the Session query service.
 * @param parentSessionId - parent whose direct children are requested.
 * @param signal - cancellation forwarded to the Session observation.
 * @returns direct-child rows in parent catalog event order.
 * @throws {@link SubagentError} when query or catalog projection is unavailable.
 */
export async function listChildren(
  ctx: Context,
  parentSessionId: SessionId,
  signal?: AbortSignal,
): Promise<SubagentCatalogEntry[]> {
  const query = ctx.get('sessionQuery')
  if (query === undefined) {
    throw new SubagentError(
      'listing subagents requires the sessionQuery service (load @deepseek-ai/dsh-session-query)',
      'SUBAGENT_CONTROL_QUERY_UNAVAILABLE',
    )
  }
  using parent = await query.observeSession(parentSessionId, {
    ...signal === undefined ? {} : { signal },
  })
  const entries = parent.projections?.values.subagentCatalog
  if (entries === undefined) {
    throw new SubagentError(
      'listing subagents requires the registered subagentCatalog projection',
      'SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE',
    )
  }
  return entries
}

/**
 * Walk reachable parent catalogs in stable pre-order without loading Agents.
 * @see SubagentRuntime.listDescendants for failure and cancellation semantics.
 * @param ctx - context carrying the Session store and query service.
 * @param rootSessionId - parent whose catalog starts the traversal.
 * @param signal - cancellation checked around each catalog read.
 * @returns children and branch diagnostics with catalog parent and depth.
 */
export async function listDescendants(
  ctx: Context,
  rootSessionId: SessionId,
  signal?: AbortSignal,
): Promise<SubagentDescendantListEntry[]> {
  const sessions = ctx.get('sessions')
  if (sessions === undefined) {
    throw new SubagentError(
      'listing subagents requires the session store (load @deepseek-ai/dsh-session)',
      'SUBAGENT_CONTROL_SESSION_STORE_UNAVAILABLE',
    )
  }
  const readChildren = async (id: SessionId): Promise<SubagentCatalogEntry[]> => {
    assertListingNotCancelled(signal)
    let children: SubagentCatalogEntry[]
    try {
      children = await listChildren(ctx, id, signal)
    } catch (error) {
      assertListingNotCancelled(signal)
      throw error
    }
    assertListingNotCancelled(signal)
    return children
  }
  const stack = (await readChildren(rootSessionId))
    .map(entry => ({ entry, parentId: rootSessionId, depth: 1 }))
    .reverse()
  const visited = new Set<SessionId>([rootSessionId])
  const result: SubagentDescendantListEntry[] = []
  for (let position = stack.pop(); position !== undefined; position = stack.pop()) {
    const { entry, parentId, depth } = position
    if (visited.has(entry.id)) continue
    visited.add(entry.id)
    let children: SubagentCatalogEntry[]
    try {
      children = await readChildren(entry.id)
    } catch (error) {
      if (error instanceof SubagentError) throw error
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      result.push({
        kind: 'diagnostic', id: entry.id, parentId, depth,
        reason: code === 'SESSION_QUERY_CORRUPT_SESSION' || code === 'SESSION_QUERY_SOURCE_CONFLICT'
          ? 'corrupt' : 'unavailable',
      })
      continue
    }
    if (entry.mode === 'unknown') {
      result.push({ kind: 'diagnostic', id: entry.id, parentId, depth, reason: 'unsupported' })
    } else {
      const { createdAt: _createdAt, ...identity } = entry
      result.push({
        ...identity, kind: 'child', parentId, depth,
        activity: sessions.get(entry.id) === undefined ? 'inactive' : 'running',
        hasChildren: children.length > 0,
      })
    }
    // Catalog event order defines siblings; the stack visits the first one next.
    for (const child of [...children].reverse()) {
      stack.push({ entry: child, parentId: entry.id, depth: depth + 1 })
    }
  }
  return result
}

/** Stop the complete traversal when its caller cancels. */
function assertListingNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new SubagentError('subagent listing was cancelled', 'CANCELLED')
  }
}
