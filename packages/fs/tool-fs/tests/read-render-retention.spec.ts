/**
 * Memory retention of returned read lines: a short retained line must not keep the decoded input
 * string alive after the caller drops it. Each case scans a large input string, keeps only
 * the returned window, forces full garbage collection, and checks that heap usage returns near its
 * baseline instead of staying at the input size. The input is allocated on the V8 heap because Node
 * frees external string memory asynchronously, which makes `memoryUsage().external` unstable here.
 * The cases cover whole-file and streamed input, lines that span chunks, and truncated lines.
 */

import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { buildWindow, READ_MAX_BYTES, READ_MAX_LINE_LENGTH } from '../src/read-render.ts'
import type { FileTextLine } from '../src/read-render.ts'

setFlagsFromString('--expose-gc')
const collect = runInNewContext('gc') as () => void

const INPUT_CHARS = 32 * 1024 * 1024
const RETAINED_LIMIT = INPUT_CHARS / 4

function fullGc(): void {
  collect()
  collect()
}

function largeText(line: string): string {
  return `${line}\r\n`.repeat(Math.ceil(INPUT_CHARS / (line.length + 2)))
}

/** Measure the heap still held after `buildWindow` scans a large input and only its lines are kept. */
async function measure(
  line: string,
  chunking: 'whole' | 'stream' | 'mid-line',
  maxLineLength: number,
): Promise<{ bytes: number; lines: FileTextLine[] }> {
  async function* chunks(): AsyncIterable<string> {
    const input = largeText(line)
    if (chunking === 'whole') {
      yield input
      return
    }
    let at = 0
    if (chunking === 'mid-line') {
      // Chunk boundaries fall inside lines 2-4, so each kept line joins two chunks.
      for (const end of [1, 2, 3].map(index => index * (line.length + 2) + 100)) {
        yield input.slice(at, end)
        at = end
      }
    }
    for (; at < input.length; at += 1024 * 1024) yield input.slice(at, at + 1024 * 1024)
  }
  fullGc()
  const before = process.memoryUsage().heapUsed
  const window = await buildWindow(chunks(), { offset: 2, limit: 3, maxLineLength, maxBytes: READ_MAX_BYTES }, 'f')
  fullGc()
  return { bytes: process.memoryUsage().heapUsed - before, lines: window.lines }
}

describe('buildWindow retention', () => {
  it.each([
    ['whole-file ASCII lines', 'a'.repeat(200), 'whole', READ_MAX_LINE_LENGTH],
    ['whole-file two-byte lines', '中'.repeat(200), 'whole', READ_MAX_LINE_LENGTH],
    ['streamed lines', 'c'.repeat(200), 'stream', READ_MAX_LINE_LENGTH],
    ['lines that span chunks', 'd'.repeat(200), 'mid-line', READ_MAX_LINE_LENGTH],
    ['truncated lines', 'e'.repeat(5000), 'whole', 100],
  ] as const)('drops the decoded input behind %s', async (_name, line, chunking, maxLineLength) => {
    const { bytes, lines } = await measure(line, chunking, maxLineLength)
    const text = line.length > maxLineLength ? `${line.slice(0, maxLineLength)}... (line truncated to ${maxLineLength} chars)` : line
    expect(lines).toEqual([2, 3, 4].map(number => ({ number, text })))
    expect(bytes).toBeLessThan(RETAINED_LIMIT)
  })
})
