/**
 * Where the changes view shows each review thread of a change request, the order a file shows them in, which threads
 * each filter of the thread list keeps, and the composer quote of a whole thread.
 */

import type { QuoteSummary } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ForgeAnchor, ForgeReviewThread } from '@deepseek-ai/dsh-experimental-forge/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ForgeCommitRange, ForgeDiffFile, ForgeDiffHunk } from '../types.ts'
import { hunkRows } from './diff-rows.ts'

/** The changes a view shows, which decides where a thread can sit. */
export interface ThreadView {
  /** Head commit the threads were read at. */
  readonly head: string
  /** Commit the shown changes end at: the head, or the last chosen commit. */
  readonly end: string
  /** Chosen consecutive commits, or null for the whole change request. */
  readonly commits: ForgeCommitRange | null
}

/**
 * Where a thread shows in the changes view: on lines of one side, at the top of its file, in its file's outdated
 * section, or nowhere in the file because the chosen commits do not hold the lines it is on.
 */
export type ThreadPlace =
  | { readonly kind: 'line'; readonly side: 'L' | 'R'; readonly startLine: number; readonly endLine: number }
  | { readonly kind: 'file' }
  | { readonly kind: 'outdated' }
  | { readonly kind: 'elsewhere' }

/** One filter of the thread list: the threads by whether they are resolved. */
export type ThreadFilter = 'unresolved' | 'resolved' | 'all'

/** Filters of the thread list in display order. */
export const THREAD_FILTERS: readonly ThreadFilter[] = ['unresolved', 'resolved', 'all']

/**
 * Place a thread in a view. The whole change request shows a thread at its position on the head. Chosen commits show
 * only a new-side thread whose lines number the file at the last chosen commit: its position on the head when the
 * commits end at the head, else the lines it was written on at that commit. The old side of chosen commits starts
 * at the parent of the first commit, which no thread position numbers.
 * @param thread - the thread.
 * @param view - the shown changes.
 * @returns where the thread shows.
 */
export function placeThread(thread: ForgeReviewThread, view: ThreadView): ThreadPlace {
  if (thread.subject === 'file') return { kind: 'file' }
  if (view.commits === null) return thread.current === null ? { kind: 'outdated' } : onLines(thread.side, thread.current)
  if (thread.side === 'R' && thread.current !== null && view.end === view.head) return onLines('R', thread.current)
  if (thread.side === 'R' && thread.original !== null && thread.original.commit === view.end) return onLines('R', thread.original)
  return thread.current === null ? { kind: 'outdated' } : { kind: 'elsewhere' }
}

function onLines(side: 'L' | 'R', anchor: ForgeAnchor): ThreadPlace {
  return { kind: 'line', side, startLine: anchor.startLine, endLine: anchor.endLine }
}

/**
 * Name a side and lines, such as `R12` or `L3–5`.
 * @param side - old or new side.
 * @param anchor - the lines.
 * @returns the range label.
 */
export function anchorRange(side: 'L' | 'R', anchor: Pick<ForgeAnchor, 'startLine' | 'endLine'>): string {
  return `${side}${anchor.startLine}${anchor.endLine === anchor.startLine ? '' : `–${anchor.endLine}`}`
}

/** Where a line of a diff file is: in the collapsed lines before a hunk or after the last one, or in a hunk. */
type LineSpot = { readonly kind: 'gap'; readonly index: number } | { readonly kind: 'hunk'; readonly index: number; readonly hunk: ForgeDiffHunk }

function spotOf(file: ForgeDiffFile, side: 'L' | 'R', line: number): LineSpot {
  for (const [index, hunk] of file.hunks.entries()) {
    const start = side === 'L' ? hunk.oldStart : hunk.newStart
    const count = side === 'L' ? hunk.oldLines : hunk.newLines
    if (line < start) return { kind: 'gap', index }
    if (line < start + count) return { kind: 'hunk', index, hunk }
  }
  return { kind: 'gap', index: file.hunks.length }
}

/**
 * Find the collapsed unchanged lines that hold a line: the index of the hunk they precede, or the hunk count after the last hunk.
 * @param file - the diff file.
 * @param side - side the line numbers.
 * @param line - the line.
 * @returns the gap index, or undefined when a hunk shows the line.
 */
export function gapOf(file: ForgeDiffFile, side: 'L' | 'R', line: number): number | undefined {
  const spot = spotOf(file, side, line)
  return spot.kind === 'gap' ? spot.index : undefined
}

/**
 * Order a file's threads as its section shows them: threads on the whole file, then threads on lines by the row of their
 * last line, then outdated threads, then threads the chosen commits do not show. Threads on unchanged lines sort
 * by the collapsed lines that hold them.
 * @param items - threads of one file with their places.
 * @param file - the file's diff, or undefined when the shown changes lack the file.
 * @returns the threads in display order.
 */
export function inFileOrder<Item extends { readonly place: ThreadPlace }>(items: readonly Item[], file: ForgeDiffFile | undefined): Item[] {
  const rank = ({ place }: Item): readonly [number, number, number] => {
    switch (place.kind) {
      case 'file': return [0, 0, 0]
      case 'line': return [1, ...rowOf(file, place.side, place.endLine)]
      case 'outdated': return [2, 0, 0]
      case 'elsewhere': return [3, 0, 0]
      /* v8 ignore next -- closed ThreadPlace union exhaustiveness guard */
      default: return assertNever(place, 'ThreadPlace')
    }
  }
  const keyed = items.map(item => [rank(item), item] as const)
  return keyed.toSorted(([a], [b]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]).map(([, item]) => item)
}

/**
 * Where a line draws: twice the index of the collapsed lines that hold it, or twice a hunk's index plus one with the
 * line's row in that hunk, so rows of one hunk keep their patch order across both sides.
 */
function rowOf(file: ForgeDiffFile | undefined, side: 'L' | 'R', line: number): readonly [number, number] {
  if (file === undefined) return [0, line]
  const spot = spotOf(file, side, line)
  if (spot.kind === 'gap') return [2 * spot.index, line]
  return [2 * spot.index + 1, hunkRows(spot.hunk).findIndex(row => (side === 'L' ? row.old : row.new) === line)]
}

/**
 * Whether a thread passes a filter of the thread list.
 * @param thread - the thread.
 * @param filter - the filter.
 * @returns whether the list shows the thread.
 */
export function passesFilter(thread: ForgeReviewThread, filter: ThreadFilter): boolean {
  switch (filter) {
    case 'unresolved': return !thread.resolved
    case 'resolved': return thread.resolved
    case 'all': return true
    /* v8 ignore next -- closed ThreadFilter union exhaustiveness guard */
    default: return assertNever(filter, 'ThreadFilter')
  }
}

/** Lines of a recorded diff hunk shown before its last line, beside the lines the thread is on. */
const EXCERPT_CONTEXT = 3

/**
 * Cut a recorded diff hunk to its header and the lines that end it: the thread's lines on its side plus a few before.
 * GitHub records the hunk up to the thread's last line.
 * @param hunk - the recorded hunk, header first.
 * @param side - side the thread's lines number.
 * @param lines - how many lines the thread covers.
 * @returns the header and the kept lines.
 */
export function hunkExcerpt(hunk: string, side: 'L' | 'R', lines: number): { readonly header: string | null; readonly lines: readonly string[] } {
  const header = hunk.startsWith('@@') ? hunk.split('\n', 1).join('') : null
  const body = (header === null ? hunk : hunk.slice(header.length + 1)).split('\n')
  const other = side === 'L' ? '+' : '-'
  const kept: string[] = []
  let wanted = lines + EXCERPT_CONTEXT
  for (const line of body.toReversed()) {
    if (wanted === 0) break
    kept.push(line)
    if (!line.startsWith(other)) wanted -= 1
  }
  return { header, lines: kept.reverse() }
}

/**
 * Describe a composer quote of a thread by its file, range, and first comment.
 * @param thread - the quoted thread.
 * @param range - the thread's range label, or null for a file thread.
 * @returns the composer's display of the quote.
 */
export function threadQuoteSummary(thread: ForgeReviewThread, range: string | null): QuoteSummary {
  const name = thread.path.slice(thread.path.lastIndexOf('/') + 1)
  return { label: range === null ? name : `${name} ${range}`, title: thread.path, detail: range ?? thread.path, body: thread.comments[0]?.body ?? '' }
}

/**
 * Format a whole thread for the ordinary, logged user message. Comment bodies are quoted line by line, so their
 * Markdown cannot add headings to the message.
 * @param thread - the thread.
 * @param url - web page of the change request.
 * @param index - one-based thread number in the composer.
 * @returns Markdown content for an atomic composer quote.
 */
export function formatThreadQuote(thread: ForgeReviewThread, url: string, index: number): string {
  const anchor = thread.current ?? thread.original
  const lines = anchor === null ? '' : anchor.startLine === anchor.endLine ? `${anchor.startLine}` : `${anchor.startLine}-${anchor.endLine}`
  // Old-side lines number the file at the diff's base, so the quote names the commit only as where that diff ends.
  const where = thread.subject === 'file' || anchor === null ? 'Lines: whole file'
    : thread.side === 'R' ? `Side: R\nLines: ${lines}\nCommit: ${anchor.commit}`
      : `Side: L (old side: the lines number the file before the pull request's changes)\nLines: ${lines}\nDiff head: ${anchor.commit}`
  const state = [thread.resolved ? 'resolved' : 'unresolved', ...thread.subject === 'line' && thread.current === null ? ['outdated'] : []].join(', ')
  const fence = thread.diffHunk === null ? '' : '`'.repeat(Math.max(3, ...Array.from(thread.diffHunk.matchAll(/`+/g), match => match[0].length + 1)))
  const hunk = thread.diffHunk === null ? '' : `Diff hunk:\n${fence}diff\n${thread.diffHunk}\n${fence}\n`
  // A blank comment line becomes a bare `>` and comments follow one another without blank lines, since the composer
  // quotes every line of the reference again.
  const comments = thread.comments.map(comment => `${comment.author === null ? 'Unknown author' : `@${comment.author.login}`} (${comment.createdAt}):\n`
    + comment.body.split('\n').map(line => line.trim() === '' ? '>' : `> ${line}`).join('\n')).join('\n')
  const link = thread.comments[0]?.url ?? url
  return `## Review Thread ${index}\nFile: ${thread.path}\n${where}\nState: ${state}\nSource: ${link}\n${hunk}Comments:\n${comments}`
}
