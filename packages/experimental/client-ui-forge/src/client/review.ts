/** Frozen line selections shared by the diff UI, composer references, and review submission. */

import type { ForgeDiffFile } from '../types.ts'

/** A comment on consecutive lines of one side of one displayed hunk. */
export interface ReviewComment {
  /** Repository-relative destination path, including for renamed files. */
  readonly path: string
  /** Old or new side of the displayed diff. */
  readonly side: 'L' | 'R'
  /** First selected line, inclusive. */
  readonly startLine: number
  /** Last selected line, inclusive. */
  readonly endLine: number
  /** Complete displayed hunk captured before subsequent file changes. */
  readonly hunk: string
  /** User's plain-text comment. */
  readonly body: string
}

/** The immutable source from which a comment was selected. */
export type ReviewSource =
  | { readonly kind: 'local'; readonly scope: string }
  | { readonly kind: 'change'; readonly url: string; readonly headSha: string }

/** One selected range and the source the user saw. */
export interface ReviewSelection {
  readonly source: ReviewSource
  readonly comment: ReviewComment
}

/**
 * Capture a range only when both endpoints belong to the same displayed hunk.
 * @param file - loaded diff file.
 * @param side - selected side.
 * @param from - first gesture endpoint.
 * @param to - current gesture endpoint.
 * @returns a frozen selection, or undefined for unchanged gaps or cross-hunk ranges.
 */
export function selectReviewLines(file: ForgeDiffFile, side: 'L' | 'R', from: number, to: number): ReviewComment | undefined {
  const startLine = Math.min(from, to)
  const endLine = Math.max(from, to)
  const hunk = file.hunks.find((item) => {
    const start = side === 'L' ? item.oldStart : item.newStart
    const count = side === 'L' ? item.oldLines : item.newLines
    return startLine >= start && endLine < start + count
  })
  if (hunk === undefined) return undefined
  const oldStart = hunk.oldLines === 0 ? hunk.oldStart - 1 : hunk.oldStart
  const newStart = hunk.newLines === 0 ? hunk.newStart - 1 : hunk.newStart
  return {
    path: file.path, side, startLine, endLine, body: '',
    hunk: [`@@ -${oldStart},${hunk.oldLines} +${newStart},${hunk.newLines} @@`, ...hunk.lines].join('\n'),
  }
}

/**
 * Format a frozen reference for the ordinary, logged user message.
 * @param selection - source, range, displayed patch, and user comment.
 * @param index - one-based reference number in the composer.
 * @returns Markdown content for an atomic composer quote.
 */
export function formatReviewComment(selection: ReviewSelection, index: number): string {
  const { source, comment } = selection
  const range = comment.startLine === comment.endLine ? String(comment.startLine) : `${comment.startLine}-${comment.endLine}`
  // A longer fence keeps code containing Markdown fences inside the quoted hunk.
  const fence = '`'.repeat(Math.max(3, ...Array.from(comment.hunk.matchAll(/`+/g), match => match[0].length + 1)))
  const origin = source.kind === 'local' ? `Source: Local (${source.scope})` : `Source: ${source.url}\nCommit: ${source.headSha}`
  return `## User Comment ${index}\nFile: ${comment.path}\nSide: ${comment.side}\nLines: ${range}\n${origin}\nDiff hunk:\n${fence}diff\n${comment.hunk}\n${fence}\nComment:\n${comment.body}`
}

/**
 * Check whether the current diff still contains the captured range and hunk.
 * @param selection - saved comment source and patch.
 * @param source - currently displayed review source.
 * @param file - current diff file.
 * @returns whether an inline record can retain its original line placement.
 */
export function reviewMatches(selection: ReviewSelection, source: ReviewSource, file: ForgeDiffFile): boolean {
  if (selection.source.kind === 'change' && (source.kind !== 'change' || source.headSha !== selection.source.headSha)) return false
  const comment = selection.comment
  return selectReviewLines(file, comment.side, comment.startLine, comment.endLine)?.hunk === comment.hunk
}
