/** Confirmed type filtering preserves the ancestors needed to inspect matching nested rows. */

import type { InspectorRow } from './table-model.ts'

/** Filtered row order and the distinction between matches and contextual ancestors. */
export interface InspectorTypeMatches {
  readonly rows: readonly InspectorRow[]
  readonly matches: ReadonlySet<string>
}

/** Case-insensitive containment filter; optional surrounding stars have the same meaning as omission. */
export class InspectorTypeFilter {
  /** Trimmed type fragment without optional surrounding stars; preserves the entered case. */
  readonly query: string
  private readonly needle: string

  /** @param query - Type fragment; empty text or only stars clears filtering. */
  constructor(query: string) {
    this.query = query.trim().replace(/^\*+|\*+$/g, '').trim()
    this.needle = this.query.toLowerCase()
  }

  /**
   * Distinguish a type restriction from an empty or all-stars query.
   * @returns Whether this filter restricts the table.
   */
  get active(): boolean { return this.needle !== '' }

  /**
   * Match a type by case-insensitive containment, accepting all types when filtering is inactive.
   * @param type - Current raw type, absent while its record is unavailable.
   * @returns Whether the record matches the filter.
   */
  matches(type: string | undefined): boolean {
    return !this.active || (type !== undefined && type.toLowerCase().includes(this.needle))
  }

  /**
   * Retain matching rows and their ancestors; matching descendants start visible even under closed blocks.
   * @param rows - Complete loaded hierarchy, before user disclosure choices.
   * @param typeOf - Current type reader, independent of React row subscriptions.
   * @returns Matching rows and contextual ancestors in their original order.
   */
  apply(rows: readonly InspectorRow[], typeOf: (key: string) => string | undefined): InspectorTypeMatches {
    if (!this.active) return { rows, matches: new Set(rows.map(row => row.key)) }
    const matches = new Set(rows.filter(row => this.matches(typeOf(row.key))).map(row => row.key))
    const byKey = new Map(rows.map(row => [row.key, row]))
    const retained = new Set(matches)
    for (const key of matches) {
      let parent = byKey.get(key)?.parent
      while (parent !== undefined && !retained.has(parent)) {
        retained.add(parent)
        parent = byKey.get(parent)?.parent
      }
    }
    const branches = new Set<string>()
    for (const key of retained) {
      const parent = byKey.get(key)?.parent
      if (parent !== undefined) branches.add(parent)
    }
    return { matches, rows: rows.filter(row => retained.has(row.key)).map((row) => {
      const { disclosure: _disclosure, ...plain } = row
      return branches.has(row.key) ? { ...plain, disclosure: 'open' as const } : plain
    }) }
  }

  /**
   * Resolve candidates asynchronously from all loaded rows, not the already filtered subset.
   * @param rows - Complete loaded row list.
   * @param typeOf - Current raw type reader.
   * @returns Distinct matching types in deterministic order.
   */
  async suggest(rows: readonly InspectorRow[], typeOf: (key: string) => string | undefined): Promise<readonly string[]> {
    await Promise.resolve()
    const types = new Set<string>()
    for (const row of rows) {
      const type = typeOf(row.key)
      if (type !== undefined && this.matches(type)) types.add(type)
    }
    return [...types].sort()
  }
}
