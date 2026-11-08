/** Unified-diff row parsing and per-file body tokenization for markdown fences. @module dsh-client-ui-primitives/markdown/diff-fence */

import { languageForPath } from '../code-highlighting.ts'
import { highlightLines } from './highlight.ts'
import type { HighlightSpan } from './highlight.ts'

/** Fence info strings rendered as a unified diff instead of grammar-highlighted code. */
export const DIFF_FENCE_LANGUAGES = new Set(['diff', 'patch'])

/**
 * Whether a fence info string selects diff row rendering.
 * @param lang - the fence info string, case-insensitively compared.
 * @returns whether the fence is a unified diff.
 */
export function isDiffFenceLanguage(lang: string | undefined): boolean {
  return lang !== undefined && DIFF_FENCE_LANGUAGES.has(lang.toLowerCase())
}

/** One unified-diff line, split so the marker column stays out of the tokenized body. */
export interface DiffRow {
  /** Row role, which selects the line's diff class. */
  kind: 'add' | 'del' | 'context' | 'hunk' | 'meta'
  /** The marker column, kept verbatim so copy reproduces the source. */
  marker: string
  /** The code after the marker column, or the whole line for chrome rows. */
  body: string
  /** The full source line, rendered as-is for hunk and meta rows. */
  raw: string
  /** Index of the file section this row belongs to; -1 before any file header. */
  file: number
}

/** Parsed fence: rows plus the language each file section names. */
export interface DiffFence {
  /** The fence rows in source order. */
  rows: DiffRow[]
  /** Inner language per file section, when the header names a known one. */
  languages: ReadonlyMap<number, string>
}

/** File-level chrome a unified diff carries above and between hunks. */
const DIFF_META_PREFIXES = [
  'diff --git ', 'index ', 'old mode ', 'new mode ', 'new file mode ', 'deleted file mode ',
  'similarity index ', 'dissimilarity index ', 'rename from ', 'rename to ', 'copy from ', 'copy to ',
  'Binary files ', 'GIT binary patch', '\\ No newline',
]

/** Hunk header with both line counts; a missing count means one line. */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u

/** Lines the hunk header says remain on each side. */
interface HunkRemainder {
  /** Unconsumed old-side lines. */
  old: number
  /** Unconsumed new-side lines. */
  new: number
}

/**
 * Parse a hunk header's line budget.
 * @param raw - the `@@ -a,b +c,d @@` line.
 * @returns the remaining line counts, or `undefined` for a malformed header.
 */
function hunkRemainder(raw: string): HunkRemainder | undefined {
  const match = HUNK_HEADER.exec(raw)
  if (match === null) return undefined
  return {
    old: match[2] === undefined ? 1 : Number(match[2]),
    new: match[4] === undefined ? 1 : Number(match[4]),
  }
}

/** Whether a raw line is file-level chrome rather than hunk content. */
function isDiffMeta(raw: string): boolean {
  return DIFF_META_PREFIXES.some(prefix => raw.startsWith(prefix))
}

/**
 * Resolve the inner language a `---`/`+++` header names.
 * @param raw - the header line.
 * @returns the language id, or `undefined` for `/dev/null` or an unknown path.
 */
function headerLanguage(raw: string): string | undefined {
  const path = raw.slice(4).replace(/\t.*$/u, '').trim()
  const unquoted = path.startsWith('"') && path.endsWith('"')
    ? path.slice(1, -1).replace(/\\(["\\])/gu, '$1')
    : path
  if (unquoted === '' || unquoted === '/dev/null') return undefined
  return languageForPath(unquoted.replace(/^[ab]\//u, ''))
}

/**
 * Split a unified diff into rows without losing a byte (copy reads the DOM).
 *
 * The hunk header's line budget ends a hunk, so a following `---` / `+++` file
 * header is chrome again — both for a concatenated `git diff` and for `diff -u`
 * output without `diff --git` lines. A malformed header keeps the row until the
 * next `diff --git`, matching how authored fences are rendered.
 * @param code - the fence body, display-trimmed.
 * @returns the rows and each file section's language.
 */
export function parseDiffFence(code: string): DiffFence {
  const rows: DiffRow[] = []
  const languages = new Map<number, string>()
  let inHunk = false
  let remainder: HunkRemainder | undefined
  let file = -1

  const push = (row: Omit<DiffRow, 'file'>): void => {
    rows.push({ ...row, file })
  }

  for (const raw of code.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      inHunk = false
      remainder = undefined
      push({ kind: 'meta', marker: '', body: '', raw })
      continue
    }
    if (raw.startsWith('@@')) {
      inHunk = true
      remainder = hunkRemainder(raw)
      push({ kind: 'hunk', marker: '', body: '', raw })
      continue
    }
    // A file header carries a marker column but names the file, not a line.
    if (!inHunk && (raw.startsWith('--- ') || raw.startsWith('+++ '))) {
      if (raw.startsWith('--- ')) file += 1
      const language = headerLanguage(raw)
      if (language !== undefined) languages.set(file, language)
      push({ kind: 'meta', marker: '', body: '', raw })
      continue
    }
    if (isDiffMeta(raw)) {
      push({ kind: 'meta', marker: '', body: '', raw })
      continue
    }
    if (raw.startsWith('+')) {
      if (remainder !== undefined) remainder.new -= 1
      push({ kind: 'add', marker: '+', body: raw.slice(1), raw })
    } else if (raw.startsWith('-')) {
      if (remainder !== undefined) remainder.old -= 1
      push({ kind: 'del', marker: '-', body: raw.slice(1), raw })
    } else if (raw.startsWith(' ')) {
      if (remainder !== undefined) {
        remainder.old -= 1
        remainder.new -= 1
      }
      push({ kind: 'context', marker: ' ', body: raw.slice(1), raw })
    } else {
      // Authored diffs may omit the context marker column; the text is the body.
      push({ kind: 'context', marker: '', body: raw, raw })
    }
    if (inHunk && remainder !== undefined && remainder.old <= 0 && remainder.new <= 0) inHunk = false
  }
  return { rows, languages }
}

/**
 * Whether a row carries code the body highlighter tokenizes.
 * @param row - the parsed row.
 * @returns whether the row has tokenizable body text.
 */
export function isDiffContent(row: DiffRow): boolean {
  return row.kind === 'add' || row.kind === 'del' || row.kind === 'context'
}

/**
 * Tokenize each file's old side (context and deletions) and new side (context
 * and additions) separately, so an unterminated comment or string in a removed
 * line cannot color the added lines and one file's grammar never applies to the
 * next. Context rows keep the old-side runs.
 * @param diff - parsed fence rows and per-file languages.
 * @returns token runs per content-row index, or `undefined` when no body has a
 * loaded grammar and the caller should render plain text.
 */
export function diffFenceTokens(diff: DiffFence): Map<number, readonly HighlightSpan[]> | undefined {
  const groups = new Map<string, Array<{ row: number; body: string; kind: DiffRow['kind'] }>>()
  for (const [index, row] of diff.rows.entries()) {
    if (!isDiffContent(row)) continue
    const sides: Array<'old' | 'new'> = row.kind === 'del'
      ? ['old']
      : row.kind === 'add' ? ['new'] : ['old', 'new']
    for (const side of sides) {
      const key = `${row.file}:${side}`
      const entry = { row: index, body: row.body, kind: row.kind }
      const list = groups.get(key)
      if (list === undefined) groups.set(key, [entry])
      else list.push(entry)
    }
  }
  if (groups.size === 0) return undefined

  const tokens = new Map<number, readonly HighlightSpan[]>()
  let highlighted = false
  for (const [key, entries] of groups) {
    const separator = key.lastIndexOf(':')
    const language = diff.languages.get(Number(key.slice(0, separator)))
    const side = key.slice(separator + 1)
    const lines = highlightLines(entries.map(entry => entry.body).join('\n'), language)
    if (lines === undefined) continue
    highlighted = true
    entries.forEach((entry, lineIndex) => {
      // A group ending in an empty body line loses shiki's terminal empty row;
      // that row stays plain while its siblings keep their tokens.
      const line = lines[lineIndex] ?? []
      // Context runs come from the old side; added rows only exist on the new side.
      if (side === 'old' || entry.kind === 'add') tokens.set(entry.row, line)
    })
  }
  return highlighted ? tokens : undefined
}
