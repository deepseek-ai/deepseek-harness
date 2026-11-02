/** Stable equality for the JSON-compatible target vocabulary, independent of object insertion order. */
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
