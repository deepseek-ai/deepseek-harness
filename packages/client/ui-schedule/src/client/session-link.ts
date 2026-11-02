/** Original-Session link availability from the current public Session and Workspace feeds. */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Navigation state shown beside the retained task's original Session id. */
export type SessionLinkState = 'available' | 'loading' | 'archived' | 'unavailable'

/**
 * Check Host-list membership and archive state without activating or restoring anything.
 *
 * `SessionListState.byId` also carries local fallback rows for live Client
 * generations, so membership comes from `ids`, the Host-list projection: a
 * Session the Host list dropped reports unavailable even while a local row for
 * it survives.
 * @param id - Original Session bound to the task.
 * @param sessions - Current Session list projection.
 * @param workspaces - Current Workspace and archive projection.
 * @returns availability or the reason navigation is disabled.
 */
export function sessionLinkState(id: SessionId, sessions: SessionListState, workspaces: WorkspaceSnapshot): SessionLinkState {
  if (workspaces.state === 'error') return 'unavailable'
  if (sessions.phase === 'pending' || workspaces.phase === 'pending') return 'loading'
  if (workspaces.archivedSessionIds.includes(id)) return 'archived'
  if (!sessions.ids.includes(id)) return 'unavailable'
  return 'available'
}
