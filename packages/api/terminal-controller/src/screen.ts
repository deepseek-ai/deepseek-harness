/** Plain-text projection of a terminal emulator buffer for readers that cannot render control sequences. */
import type { IBuffer, IBufferLine } from '@xterm/headless'
import type { TerminalScreenPage, TerminalScreenRequest } from './types.ts'

/**
 * Last buffer row that carries content: the cursor row or a later non-blank row.
 * @param buffer - active emulator buffer.
 * @returns absolute row index, or -1 for an empty buffer.
 */
export function lastContentRow(buffer: IBuffer): number {
  let row = buffer.length - 1
  const cursor = buffer.baseY + buffer.cursorY
  while (row > cursor && bufferRow(buffer, row).translateToString(true) === '') row--
  return row
}

/**
 * First row of the logical line that holds the cursor.
 * @param buffer - active emulator buffer.
 * @returns absolute index of the row where the cursor's wrapped line begins.
 */
export function cursorLineStart(buffer: IBuffer): number {
  let row = buffer.baseY + buffer.cursorY
  while (row > 0 && bufferRow(buffer, row).isWrapped) row--
  return row
}

/**
 * Join wrapped rows into logical lines and trim each line's trailing cell padding.
 * @param buffer - active emulator buffer.
 * @param from - first absolute row, inclusive.
 * @param to - last absolute row, exclusive.
 * @returns logical lines in screen order; a range starting inside a wrapped line begins with that row.
 */
export function renderLines(buffer: IBuffer, from: number, to: number): string[] {
  const lines: string[] = []
  let current: string | undefined
  for (let row = Math.max(0, from); row < Math.min(to, buffer.length); row++) {
    const line = bufferRow(buffer, row)
    if (current !== undefined && line.isWrapped) {
      current += line.translateToString(false)
      continue
    }
    if (current !== undefined) lines.push(current.trimEnd())
    current = line.translateToString(false)
  }
  if (current !== undefined) lines.push(current.trimEnd())
  return lines
}

/**
 * Select a newest-relative page and keep its newest bytes within the byte bound.
 * @param lines - logical lines in screen order.
 * @param request - newest-relative offset, line count and UTF-8 byte bound.
 * @returns the page; `truncated` reports dropped lines or a cut line within the selected range.
 */
export function pageLines(lines: readonly string[], request: TerminalScreenRequest): TerminalScreenPage {
  const end = Math.max(0, lines.length - request.offset)
  const begin = Math.max(0, end - request.count)
  const selected = lines.slice(begin, end)
  const encoder = new TextEncoder()
  let bytes = 0
  let first = selected.length
  while (first > 0) {
    const next = encoder.encode(selected[first - 1]).byteLength + (first === selected.length ? 0 : 1)
    if (bytes + next > request.maxBytes) break
    bytes += next
    first--
  }
  const kept = selected.slice(first)
  let truncated = first > 0
  if (kept.length === 0 && selected.length > 0) {
    kept.push(tailWithin(selected.at(-1) as string, request.maxBytes))
    truncated = true
  }
  return { text: kept.join('\n'), totalLines: lines.length, lineBegin: request.offset, lineEnd: request.offset + kept.length, truncated }
}

function bufferRow(buffer: IBuffer, row: number): IBufferLine {
  const line = buffer.getLine(row)
  /* v8 ignore next -- dense-buffer guard: every caller bounds row by buffer.length. */
  if (line === undefined) throw new Error(`Terminal buffer row ${row} is missing`)
  return line
}

function tailWithin(text: string, maxBytes: number): string {
  const graphemes = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), part => part.segment)
  let bytes = 0
  let start = graphemes.length
  while (start > 0) {
    const size = new TextEncoder().encode(graphemes[start - 1]).byteLength
    if (bytes + size > maxBytes) break
    bytes += size
    start--
  }
  return graphemes.slice(start).join('')
}
