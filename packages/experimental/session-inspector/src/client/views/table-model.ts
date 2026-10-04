/** Row identities and raw values shared by the two virtual inspector tables. */

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/** One table position; children immediately follow their parent. */
export interface InspectorRow {
  readonly key: string
  readonly parent?: string
  readonly depth: number
  /** Disclosure default; a block lifecycle transition resets any earlier user override. */
  readonly disclosure?: 'open' | 'closed'
}

/** One user disclosure choice, valid only for the lifecycle state in which it was made. */
export interface InspectorDisclosure {
  readonly state: InspectorRow['disclosure']
  readonly collapsed: boolean
}

/**
 * Resolve a manual choice or the block lifecycle default.
 * @param row - Current row metadata.
 * @param choices - Table-local user choices.
 * @returns Whether the row's descendants are hidden.
 */
export function inspectorRowCollapsed(row: InspectorRow, choices: ReadonlyMap<string, InspectorDisclosure>): boolean {
  const choice = choices.get(row.key)
  return choice !== undefined && choice.state === row.disclosure ? choice.collapsed : row.disclosure === 'closed'
}

/** Table-local hierarchy index for disclosure and virtualized sticky ancestors. */
export class InspectorTableHierarchy {
  /** Depth-first row order with folded descendants omitted. */
  readonly rows: readonly InspectorRow[]
  private readonly byKey = new Map<string, number>()
  private readonly branches = new Set<string>()

  /**
   * @param rows - Complete depth-first row order.
   * @param choices - Table-local disclosure overrides.
   */
  constructor(rows: readonly InspectorRow[], choices: ReadonlyMap<string, InspectorDisclosure>) {
    const visible: InspectorRow[] = []
    let hiddenDepth: number | undefined
    for (const row of rows) {
      if (row.parent !== undefined) this.branches.add(row.parent)
      if (row.disclosure !== undefined) this.branches.add(row.key)
      if (hiddenDepth !== undefined && row.depth > hiddenDepth) continue
      hiddenDepth = inspectorRowCollapsed(row, choices) ? row.depth : undefined
      this.byKey.set(row.key, visible.length)
      visible.push(row)
    }
    this.rows = visible
  }

  /**
   * Identify rows that own descendants or an explicit disclosure state.
   * @param key - Row identity.
   * @returns Whether this row owns a disclosure.
   */
  isBranch(key: string): boolean { return this.branches.has(key) }

  /**
   * Find the current row's visible parent headers, including itself when it is a header.
   * @param index - First row at the viewport's scroll offset.
   * @returns Ordered indexes retained above the virtual viewport.
   */
  stickyIndexes(index: number): readonly number[] {
    const indexes: number[] = []
    let row = this.rows[index]
    if (row !== undefined && this.isBranch(row.key)) indexes.push(index)
    while (row?.parent !== undefined) {
      const parent = this.byKey.get(row.parent)
      if (parent === undefined) break
      indexes.push(parent)
      row = this.rows[parent]
    }
    return indexes.reverse()
  }
}

/** Raw data and compact metadata for one independently updated row. */
export interface InspectorRecord {
  readonly type: string
  readonly identity: string
  readonly location: string
  /** Unix epoch milliseconds. */
  readonly time?: number
  readonly value: unknown
  /** Owner-supplied preview for domain-specific field formatting. */
  readonly summary?: string
  /** Parent summary used only while its children are folded. */
  readonly collapsedSummary?: string
}

/** Converts a keyed source without changing snapshot identity on unchanged input. */
export class InspectorRecordSource<T> implements ObservableSnapshot<InspectorRecord | undefined> {
  private previous: T | undefined
  private snapshot: InspectorRecord | undefined

  /**
   * @param source - Existing keyed business source.
   * @param project - Raw metadata projection, evaluated only after its input changes.
   */
  constructor(
    private readonly source: ObservableSnapshot<T | undefined>,
    private readonly project: (value: T) => InspectorRecord,
  ) {}

  /** @returns Stable metadata for the current raw value. */
  getSnapshot = (): InspectorRecord | undefined => {
    const value = this.source.getSnapshot()
    if (value !== this.previous) {
      this.previous = value
      this.snapshot = value === undefined ? undefined : this.project(value)
    }
    return this.snapshot
  }

  /** @param listener - Row invalidation callback. @returns Its disposer. */
  subscribe = (listener: () => void): (() => void) => this.source.subscribe(listener)
}
