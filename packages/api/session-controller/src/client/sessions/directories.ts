/**
 * The directory one Session works in, as the Client knows it: the projected
 * `workingDirectory`. Pure reads with type-only imports, so client plugins
 * inline this module instead of requesting a module-table row this package
 * does not publish.
 * @module @deepseek-ai/dsh-api-session-controller/client/directories
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ISessions } from '../contract/sessions.ts'
import type { SessionListState } from './service.ts'

/** A projected string value by key, from a values object whose keys the Client compilation does not declare. */
function projectedString(values: object | undefined, key: string): string | undefined {
  if (values === undefined) return undefined
  const value: unknown = Reflect.get(values, key)
  return typeof value === 'string' ? value : undefined
}

/**
 * Select a Session's directory from a list snapshot, for `useSessions` selectors. File views, address
 * bases, and relative paths all use it; the header directory stays the original project.
 * @param state - the sessions list snapshot.
 * @param sessionId - the Session whose directory is selected.
 * @returns the projected `workingDirectory`, else the header directory, else undefined for an unknown row.
 */
export function selectSessionDirectory(state: SessionListState, sessionId: SessionId): string | undefined {
  return projectedString(state.projectionsBySession[sessionId]?.values, 'workingDirectory')
    ?? projectedString(state.byId[sessionId]?.projectionValues, 'workingDirectory')
    ?? state.byId[sessionId]?.cwd
}

/**
 * Read a Session's directory at gesture time: the connected Session's projection face first, then the list snapshot.
 * @param sessions - the sessions service.
 * @param sessionId - the Session whose directory is read.
 * @returns the directory, or undefined when unknown.
 */
export function sessionDirectory(sessions: ISessions, sessionId: SessionId): string | undefined {
  const live: unknown = sessions.binding(sessionId)?.session.projections.faceOf('workingDirectory').getSnapshot()
  return (typeof live === 'string' ? live : undefined) ?? selectSessionDirectory(sessions.list.getSnapshot(), sessionId)
}
