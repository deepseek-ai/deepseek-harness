/** Stable grouping shared by popup filtering and rendering. */
import type { SelectOption, SelectOptionGroup } from './contract.ts'

interface OptionGroup {
  readonly group: SelectOptionGroup | undefined
  readonly rows: readonly SelectOption[]
}

/**
 * Group rows by their caller-owned group name, without sorting groups or rows.
 * Ungrouped rows occupy one block at their first occurrence.
 * @param options - Options in display order.
 * @returns groups in first-occurrence order, with original option objects.
 */
export function groupOptions(options: readonly SelectOption[]): OptionGroup[] {
  const groups = new Map<string | undefined, { group: SelectOptionGroup | undefined; rows: SelectOption[] }>()
  for (const option of options) {
    const name = option.group?.name
    const existing = groups.get(name)
    if (existing !== undefined) existing.rows.push(option)
    else groups.set(name, { group: option.group, rows: [option] })
  }
  return [...groups.values()]
}
