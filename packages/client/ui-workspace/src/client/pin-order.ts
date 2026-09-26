/**
 * The complete account memberships a Pin order write reconciles against,
 * derived from the same Host snapshots the browser orders by, so the
 * UiWorkspace service can complete the write without the browser in the loop.
 */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { FLAT_SESSION_ORDER_KEY } from './stores.ts'
import { owningGroupKey, sessionMemberIds, type SessionRowState, UNGROUPED_KEY } from './tree.ts'

/** What `pinSessionOrder` reconciles a pinned Session's accounts against. */
export interface PinOrderSource {
  members: Readonly<Record<string, readonly SessionId[]>>
  summaries: SessionListState['byId']
  rowState: Pick<SessionRowState, 'pinnedSessionIds' | 'archivedSessionIds'>
}

/**
 * Every account's complete membership: each Workspace, Ungrouped, and the flat list.
 * @param workspaces - current Host Workspaces.
 * @param list - current Session list snapshot.
 * @param rowState - registry-global pin and archive sets.
 * @returns the order source for one pin write.
 */
export function pinOrderSource(
  workspaces: readonly WorkspaceView[],
  list: SessionListState,
  rowState: PinOrderSource['rowState'],
): PinOrderSource {
  const accounted = new Set(workspaces.flatMap(workspace => workspace.sessionIds))
  return {
    members: Object.fromEntries([
      ...workspaces.map(workspace => [workspace.workspaceId, workspace.sessionIds] as const),
      [UNGROUPED_KEY, list.ids.filter(id => list.byId[id] !== undefined && !accounted.has(id))],
      [FLAT_SESSION_ORDER_KEY, sessionMemberIds(list)],
    ]),
    summaries: list.byId,
    rowState,
  }
}

/**
 * The accounts a pinned Session leads: its group (or Ungrouped) and the flat list.
 * @param workspaces - current Host Workspaces.
 * @param sessionId - the Session being pinned.
 * @returns the account keys `pinSessionOrder` fronts.
 */
export function pinOrderAccounts(workspaces: readonly WorkspaceView[], sessionId: SessionId): readonly string[] {
  return [owningGroupKey(workspaces, sessionId), FLAT_SESSION_ORDER_KEY]
}
