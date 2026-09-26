/** Line comparison of two whole-file texts, bounded by a timeout that degrades to whole-file replacement. */
import { structuredPatch } from 'diff'
import type { WorkspaceDiffHunk } from './types.ts'

/** Context lines around each change, the unified-diff default. */
const CONTEXT_LINES = 3

/** Hunks, whether the timeout degraded them, and the changed-line totals they carry. */
export interface Comparison {
  hunks: WorkspaceDiffHunk[]
  coarse: boolean
  added: number
  deleted: number
}

/**
 * A side's text with every line terminated, so the last line compares by
 * content alone and empty text reads as no lines rather than one empty line.
 */
function terminated(text: string): string {
  return text === '' || text.endsWith('\n') ? text : `${text}\n`
}

/** Content lines of a terminated text; empty text is zero lines. */
function lines(text: string): string[] {
  return text === '' ? [] : text.slice(0, -1).split('\n')
}

/**
 * Compare two texts line by line. A side that is null means the file did not
 * exist. A comparison exceeding `timeoutMs` yields one hunk that deletes every
 * old line and adds every new line.
 * @param before - turn-start text, or null.
 * @param after - turn-end text, or null.
 * @param timeoutMs - milliseconds the line comparison may run.
 * @returns hunks and totals; no hunks when both sides hold the same lines.
 */
export function compareText(before: string | null, after: string | null, timeoutMs: number): Comparison {
  const oldText = terminated(before ?? '')
  const newText = terminated(after ?? '')
  const patch = structuredPatch('', '', oldText, newText, undefined, undefined, { context: CONTEXT_LINES, timeout: timeoutMs })
  let hunks: WorkspaceDiffHunk[]
  let coarse = false
  if (patch === undefined) {
    coarse = true
    const oldLines = lines(oldText)
    const newLines = lines(newText)
    hunks = [{
      oldStart: 1, oldLines: oldLines.length,
      newStart: 1, newLines: newLines.length,
      lines: [...oldLines.map(line => `-${line}`), ...newLines.map(line => `+${line}`)],
    }]
  } else {
    hunks = patch.hunks.map(({ oldStart, oldLines, newStart, newLines, lines: body }) =>
      ({ oldStart, oldLines, newStart, newLines, lines: body }))
  }
  let added = 0
  let deleted = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) deleted += 1
    }
  }
  return { hunks, coarse, added, deleted }
}
