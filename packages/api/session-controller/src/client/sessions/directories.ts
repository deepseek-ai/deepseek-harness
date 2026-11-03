/**
 * The directories of one Session as the Client knows them: the list row's
 * header directory and the projected root and cursor. Pure reads with
 * type-only imports, so client plugins inline this module instead of
 * requesting a module-table row this package does not publish.
 * @module @deepseek-ai/dsh-api-session-controller/client/directories
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ISessions } from '../contract/sessions.ts'
import type { SessionListState } from './service.ts'

/** Where a Session started, which checkout it works in, and where its relative paths resolve. */
export interface SessionDirectories {
  /** The original project the Session header records; undefined for a row without one. */
  readonly original: string | undefined
  /**
   * The workspace root: the checkout the Session works in, which file views and address bases use;
   * the original project before any relocation.
   */
  readonly root: string | undefined
  /** The current directory the model's relative paths resolve from; the root while the Session reports none. */
  readonly cwd: string | undefined
}

/** A projected string value by key, from a values object whose keys the Client compilation does not declare. */
function projectedString(values: object | undefined, key: string): string | undefined {
  if (values === undefined) return undefined
  const value: unknown = Reflect.get(values, key)
  return typeof value === 'string' ? value : undefined
}

/**
 * Select a Session's workspace root from a list snapshot, for `useSessions` selectors.
 * @param state - the sessions list snapshot.
 * @param sessionId - the Session whose root is selected.
 * @returns the projected `workspaceRoot`, else the header directory, else undefined for an unknown row.
 */
export function selectSessionRoot(state: SessionListState, sessionId: SessionId): string | undefined {
  return projectedString(state.projectionsBySession[sessionId]?.values, 'workspaceRoot')
    ?? projectedString(state.byId[sessionId]?.projectionValues, 'workspaceRoot')
    ?? state.byId[sessionId]?.cwd
}

/**
 * Read a Session's directories at gesture time: the connected Session's projection faces first, then the list snapshot.
 * @param sessions - the sessions service.
 * @param sessionId - the Session whose directories are read.
 * @returns the original project, the workspace root, and the current directory, each undefined when unknown.
 */
export function sessionDirectories(sessions: ISessions, sessionId: SessionId): SessionDirectories {
  const state = sessions.list.getSnapshot()
  const original = state.byId[sessionId]?.cwd
  const projections = sessions.binding(sessionId)?.session.projections
  const liveRoot: unknown = projections?.faceOf('workspaceRoot').getSnapshot()
  const root = (typeof liveRoot === 'string' ? liveRoot : undefined) ?? selectSessionRoot(state, sessionId) ?? original
  const liveCwd: unknown = projections?.faceOf('workingDirectory').getSnapshot()
  const cwd = (typeof liveCwd === 'string' ? liveCwd : undefined) ?? root
  return { original, root, cwd }
}
