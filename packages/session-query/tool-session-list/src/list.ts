/** Header-only selection and cached metadata for the read-only listing tools. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
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

/** Entries per page when the model passes no `limit`; part of the model-visible schema. */
export const DEFAULT_PAGE_LIMIT = 20
/** Largest accepted `limit`; part of the model-visible schema. */
export const MAX_PAGE_LIMIT = 100

/**
 * Resolve pagination before reading any registry or persistence data.
 * @param input - model pagination arguments.
 * @returns the validated count and starting index.
 */
export function resolvePage(input: PageInput): { limit: number; offset: number } {
  const limit = input.limit ?? DEFAULT_PAGE_LIMIT
  const offset = input.offset ?? 0
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new ToolArgsError([`limit must be an integer from 1 to ${String(MAX_PAGE_LIMIT)}`])
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
 * A Workspace selection reads only its members' indexed headers; an unscoped call enumerates
 * the corpus headers. Subagent Sessions are excluded.
 * @param ctx - context providing query, Workspace, and projection services.
 * @param input - filters and pagination arguments.
 * @param signal - caller cancellation, forwarded to the corpus listing.
 * @returns filtered Session metadata ordered by activity, then identity.
 */
export async function listSessions(
  ctx: Context,
  input: SessionListInput,
  signal: AbortSignal,
): Promise<SessionListItem[]> {
  const { limit, offset } = resolvePage(input)
  signal.throwIfAborted()
  let headers: readonly SessionHeader[]
  if (input.workspace_id === undefined) {
    headers = (await ctx.sessionQuery.listSessions(signal)).map(record => record.header)
    signal.throwIfAborted()
  } else {
    const workspace = ctx.workspaceRegistry.get(WorkspaceId(input.workspace_id))
    if (workspace === undefined) {
      throw new ToolArgsError([`workspace_id ${JSON.stringify(input.workspace_id)} is not registered; use list_workspace to find a workspace`])
    }
    headers = workspace.getSessionHeaders()
  }
  const archived = new Set(ctx.workspaceRegistry.archivedSessionIds)
  const items: Array<Omit<SessionListItem, 'updated_at'> & { updatedAt: number }> = []
  for (const header of headers) {
    if (header.origin === 'subagent') continue
    if (archived.has(header.id) !== (input.archived ?? false)) continue
    const metadata = readListMetadata(ctx, header)
    items.push({
      session_id: header.id,
      title: metadata.title,
      created_at: new Date(header.createdAt).toISOString(),
      updatedAt: Math.max(header.createdAt, metadata.lastPromptAt ?? 0),
    })
  }
  items.sort((left, right) => right.updatedAt - left.updatedAt
    || (left.session_id < right.session_id ? -1 : 1))
  return items.slice(offset, offset + limit).map(({ updatedAt, ...item }) => ({
    ...item,
    updated_at: new Date(updatedAt).toISOString(),
  }))
}

function readListMetadata(
  ctx: Context,
  header: SessionHeader,
): { title: string | null; lastPromptAt: number | null } {
  const live = ctx.sessions.get(header.id)
  if (live !== undefined) {
    return {
      title: ctx.sessionProjections.snapshot(live, ['title']).values.title ?? null,
      lastPromptAt: ctx.sessionQuery.getListMetadata(live).lastPromptAt,
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
