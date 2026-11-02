/**
 * Batch parser following OpenAI Codex rust-v0.158.0 parser.rs and streaming_parser.rs.
 * Adapted into a pure TypeScript parser with original-input diagnostics and no environment routing.
 * Copyright 2025 OpenAI. Apache-2.0 portions and modification notice: ../LICENSE.
 */

import type { PatchHunk, PatchOperation } from './types.ts'

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'
const EOF = '*** End of File'
const MOVE = '*** Move to: '
const ADD = '*** Add File: '
const DELETE = '*** Delete File: '
const UPDATE = '*** Update File: '

/** Rust uses Unicode White_Space (all in the BMP); JavaScript trim also removes BOM. */
const WHITE_SPACE = /\p{White_Space}/u

/** Syntax failure with a one-based line in the original input, including any wrapper. */
export class PatchParseError extends Error {
  constructor(readonly lineNumber: number, readonly reason: string) {
    super(`Invalid patch at line ${lineNumber}: ${reason}`)
    this.name = 'PatchParseError'
  }
}

/** Scan the ends to avoid regex backtracking over long interior whitespace. */
function trim(value: string): string {
  let start = 0
  while (start < value.length && WHITE_SPACE.test(value.charAt(start))) start++
  return trimEnd(value.slice(start))
}

function trimEnd(value: string): string {
  let end = value.length
  while (end > 0 && WHITE_SPACE.test(value.charAt(end - 1))) end--
  return value.slice(0, end)
}

interface InputLine {
  text: string
  number: number
}

function patchLines(patch: string): InputLine[] {
  const leading = patch.slice(0, patch.length - patch.replace(/^\p{White_Space}+/u, '').length)
  const offset = leading.split('\n').length - 1
  let lines = trim(patch).split(/\r?\n/u).map((text, index) => ({ text, number: offset + index + 1 }))
  const first = lines[0] as InputLine
  const last = lines.at(-1) as InputLine
  if (['<<EOF', "<<'EOF'", '<<"EOF"'].includes(first.text) && last.text.endsWith('EOF') && lines.length >= 4) {
    lines = lines.slice(1, -1)
  }
  // split always yields a line; removing a wrapper retains at least two lines.
  const start = lines[0] as InputLine
  const end = lines.at(-1) as InputLine
  if (trim(start.text) !== BEGIN) {
    throw new PatchParseError(start.number, `Expected '${BEGIN}'`)
  }
  if (trim(end.text) !== END) {
    throw new PatchParseError(end.number, `Expected '${END}'`)
  }
  // Codex joins Rust str::lines output, then its streaming parser strips CR before LF again.
  return lines.map((line, index) => index < lines.length - 1
    ? { ...line, text: line.text.replace(/\r$/u, '') }
    : line)
}

function emptyHunk(hunk: PatchHunk): boolean {
  return hunk.oldLines.length === 0 && hunk.newLines.length === 0
}

function ensureUpdate(operation: PatchOperation | undefined, lineNumber: number): void {
  if (operation?.kind !== 'update') return
  const last = operation.hunks.at(-1)
  if (last === undefined) {
    throw new PatchParseError(operation.lineNumber, `Update for '${operation.path}' requires at least one hunk`)
  }
  if (emptyHunk(last)) {
    throw new PatchParseError(lineNumber, 'Update hunk must contain context, added, or removed lines')
  }
}

function newHunk(lineNumber: number): PatchHunk {
  return { lineNumber, oldLines: [], newLines: [], isEndOfFile: false }
}

function readUpdate(operation: Extract<PatchOperation, { kind: 'update' }>, line: InputLine): void {
  const text = trimEnd(line.text)
  const previous = operation.hunks.at(-1)
  const marker = text === '@@' || text.startsWith('@@ ')
  if (previous?.isEndOfFile) {
    if (text === '') return
    if (!marker) throw new PatchParseError(line.number, "Expected '@@' after '*** End of File'")
  }
  if (previous === undefined && operation.moveTo === undefined && text.startsWith(MOVE)) {
    operation.moveTo = text.slice(MOVE.length)
    return
  }
  if (marker) {
    if (previous !== undefined && emptyHunk(previous)) {
      throw new PatchParseError(line.number, 'Update hunk must contain context, added, or removed lines')
    }
    const hunk = newHunk(line.number)
    if (text.startsWith('@@ ')) hunk.context = text.slice(3)
    operation.hunks.push(hunk)
    return
  }
  if (text === EOF) {
    if (previous !== undefined) {
      if (emptyHunk(previous)) {
        throw new PatchParseError(line.number, 'Update hunk must contain context, added, or removed lines')
      }
      previous.isEndOfFile = true
    }
    return
  }
  const prefix = line.text[0]
  if (line.text !== '' && prefix !== ' ' && prefix !== '+' && prefix !== '-') {
    throw new PatchParseError(line.number, "Expected a context (' '), added ('+'), removed ('-') line, or '@@'")
  }
  const hunk = previous ?? newHunk(line.number)
  if (previous === undefined) operation.hunks.push(hunk)
  const content = line.text.slice(1)
  if (prefix === '+') hunk.newLines.push(content)
  else if (prefix === '-') hunk.oldLines.push(content)
  else {
    hunk.oldLines.push(content)
    hunk.newLines.push(content)
  }
}

/**
 * Parse a complete Codex-style patch without reading or modifying files.
 * @param patch - patch text, optionally wrapped in a literal EOF heredoc.
 * @returns ordered, JSON-serializable operations; an empty patch returns an empty array.
 * @throws PatchParseError for malformed syntax or an unsupported Environment ID header.
 */
export function parsePatch(patch: string): PatchOperation[] {
  const lines = patchLines(patch)
  const operations: PatchOperation[] = []
  let ended = false
  for (const line of lines.slice(1)) {
    const operation = operations.at(-1)
    // The final marker is trimmed even in update mode by Codex's batch-parser finish step.
    const header = operation?.kind === 'update' && line !== lines.at(-1) ? trimEnd(line.text) : trim(line.text)
    if (ended && line !== lines.at(-1)) {
      if (trim(line.text) !== '') throw new PatchParseError(line.number, `Unexpected content after '${END}'`)
      continue
    }
    if (header === END) {
      ensureUpdate(operation, line.number)
      ended = true
    } else if (header.startsWith(ADD)) {
      ensureUpdate(operation, line.number)
      operations.push({ kind: 'add', path: header.slice(ADD.length), lineNumber: line.number, content: '' })
    } else if (header.startsWith(DELETE)) {
      ensureUpdate(operation, line.number)
      operations.push({ kind: 'delete', path: header.slice(DELETE.length), lineNumber: line.number })
    } else if (header.startsWith(UPDATE)) {
      ensureUpdate(operation, line.number)
      operations.push({ kind: 'update', path: header.slice(UPDATE.length), lineNumber: line.number, hunks: [] })
    } else if (operations.length === 0 && header.startsWith('*** Environment ID:')) {
      throw new PatchParseError(line.number, 'Environment ID headers are unsupported; the caller selects the filesystem provider')
    } else if (operation?.kind === 'add' && line.text.startsWith('+')) {
      operation.content += `${line.text.slice(1)}\n`
    } else if (operation?.kind === 'update') {
      readUpdate(operation, line)
    } else {
      throw new PatchParseError(line.number, 'Expected an Add File, Delete File, or Update File header; added content must start with +')
    }
  }
  return operations
}
