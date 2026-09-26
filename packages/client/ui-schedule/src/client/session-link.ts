/** Original-Session link label and availability from the current public Session and Workspace feeds. */
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

/** Label one linked Session shows, and whether a Session title produced it. */
export interface SessionLabel {
  /** Session title from the current catalog, otherwise the Session id. */
  readonly text: string
  /** Whether a catalog title produced {@link SessionLabel.text}; false when the id is shown instead. */
  readonly titled: boolean
}

/**
 * Resolve the label of one linked Session from the Session catalog the calling
 * component already projects.
 *
 * A catalog title renders as-is; the Session id renders while the catalog holds
 * no row for the Session (missing or not yet loaded) or its row carries a blank
 * title, so the label is never empty. Every surface that names a linked Session
 * resolves the label here, so the Automation tasks rows, the task detail, and the
 * task tab all name the same Session the same way.
 * @param id - Original Session bound to the task.
 * @param sessions - Current Session list projection.
 * @returns the resolved label and whether a catalog title produced it.
 */
export function sessionLabel(id: SessionId, sessions: SessionListState): SessionLabel {
  const title = sessions.byId[id]?.title
  if (title === undefined || title.trim() === '') return { text: id, titled: false }
  return { text: title, titled: true }
}
