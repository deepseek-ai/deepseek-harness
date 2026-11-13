/** Diff note positions on the lines of one file of a GitLab merge request diff version. */

import { createHash } from 'node:crypto'
import type { ForgeLineComment } from '@deepseek-ai/dsh-experimental-forge'
import { parsePatch } from 'diff'

/** One changed file of a diff version. */
export interface VersionFile {
  /** Path on the old side. */
  readonly oldPath: string
  /** Path on the new side. */
  readonly newPath: string
  /** Unified diff of the file, with or without its `---` and `+++` lines. */
  readonly diff: string
}

/** The commits of the diff version a position addresses. */
export interface PositionVersion {
  /** Merge base the version's diff starts at. */
  readonly base: string
  /** Target branch tip GitLab recorded with the version. */
  readonly start: string
  /** Head the version's diff ends at. */
  readonly head: string
}

/** One line of a file's diff as a diff note position names it. */
interface PositionLine {
  /** `new` for an added line, `old` for a deleted line, null for a line both sides hold. */
  readonly type: 'new' | 'old' | null
  /** Line number on the old side, null for an added line. */
  readonly old_line: number | null
  /** Line number on the new side, null for a deleted line. */
  readonly new_line: number | null
  /** GitLab's line code: the SHA-1 of the file path and the line's numbers on both sides. */
  readonly line_code: string
}

/**
 * Build the `position` of a diff note on the lines of a comment. GitLab places a note only on a line whose numbers on
 * both sides it can match: an added line names its new line, a deleted line its old line, and a line both sides hold
 * names both, inside or outside the file's hunks. A range is the position of its last line with a `line_range` from its
 * first line to its last, each with GitLab's line code.
 * @param version - the commits of the diff version the comment addresses.
 * @param file - the commented file's diff in that version.
 * @param comment - the comment's side and lines.
 * @returns the position, or undefined when the diff does not hold the lines on that side or cannot be parsed.
 */
export function textPosition(version: PositionVersion, file: VersionFile, comment: ForgeLineComment): Record<string, unknown> | undefined {
  // GitLab's line codes hash the file's path on the new side, which a deleted file keeps.
  const hash = createHash('sha1').update(file.newPath).digest('hex')
  const end = lineOf(file.diff, comment.side, comment.endLine, hash)
  const start = comment.startLine === comment.endLine ? end : lineOf(file.diff, comment.side, comment.startLine, hash)
  if (end === undefined || start === undefined) return undefined
  return {
    position_type: 'text', base_sha: version.base, start_sha: version.start, head_sha: version.head,
    old_path: file.oldPath, new_path: file.newPath, old_line: end.old_line, new_line: end.new_line,
    ...comment.startLine === comment.endLine ? {} : { line_range: { start, end } },
  }
}

/**
 * Number one line of a side in a file's diff. Lines between and after hunks are unchanged, so their other side follows
 * from the lines the hunks before them added and deleted.
 * @param diff - the file's unified diff.
 * @param side - side the line numbers.
 * @param line - the line, from 1.
 * @param hash - SHA-1 of the file's path.
 * @returns the line on both sides, or undefined when the line is not on that side or the diff cannot be parsed.
 */
function lineOf(diff: string, side: 'L' | 'R', line: number, hash: string): PositionLine | undefined {
  let hunks: ReturnType<typeof parsePatch>[number]['hunks']
  try {
    hunks = parsePatch(diff).flatMap(file => file.hunks)
  } catch (error) {
    void error // A diff whose hunk counts disagree with its lines places no line.
    return undefined
  }
  if (line < 1) return undefined
  const found = (type: PositionLine['type'], oldPos: number, newPos: number): PositionLine => ({
    type, old_line: type === 'new' ? null : oldPos, new_line: type === 'old' ? null : newPos, line_code: `${hash}_${oldPos}_${newPos}`,
  })
  // Unchanged lines after the hunks read so far number this many more lines on the new side than on the old.
  let shift = 0
  for (const hunk of hunks) {
    // Git numbers a side without lines from the line before it, which the parser numbers from the line after.
    let oldPos = hunk.oldLines === 0 ? hunk.oldStart - 1 : hunk.oldStart
    let newPos = hunk.newLines === 0 ? hunk.newStart - 1 : hunk.newStart
    const first = side === 'R' ? newPos : oldPos
    if (line < first) break
    for (const text of hunk.lines) {
      if (text.startsWith('+')) {
        if (side === 'R' && newPos === line) return found('new', oldPos, newPos)
        newPos++
      } else if (text.startsWith('-')) {
        if (side === 'L' && oldPos === line) return found('old', oldPos, newPos)
        oldPos++
      } else if (!text.startsWith('\\')) {
        if ((side === 'R' ? newPos : oldPos) === line) return found(null, oldPos, newPos)
        oldPos++
        newPos++
      }
    }
    shift = newPos - oldPos
  }
  return side === 'R' ? found(null, line - shift, line) : found(null, line, line + shift)
}
