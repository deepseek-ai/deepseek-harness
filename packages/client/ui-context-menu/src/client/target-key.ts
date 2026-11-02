/** Target equality for pointer gestures and entity-owned menu buttons. */
import type { ContextMenuTarget } from './types.ts'

/**
 * Compare captured JSON targets independently of object key insertion order.
 * @param target - captured immutable target.
 * @returns canonical JSON identity.
 */
export function menuTargetKey(target: ContextMenuTarget): string {
  return JSON.stringify(target, (_key: string, value: unknown): unknown => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
  })
}

/**
 * Identify entity buttons independently of mutable display metadata.
 * @param target - Captured menu target.
 * @returns Kind and entity ID for Session and Workspace buttons; canonical JSON for other target families.
 */
export function buttonTargetKey(target: ContextMenuTarget): string {
  switch (target.kind) {
    case 'session':
    case 'sessionHeader': return JSON.stringify([target.kind, target.value.sessionId])
    case 'workspace': return JSON.stringify([target.kind, target.value.workspaceId])
    // Extension targets retain canonical JSON equality unless they use a built-in entity kind.
    default: return menuTargetKey(target)
  }
}
