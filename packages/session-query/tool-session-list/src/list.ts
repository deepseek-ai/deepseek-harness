/** Header-only selection and cached metadata for the read-only listing tools. */

import { performance } from 'node:perf_hooks'
import { scheduler } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionListMetadata } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-session-title'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'

/** Optional model pagination arguments. */
export interface PageInput {
  readonly limit?: number
  readonly offset?: number
}

/** Optional Session selection arguments. */
export interface SessionListInput extends PageInput {
  readonly workspace_id?: string
  readonly contain_subagent?: boolean
  readonly archived?: boolean
}

interface WorkspaceListItem {
  workspace_id: WorkspaceId
  title: string
  path: string
  created_at: string
  updated_at: string
}

interface SessionListItem {
  session_id: SessionId
  title: string | null
  created_at: string
  updated_at: string
}

/**
 * Resolve pagination before reading any registry or persistence data.
 * @param input - model pagination arguments.
 * @returns the validated count and starting index.
 */
export function resolvePage(input: PageInput): { limit: number; offset: number } {
  const limit = input.limit ?? 20
  const offset = input.offset ?? 0
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ToolArgsError(['limit must be an integer from 1 to 100'])
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new ToolArgsError(['offset must be a non-negative safe integer'])
  }
  return { limit, offset }
}

/**
 * Read one page of the authoritative Workspace order, including empty records.
 * @param ctx - context providing the Workspace registry.
 * @param input - pagination arguments.
 * @param signal - caller cancellation.
 * @returns Workspace metadata with ISO timestamps.
 */
export function listWorkspaces(ctx: Context, input: PageInput, signal: AbortSignal): WorkspaceListItem[] {
  const { limit, offset } = resolvePage(input)
  signal.throwIfAborted()
  return ctx.workspaceRegistry.list().slice(offset, offset + limit).map(workspace => ({
    workspace_id: workspace.id,
    title: workspace.title,
    path: workspace.path,
    created_at: workspace.createdAt,
    updated_at: workspace.updatedAt,
  }))
}

/**
 * List live and persisted Session metadata without opening cold logs or activating Agents.
 * @param ctx - context providing query, Workspace, and projection services.
 * @param readLiveMetadata - ready reader owned by this plugin's registration.
 * @param input - filters and pagination arguments.
 * @param signal - caller cancellation, forwarded to the corpus listing.
 * @param workSliceMs - resolved positive integral work slice between complete rows.
 * @returns filtered Session metadata ordered by activity, then identity.
 */
export async function listSessions(
  ctx: Context,
  readLiveMetadata: (session: Session) => SessionListMetadata,
  input: SessionListInput,
  signal: AbortSignal,
  workSliceMs: number,
): Promise<SessionListItem[]> {
  const { limit, offset } = resolvePage(input)
  signal.throwIfAborted()
  const workspaceId = input.workspace_id === undefined ? undefined : WorkspaceId(input.workspace_id)
  if (workspaceId !== undefined && ctx.workspaceRegistry.get(workspaceId) === undefined) {
    throw new ToolArgsError([`workspace_id ${JSON.stringify(workspaceId)} is not registered; use list_workspace to find a workspace`])
  }
  const records = await ctx.sessionQuery.listSessions(signal)
  signal.throwIfAborted()
  const archived = new Set(ctx.workspaceRegistry.archivedSessionIds)
  const ownership = new Map<SessionId, WorkspaceId>()
  if (workspaceId !== undefined) {
    for (const workspace of ctx.workspaceRegistry.list()) {
      for (const id of workspace.sessionIds) ownership.set(id, workspace.id)
    }
  }
  const headers = new Map(records.map(record => [record.header.id, record.header]))
  const nearestWorkspace = ancestorWorkspaceReader(headers, ownership)
  const items = []
  let yieldDeadline = performance.now() + workSliceMs
  for (const { header } of records) {
    signal.throwIfAborted()
    if (performance.now() >= yieldDeadline) {
      await scheduler.yield()
      signal.throwIfAborted()
      yieldDeadline = performance.now() + workSliceMs
    }
    if (!input.contain_subagent && header.origin === 'subagent') continue
    if (archived.has(header.id) !== (input.archived ?? false)) continue
    if (workspaceId !== undefined) {
      const owner = header.origin === 'subagent' ? nearestWorkspace(header) : ownership.get(header.id)
      if (owner !== workspaceId) continue
    }
    const metadata = readListMetadata(ctx, header, readLiveMetadata)
    items.push({
      session_id: header.id,
      title: metadata.title,
      created_at: new Date(header.createdAt).toISOString(),
      updatedAt: Math.max(header.createdAt, metadata.lastPromptAt ?? 0),
    })
  }
  items.sort((left, right) => right.updatedAt - left.updatedAt
    || (left.session_id < right.session_id ? -1 : 1))
  signal.throwIfAborted()
  return items.slice(offset, offset + limit).map(({ updatedAt, ...item }) => ({
    ...item,
    updated_at: new Date(updatedAt).toISOString(),
  }))
}

function readListMetadata(
  ctx: Context,
  header: SessionHeader,
  readLiveMetadata: (session: Session) => SessionListMetadata,
): { title: string | null; lastPromptAt: number | null } {
  const live = ctx.sessions.get(header.id)
  if (live !== undefined) {
    return {
      title: ctx.sessionProjections.snapshot(live, ['title']).values.title ?? null,
      lastPromptAt: readLiveMetadata(live).lastPromptAt,
    }
  }
  const cache = ctx.get('sessionProjectionCache')
  const snapshot = cache?.cachedSnapshot(header, ['title', 'sessionListMetadata'])
    ?? cache?.cachedPredecessorTitle(header)
  return {
    title: snapshot?.values.title ?? null,
    lastPromptAt: snapshot?.values.sessionListMetadata?.lastPromptAt ?? null,
  }
}

function ancestorWorkspaceReader(
  headers: ReadonlyMap<SessionId, SessionHeader>,
  ownership: ReadonlyMap<SessionId, WorkspaceId>,
): (header: SessionHeader) => WorkspaceId | undefined {
  const resolved = new Map<SessionId, WorkspaceId | undefined>(ownership)
  return (header) => {
    const visited = new Set<SessionId>()
    let current: SessionHeader | undefined = header
    while (current !== undefined && !resolved.has(current.id)) {
      if (visited.has(current.id)) {
        throw new SessionQueryError(`Session ${header.id} has cyclic parent ancestry`, 'SESSION_QUERY_INVALID_LINEAGE')
      }
      visited.add(current.id)
      current = current.parentSession === undefined ? undefined : headers.get(current.parentSession)
    }
    const workspace = current === undefined ? undefined : resolved.get(current.id)
    for (const id of visited) resolved.set(id, workspace)
    return workspace
  }
}
