/**
 * Pure text updates following OpenAI Codex rust-v0.158.0 NormalizeToLf behavior.
 * Adapted from seek_sequence.rs and file_update.rs with structured match failures.
 * Copyright 2025 OpenAI. Apache-2.0 portions and modification notice: ../LICENSE.
 */

import type { ApplyHunksResult, PatchHunk } from './types.ts'

const WHITE_SPACE = /\p{White_Space}/u

function trimWhitespace(value: string, leading: boolean): string {
  let start = 0
  let end = value.length
  if (leading) {
    while (start < end && WHITE_SPACE.test(value.charAt(start))) start++
  }
  while (end > start && WHITE_SPACE.test(value.charAt(end - 1))) end--
  return value.slice(start, end)
}

function normalizePunctuation(value: string): string {
  return trimWhitespace(value, true)
    .replace(/[\u2010-\u2015\u2212]/gu, '-')
    .replace(/[\u2018-\u201B]/gu, "'")
    .replace(/[\u201C-\u201F]/gu, '"')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/gu, ' ')
}

const MATCH_PASSES = [
  (value: string) => value,
  (value: string) => trimWhitespace(value, false),
  (value: string) => trimWhitespace(value, true),
  normalizePunctuation,
]

/** NormalizeToLf checks only the tail candidate for EOF, even before the cursor. */
function seekSequence(lines: readonly string[], pattern: readonly string[], start: number, eof: boolean): number | undefined {
  if (pattern.length === 0) return start
  if (pattern.length > lines.length) return undefined
  const last = lines.length - pattern.length
  const first = eof ? last : start
  for (const normalize of MATCH_PASSES) {
    const expected = pattern.map(normalize)
    for (let index = first; index <= last; index++) {
      if (expected.every((line, offset) => normalize(lines[index + offset] as string) === line)) return index
    }
  }
  return undefined
}

interface Replacement {
  start: number
  oldLength: number
  newLines: readonly string[]
}

/**
 * Apply parsed hunks to LF-normalized text without I/O or input mutation.
 * All searches use the original text; a failed search returns no partial text.
 * Successful nonempty output ends in LF, including initially unterminated text.
 * @param before - text normalized by the caller; CR characters receive no line-ending handling.
 * @param hunks - ordered hunks from parsePatch; EOF searches follow NormalizeToLf tail semantics.
 * @returns new text or the first unmatched hunk, without throwing for a match failure.
 */
export function applyHunks(before: string, hunks: readonly PatchHunk[]): ApplyHunksResult {
  const original = before.split('\n')
  if (original.at(-1) === '') original.pop()
  const replacements: Replacement[] = []
  let lineIndex = 0

  for (const hunk of hunks) {
    if (hunk.context !== undefined) {
      const pattern = [hunk.context]
      const found = seekSequence(original, pattern, lineIndex, false)
      if (found === undefined) {
        return { ok: false, failure: { hunkLineNumber: hunk.lineNumber, stage: 'context', searchStart: lineIndex, pattern } }
      }
      lineIndex = found + 1
    }
    if (hunk.oldLines.length === 0) {
      const start = original.at(-1) === '' ? original.length - 1 : original.length
      replacements.push({ start, oldLength: 0, newLines: hunk.newLines })
      continue
    }

    let pattern = hunk.oldLines
    let newLines = hunk.newLines
    let found = seekSequence(original, pattern, lineIndex, hunk.isEndOfFile)
    if (found === undefined && pattern.at(-1) === '') {
      pattern = pattern.slice(0, -1)
      if (newLines.at(-1) === '') newLines = newLines.slice(0, -1)
      found = seekSequence(original, pattern, lineIndex, hunk.isEndOfFile)
    }
    if (found === undefined) {
      return {
        ok: false,
        failure: { hunkLineNumber: hunk.lineNumber, stage: 'oldLines', searchStart: lineIndex, pattern: [...hunk.oldLines] },
      }
    }
    replacements.push({ start: found, oldLength: pattern.length, newLines })
    lineIndex = found + pattern.length
  }

  // Stable ordering also preserves patch order for insertions at the same source index.
  replacements.sort((left, right) => left.start - right.start)
  let lines = original
  for (const replacement of replacements.reverse()) {
    lines = [
      ...lines.slice(0, replacement.start),
      ...replacement.newLines,
      ...lines.slice(replacement.start + replacement.oldLength),
    ]
  }
  if (lines.at(-1) !== '') lines.push('')
  return { ok: true, after: lines.join('\n') }
}
