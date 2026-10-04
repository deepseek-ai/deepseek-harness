/** Type-specific horizontal previews without changing raw inspector data. */

/** Maximum text length of a horizontal row preview. */
export const INSPECTOR_PREVIEW_LIMIT = 240

const DELTA_PREVIEW_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  ['tool-call-delta', ['argumentsDelta']],
  ['reasoning-delta', ['text']],
])

function preview(value: unknown, depth: number, hiddenRootFields: readonly string[]): string {
  if (typeof value === 'string') return value.slice(0, 180)
  if (value === null || typeof value !== 'object') return String(value)
  if (depth > 1) return Array.isArray(value) ? `[${value.length}]` : '{…}'
  const fields = 'type' in value && typeof value.type === 'string' ? DELTA_PREVIEW_FIELDS.get(value.type) : undefined
  const entries = Object.entries(value)
    .filter(([key]) => !(depth === 0 && (key.toLowerCase() === 'time' || hiddenRootFields.includes(key))) && (fields === undefined
      ? !['type', 'seq', 'sequence'].includes(key.toLowerCase())
      : fields.includes(key)))
  const [first, second] = entries
  if (first !== undefined && second === undefined) return preview(first[1], depth + 1, hiddenRootFields)
  return entries.slice(0, 5).map(([key, item]) => `${key}: ${preview(item, depth + 1, hiddenRootFields)}`).join(' · ').slice(0, INSPECTOR_PREVIEW_LIMIT)
}

/**
 * Format horizontal data with type-specific delta fields and bounded nesting.
 * @param value - Original row data, which remains unchanged for JSON inspection.
 * @param hiddenRootFields - Additional top-level metadata already displayed in the owning table's columns.
 * @returns A bounded preview omitting type, sequence, top-level time, and singleton field names.
 */
export function inspectorPreview(value: unknown, hiddenRootFields: readonly string[] = []): string {
  return preview(value, 0, hiddenRootFields)
}
