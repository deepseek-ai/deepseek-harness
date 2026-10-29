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

/** A run of drawn rows, or unchanged lines drawn as one row that expands them. */
export type DiffSegment =
  | { readonly kind: 'rows'; readonly rows: readonly DiffRow[] }
  /**
   * `index` is the hunk the lines precede, or the hunk count for the lines after the last hunk;
   * `count` is null while the length of the file is unknown.
   */
  | { readonly kind: 'gap'; readonly index: number; readonly count: number | null }

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
 * collapse into one gap each; an open gap draws its lines from `lines` once
 * they are known. The lines after the last hunk are unknown until `lines`
 * arrives, unless the file is new, deleted, or its last hunk reaches its end.
 * @param file - one file of a diff.
 * @param lines - the file's new side, which {@link matchesHunks} accepted, or undefined while it has not been read.
 * @param open - indexes of the gaps the user expanded.
 * @returns the segments in file order.
 */
export function segmentsOf(file: ForgeDiffFile, lines: readonly string[] | undefined, open: ReadonlySet<number>): DiffSegment[] {
  const segments: DiffSegment[] = []
  let rows: DiffRow[] = []
  const flush = (): void => {
    if (rows.length > 0) segments.push({ kind: 'rows', rows })
    rows = []
  }
  /** Unchanged new-side lines `from` to `to`, null while unknown, whose old numbers are `offset` higher. */
  const gap = (index: number, from: number, to: number | null, offset: number): void => {
    if (lines !== undefined && to !== null && open.has(index)) {
      for (const [at, text] of lines.slice(from - 1, to).entries()) {
        rows.push({ kind: 'context', old: from + at + offset, new: from + at, text: drawn(text) })
      }
      return
    }
    flush()
    segments.push({ kind: 'gap', index, count: to === null ? null : to - from + 1 })
  }
  let newEnd = 0
  let oldEnd = 0
  for (const [index, hunk] of file.hunks.entries()) {
    if (hunk.newStart - 1 > newEnd) gap(index, newEnd + 1, hunk.newStart - 1, hunk.oldStart - hunk.newStart)
    rows.push(...hunkRows(hunk))
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
