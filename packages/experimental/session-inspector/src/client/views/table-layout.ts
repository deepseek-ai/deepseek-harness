/** Live folding preserves the visible anchor and places unused viewport space after all data rows. */

import type { InspectorRow, InspectorTableHierarchy } from './table-model.ts'

/** Fixed table row and header height, in CSS pixels. */
export const INSPECTOR_ROW_HEIGHT = 30

/** One data row in the virtual scroll layout. */
export type InspectorTableItem = {
  readonly key: string
  readonly rowIndex: number
  readonly size: number
  readonly row: InspectorRow
}

/** Last committed scroll geometry, measured before a source update. */
export interface InspectorViewport {
  readonly offset: number
  readonly height: number
}

/** A disclosure row's measured position relative to the scroll viewport. */
export interface InspectorRowAnchor {
  readonly key: string
  readonly top: number
}

/** View-local spacing; constructing without a predecessor resets retained blank areas. */
export class InspectorTableLayout {
  /** Visible data rows and their virtual sizes; excludes the table header and trailing space. */
  readonly items: readonly InspectorTableItem[]
  /** Whether a live block closure shortened the previous visible hierarchy. */
  readonly preservedCollapse: boolean
  /** Trailing space in CSS pixels retained to keep the viewport anchor stable. */
  readonly bottomPadding: number
  /** Anchored scroll offset in CSS pixels, or undefined when no anchor adjustment is needed. */
  readonly scrollOffset: number | undefined
  private readonly minimumExtent: number
  private readonly rowIndexes = new Map<string, number>()

  /**
   * @param hierarchy - Current visible data rows.
   * @param previous - Previous committed layout, omitted after manual disclosure changes.
   * @param viewport - Scroll geometry before the current row change.
   * @param anchor - Clicked disclosure row to retain at its measured viewport position.
   */
  constructor(private readonly hierarchy: InspectorTableHierarchy, previous?: InspectorTableLayout,
    viewport: InspectorViewport = { offset: 0, height: 0 }, anchor?: InspectorRowAnchor) {
    for (const [rowIndex, row] of hierarchy.rows.entries()) {
      this.rowIndexes.set(row.key, rowIndex)
    }
    this.items = hierarchy.rows.map((row, rowIndex) => ({ key: row.key, rowIndex, row, size: INSPECTOR_ROW_HEIGHT }))
    this.preservedCollapse = previous !== undefined && hierarchy.rows.length < previous.hierarchy.rows.length
      && hierarchy.rows.some(row => row.disclosure === 'closed'
        && previous.hierarchy.rows[previous.rowIndexes.get(row.key) ?? -1]?.disclosure === 'open')
    const anchorIndex = anchor === undefined ? undefined : this.rowIndexes.get(anchor.key)
    this.scrollOffset = anchor !== undefined && anchorIndex !== undefined
      ? Math.max(0, (anchorIndex + 1) * INSPECTOR_ROW_HEIGHT - anchor.top)
      : this.preservedCollapse && previous !== undefined ? this.anchorOffset(previous, viewport.offset) : undefined
    const natural = (this.items.length + 1) * INSPECTOR_ROW_HEIGHT
    const minimum = this.scrollOffset === undefined ? previous?.minimumExtent ?? 0
      : Math.max(this.scrollOffset + viewport.height, (previous?.minimumExtent ?? 0) + this.scrollOffset - viewport.offset)
    this.minimumExtent = minimum > natural ? minimum : 0
    this.bottomPadding = Math.max(0, this.minimumExtent - natural)
  }

  /**
   * Keep the enclosing headers visible above the first visible data row.
   * @param itemIndex - First visible virtual item.
   * @returns Ancestor indexes in the virtual layout.
   */
  stickyIndexes(itemIndex: number): readonly number[] {
    return this.hierarchy.stickyIndexes(itemIndex)
  }

  /**
   * Resolve each sticky level below the table header and already occupied sticky rows.
   * @param offset - Scroll offset in CSS pixels.
   * @returns Active ancestor indexes, outermost first.
   */
  stickyIndexesAtOffset(offset: number): readonly number[] {
    const indexes: number[] = []
    const first = Math.max(0, Math.floor(offset / INSPECTOR_ROW_HEIGHT))
    while (indexes.length < this.items.length) {
      const candidate = Math.min(this.items.length - 1, first + indexes.length)
      const ancestors = this.stickyIndexes(candidate)
      const next = ancestors[indexes.length]
      if (next === undefined || indexes.some((index, level) => ancestors[level] !== index)) break
      indexes.push(next)
    }
    return indexes
  }

  private anchorOffset(previous: InspectorTableLayout, offset: number): number {
    const first = Math.max(0, Math.min(previous.items.length - 1, Math.floor(offset / INSPECTOR_ROW_HEIGHT)))
    const index = Math.min(previous.items.length - 1, first + previous.stickyIndexesAtOffset(offset).length)
    // oxlint-disable-next-line typescript/no-non-null-assertion -- A preserved collapse has a nonempty predecessor; index is clamped above.
    const row = previous.items[index]!.row
    const retained = this.rowIndexes.get(row.key)
    if (retained !== undefined) return Math.max(0, offset + (retained - index) * INSPECTOR_ROW_HEIGHT)
    const ancestors = previous.stickyIndexes(index)
    for (let level = ancestors.length - 1; level >= 0; level--) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- The hierarchy returns indexes into this predecessor's items.
      const parent = previous.items[ancestors[level]!]!.row
      const next = this.rowIndexes.get(parent.key)
      if (next !== undefined) return Math.max(0, (next - level) * INSPECTOR_ROW_HEIGHT)
    }
    return 0
  }
}
