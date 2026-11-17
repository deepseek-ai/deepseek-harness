/**
 * Drawn rows of one file diff: numbered patch lines, their side-by-side
 * pairing, and the unchanged lines between hunks, which stay collapsed until
 * the file's new side supplies them.
 */

import type { ForgeDiffFile, ForgeDiffHunk } from '../types.ts'

/** One drawn line with its number on each side that has it. */
export type DiffRow =
  | { readonly kind: 'add'; readonly old: null; readonly new: number; readonly text: string }
  | { readonly kind: 'del'; readonly old: number; readonly new: null; readonly text: string }
  | { readonly kind: 'context'; readonly old: number; readonly new: number; readonly text: string }

/** One side of a side-by-side row. */
export interface SplitCell {
  readonly kind: DiffRow['kind']
  readonly no: number
  readonly text: string
}

/** One side-by-side row; a side without a line is null. */
export interface SplitRow {
  readonly left: SplitCell | null
  readonly right: SplitCell | null
}

/** Unchanged lines one step of a gap shows, and the most a gap shows on one click: the step of GitHub's and GitLab's diffs. */
export const EXPAND_STEP = 20

/** The lines a gap shows: `top` continue the hunk above it, `bottom` lead into the hunk below it. */
export interface GapReveal {
  readonly top: number
  readonly bottom: number
}

/** How a click expands a gap: one step down from the hunk above it, one step up from the hunk below it, or wholly. */
export type GapExpansion = 'down' | 'up' | 'all'

/** Where a gap sits: before the first hunk, between two hunks, or after the last hunk. */
export type GapEdge = 'leading' | 'middle' | 'trailing'

/** A run of drawn rows, or unchanged lines drawn as one row that expands them. */
export type DiffSegment =
  | { readonly kind: 'rows'; readonly rows: readonly DiffRow[] }
  /**
   * `index` is the hunk the lines precede, or the hunk count for the lines after the last hunk; `count` is null while
   * the length of the file is unknown. The hidden lines are new-side lines `from` to `to`, null while unknown, whose old
   * numbers are `offset` higher.
   */
  | {
    readonly kind: 'gap'
    readonly index: number
    readonly count: number | null
    readonly edge: GapEdge
    readonly from: number
    readonly to: number | null
    readonly offset: number
  }
  /** Consecutive hunks a filter lens folds, drawn as one row that shows them, with the unchanged lines between them. */
  | { readonly kind: 'folded'; readonly hunks: readonly number[] }

const NO_FOLDS: ReadonlySet<number> = new Set()

/** A line as drawn: without the carriage return of a CRLF line ending. */
function drawn(text: string): string {
  return text.endsWith('\r') ? text.slice(0, -1) : text
}

/**
 * Number the lines of a hunk. Context lines count on both sides, deletions on
 * the old side, and additions on the new side; a `\ No newline at end of file`
 * marker is not a line.
 * @param hunk - one hunk.
 * @returns the rows in patch order.
 */
export function hunkRows(hunk: ForgeDiffHunk): DiffRow[] {
  let oldNo = hunk.oldStart
  let newNo = hunk.newStart
  const rows: DiffRow[] = []
  for (const line of hunk.lines) {
    const sign = line.charAt(0)
    const text = drawn(line.slice(1))
    if (sign === '+') rows.push({ kind: 'add', old: null, new: newNo++, text })
    else if (sign === '-') rows.push({ kind: 'del', old: oldNo++, new: null, text })
    else if (sign !== '\\') rows.push({ kind: 'context', old: oldNo++, new: newNo++, text })
  }
  return rows
}

/**
 * Pair rows for the side-by-side view: each run of deletions sits beside the
 * run of additions that follows it, row by row, and context rows fill both sides.
 * @param rows - rows in patch order.
 * @returns the paired rows.
 */
export function splitRows(rows: readonly DiffRow[]): SplitRow[] {
  const paired: SplitRow[] = []
  let deleted: SplitCell[] = []
  let added: SplitCell[] = []
  const flush = (): void => {
    for (let at = 0; at < Math.max(deleted.length, added.length); at++) {
      paired.push({ left: deleted[at] ?? null, right: added[at] ?? null })
    }
    deleted = []
    added = []
  }
  for (const row of rows) {
    switch (row.kind) {
      case 'del':
        if (added.length > 0) flush()
        deleted.push({ kind: 'del', no: row.old, text: row.text })
        break
      case 'add':
        added.push({ kind: 'add', no: row.new, text: row.text })
        break
      case 'context':
        flush()
        paired.push({ left: { kind: 'context', no: row.old, text: row.text }, right: { kind: 'context', no: row.new, text: row.text } })
        break
    }
  }
  flush()
  return paired
}

/**
 * Split file text into lines as a patch numbers them; a final line ending ends the last line.
 * @param text - the file text.
 * @returns the lines with any carriage returns kept.
 */
export function textLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * Whether file text is the new side the hunks describe: every context and
 * added line sits at its number. A file changed after its diff was read fails.
 * @param lines - the file's lines.
 * @param hunks - hunks of the file's diff.
 * @returns whether the lines match.
 */
export function matchesHunks(lines: readonly string[], hunks: readonly ForgeDiffHunk[]): boolean {
  return hunks.every((hunk) => {
    let at = hunk.newStart - 1
    for (const line of hunk.lines) {
      const sign = line.charAt(0)
      if (sign === '-' || sign === '\\') continue
      if (lines[at] !== line.slice(1)) return false
      at++
    }
    return true
  })
}

/** Whether the hunk ends the new side: a missing-newline marker follows one of its new-side lines. */
function endsNewSide(hunk: ForgeDiffHunk): boolean {
  let previous = '-'
  for (const line of hunk.lines) {
    if (line.startsWith('\\') && !previous.startsWith('-')) return true
    previous = line
  }
  return false
}

/**
 * Lay out one file as runs of rows separated by collapsed unchanged lines.
 * Unchanged lines before a hunk, between hunks, and after the last hunk
 * collapse into one gap each; once `lines` is known, a gap draws the lines its
 * reveal shows at its top and bottom, and a gap whose reveal covers it joins
 * the rows around it. The lines after the last hunk are unknown until `lines`
 * arrives, unless the file is new, deleted, or its last hunk reaches its end. Consecutive folded hunks draw as one
 * folded segment that takes the unchanged lines between them too.
 * @param file - one file of a diff.
 * @param lines - the file's new side, which {@link matchesHunks} accepted, or undefined while it has not been read.
 * @param open - the lines each expanded gap shows, by gap index.
 * @param folded - indexes of the hunks a filter lens folds.
 * @returns the segments in file order.
 */
export function segmentsOf(
  file: ForgeDiffFile, lines: readonly string[] | undefined, open: ReadonlyMap<number, GapReveal>, folded: ReadonlySet<number> = NO_FOLDS,
): DiffSegment[] {
  const segments: DiffSegment[] = []
  let rows: DiffRow[] = []
  const flush = (): void => {
    if (rows.length > 0) segments.push({ kind: 'rows', rows })
    rows = []
  }
  /** Draw unchanged new-side lines `first` to `last` of the known file, whose old numbers are `offset` higher. */
  const context = (known: readonly string[], first: number, last: number, offset: number): void => {
    for (const [at, text] of known.slice(first - 1, last).entries()) {
      rows.push({ kind: 'context', old: first + at + offset, new: first + at, text: drawn(text) })
    }
  }
  /** Unchanged new-side lines `from` to `to`, null while unknown, whose old numbers are `offset` higher. */
  const gap = (index: number, from: number, to: number | null, offset: number): void => {
    const edge: GapEdge = index === 0 ? 'leading' : index === file.hunks.length ? 'trailing' : 'middle'
    const reveal = open.get(index)
    if (lines === undefined || to === null || reveal === undefined) {
      flush()
      segments.push({ kind: 'gap', index, count: to === null ? null : to - from + 1, edge, from, to, offset })
      return
    }
    const total = to - from + 1
    const top = Math.min(reveal.top, total)
    const bottom = Math.min(reveal.bottom, total - top)
    context(lines, from, from + top - 1, offset)
    if (top + bottom < total) {
      flush()
      segments.push({ kind: 'gap', index, count: total - top - bottom, edge, from: from + top, to: to - bottom, offset })
    }
    context(lines, to - bottom + 1, to, offset)
  }
  let newEnd = 0
  let oldEnd = 0
  let run: number[] | null = null
  for (const [index, hunk] of file.hunks.entries()) {
    if (run !== null && folded.has(index)) run.push(index)
    else {
      run = null
      if (hunk.newStart - 1 > newEnd) gap(index, newEnd + 1, hunk.newStart - 1, hunk.oldStart - hunk.newStart)
      if (folded.has(index)) {
        flush()
        run = [index]
        segments.push({ kind: 'folded', hunks: run })
      } else rows.push(...hunkRows(hunk))
    }
    newEnd = hunk.newStart + hunk.newLines - 1
    oldEnd = hunk.oldStart + hunk.oldLines - 1
  }
  const last = file.hunks.at(-1)
  if (last !== undefined && file.status !== 'added' && file.status !== 'deleted' && !endsNewSide(last)) {
    if (lines === undefined) gap(file.hunks.length, newEnd + 1, null, oldEnd - newEnd)
    else if (lines.length > newEnd) gap(file.hunks.length, newEnd + 1, lines.length, oldEnd - newEnd)
  }
  flush()
  return segments
}

/**
 * Show more of one gap: a step down from the hunk above it, a step up from the hunk below it, or all of it.
 * @param open - the lines each expanded gap of a file shows, by gap index.
 * @param index - the gap.
 * @param expansion - which way the gap expands.
 * @returns the reveals with that gap's widened.
 */
export function revealGap(
  open: ReadonlyMap<number, GapReveal> | undefined, index: number, expansion: GapExpansion,
): ReadonlyMap<number, GapReveal> {
  const previous = open?.get(index) ?? { top: 0, bottom: 0 }
  const next = expansion === 'all' ? { top: Number.POSITIVE_INFINITY, bottom: 0 }
    : expansion === 'down' ? { ...previous, top: previous.top + EXPAND_STEP } : { ...previous, bottom: previous.bottom + EXPAND_STEP }
  return new Map([...open ?? [], [index, next]])
}

/**
 * Whether a gap still hides a line.
 * @param gap - the gap segment.
 * @param side - the side that numbers the line.
 * @param line - the line.
 * @returns whether the line is among the gap's hidden lines.
 */
export function hidesLine(gap: Extract<DiffSegment, { kind: 'gap' }>, side: 'L' | 'R', line: number): boolean {
  const at = side === 'L' ? line - gap.offset : line
  return at >= gap.from && (gap.to === null || at <= gap.to)
}

/**
 * Count the rows a file's hunks draw.
 * @param file - one file of a diff.
 * @returns the number of context, added, and deleted lines in its hunks.
 */
export function drawnLines(file: ForgeDiffFile): number {
  let count = 0
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (!line.startsWith('\\')) count++
    }
  }
  return count
}
