/** Rows of a file diff: numbering, side-by-side pairing, and unchanged lines between hunks. */
import { describe, expect, it } from 'vitest'
import type { ForgeDiffFile, ForgeDiffHunk } from '../src/types.ts'
import {
  drawnLines, EXPAND_STEP, hidesLine, hunkRows, matchesHunks, revealGap, segmentsOf, splitRows, textLines, type DiffSegment, type GapReveal,
} from '../src/client/diff-rows.ts'

/** Modified file whose hunks change lines 3–6 and 11 of its 13 new lines. */
const NEW_SIDE = ['a1', 'a2', 'a3', 'y', 'z', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 't12', 't13']
const HUNKS: readonly ForgeDiffHunk[] = [
  { oldStart: 3, oldLines: 3, newStart: 3, newLines: 4, lines: [' a3', '-x', '+y', '+z', ' a5'] },
  { oldStart: 10, oldLines: 2, newStart: 11, newLines: 1, lines: [' a10', '-w'] },
]

const NONE: ReadonlyMap<number, GapReveal> = new Map()

/** Gaps shown wholly. */
function opened(...indexes: number[]): ReadonlyMap<number, GapReveal> {
  return new Map(indexes.map(index => [index, { top: Number.POSITIVE_INFINITY, bottom: 0 }]))
}

/** A segment as its row count, its gap's index and count, or itself. */
function brief(segment: DiffSegment): unknown {
  return segment.kind === 'rows' ? segment.rows.length : segment.kind === 'gap' ? { kind: 'gap', index: segment.index, count: segment.count } : segment
}

function file(overrides: Partial<ForgeDiffFile> = {}): ForgeDiffFile {
  return {
    path: 'src/a.ts', previousPath: null, status: 'modified', binary: false, oversized: false, untracked: false, layer: 'implementation', digest: 'digest',
    additions: 2, deletions: 2, hunks: HUNKS, ...overrides,
  }
}

describe('hunkRows', () => {
  it('numbers context lines on both sides, deletions on the old side, and additions on the new side', () => {
    expect(hunkRows(HUNKS[0]!)).toEqual([
      { kind: 'context', old: 3, new: 3, text: 'a3' },
      { kind: 'del', old: 4, new: null, text: 'x' },
      { kind: 'add', old: null, new: 4, text: 'y' },
      { kind: 'add', old: null, new: 5, text: 'z' },
      { kind: 'context', old: 5, new: 6, text: 'a5' },
    ])
  })

  it('skips missing-newline markers, drops carriage returns, and reads an empty line as context', () => {
    const hunk = { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ['-a\r', '\\ No newline at end of file', '+b\r', ''] }
    expect(hunkRows(hunk)).toEqual([
      { kind: 'del', old: 1, new: null, text: 'a' },
      { kind: 'add', old: null, new: 1, text: 'b' },
      { kind: 'context', old: 2, new: 2, text: '' },
    ])
  })
})

describe('splitRows', () => {
  it('pairs each run of deletions with the additions after it and repeats context on both sides', () => {
    const rows = hunkRows({ oldStart: 1, oldLines: 5, newStart: 1, newLines: 4, lines: [' c', '-d1', '-d2', '+a1', ' c2', '-d3', '+a2', '+a3', '+a4', '-d4'] })
    const cells = splitRows(rows).map(({ left, right }) => [
      left?.kind ?? null, left?.text ?? null, right?.kind ?? null, right?.text ?? null,
    ])
    expect(cells).toEqual([
      ['context', 'c', 'context', 'c'],
      ['del', 'd1', 'add', 'a1'],
      ['del', 'd2', null, null],
      ['context', 'c2', 'context', 'c2'],
      ['del', 'd3', 'add', 'a2'],
      [null, null, 'add', 'a3'],
      [null, null, 'add', 'a4'],
      ['del', 'd4', null, null],
    ])
  })
})

describe('textLines', () => {
  it.each([
    ['a final line ending', 'a\nb\n', ['a', 'b']],
    ['no final line ending', 'a\nb', ['a', 'b']],
    ['CRLF endings', 'a\r\nb\r\n', ['a\r', 'b\r']],
    ['no text', '', []],
  ])('splits text with %s', (_label, text, lines) => {
    expect(textLines(text)).toEqual(lines)
  })
})

describe('matchesHunks', () => {
  it('accepts the new side the hunks describe, carriage returns included', () => {
    expect(matchesHunks(NEW_SIDE, HUNKS)).toBe(true)
    expect(matchesHunks(['a\r', 'b\r'], [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' a\r', '+b\r', '\\ No newline at end of file'] }])).toBe(true)
  })

  it('rejects text that changed after the diff was read', () => {
    expect(matchesHunks(NEW_SIDE.with(4, 'Z'), HUNKS)).toBe(false)
    expect(matchesHunks(NEW_SIDE.slice(0, 5), HUNKS)).toBe(false)
  })
})

describe('segmentsOf', () => {
  it('collapses the lines before, between, and after the hunks, the last of unknown length', () => {
    expect(segmentsOf(file(), undefined, opened(0, 1)).map(brief)).toEqual([
      { kind: 'gap', index: 0, count: 2 },
      5,
      { kind: 'gap', index: 1, count: 4 },
      2,
      { kind: 'gap', index: 2, count: null },
    ])
  })

  it('draws the expanded gaps from the new side with the old numbers they had', () => {
    const [rows, ...rest] = segmentsOf(file(), NEW_SIDE, opened(0, 1, 2))
    expect(rest).toEqual([])
    if (rows?.kind !== 'rows') throw new Error('expected one run of rows')
    expect(rows.rows.map(row => [row.old, row.new, row.text])).toEqual([
      [1, 1, 'a1'], [2, 2, 'a2'],
      [3, 3, 'a3'], [4, null, 'x'], [null, 4, 'y'], [null, 5, 'z'], [5, 6, 'a5'],
      [6, 7, 'a6'], [7, 8, 'a7'], [8, 9, 'a8'], [9, 10, 'a9'],
      [10, 11, 'a10'], [11, null, 'w'],
      [12, 12, 't12'], [13, 13, 't13'],
    ])
  })

  it('keeps unexpanded gaps collapsed once the new side is known, and counts the lines after the last hunk', () => {
    expect(segmentsOf(file(), NEW_SIDE, opened(1)).map(brief)).toEqual([
      { kind: 'gap', index: 0, count: 2 },
      11,
      { kind: 'gap', index: 2, count: 2 },
    ])
    expect(segmentsOf(file(), NEW_SIDE.slice(0, 11), NONE).at(-1)).toMatchObject({ kind: 'rows' })
  })

  it('maps lines around a hunk that only deletes to the old lines after the deletion', () => {
    const deletion = file({ hunks: [{ oldStart: 5, oldLines: 2, newStart: 5, newLines: 0, lines: ['-d5', '-d6'] }] })
    const [rows] = segmentsOf(deletion, ['b1', 'b2', 'b3', 'b4', 'b7'], opened(0, 1))
    if (rows?.kind !== 'rows') throw new Error('expected one run of rows')
    expect(rows.rows.map(row => [row.old, row.new, row.text])).toEqual([
      [1, 1, 'b1'], [2, 2, 'b2'], [3, 3, 'b3'], [4, 4, 'b4'], [5, null, 'd5'], [6, null, 'd6'], [7, 5, 'b7'],
    ])
  })

  it('has nothing after the last hunk of a new or deleted file or of a hunk that reaches the end of the new side', () => {
    const added = file({ status: 'added', hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ['+x', '+y'] }] })
    expect(segmentsOf(added, undefined, NONE).map(segment => segment.kind)).toEqual(['rows'])
    const deleted = file({ status: 'deleted', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 0, lines: ['-x'] }] })
    expect(segmentsOf(deleted, undefined, NONE).map(segment => segment.kind)).toEqual(['rows'])
    const ending = file({ hunks: [{ oldStart: 4, oldLines: 1, newStart: 4, newLines: 1, lines: ['-a', '+b', '\\ No newline at end of file'] }] })
    expect(segmentsOf(ending, undefined, NONE).map(segment => segment.kind)).toEqual(['gap', 'rows'])
    const oldEnding = file({ hunks: [{ oldStart: 4, oldLines: 1, newStart: 4, newLines: 1, lines: ['-a', '\\ No newline at end of file', '+b'] }] })
    expect(segmentsOf(oldEnding, undefined, NONE).map(segment => segment.kind)).toEqual(['gap', 'rows', 'gap'])
  })

  it('draws consecutive folded hunks as one row that takes the lines between them, and the gap before a folded run', () => {
    const three = file({ hunks: [...HUNKS, { oldStart: 13, oldLines: 1, newStart: 13, newLines: 1, lines: ['-u', '+t13'] }] })
    expect(segmentsOf(three, undefined, NONE, new Set([1, 2])).map(brief)).toEqual([
      { kind: 'gap', index: 0, count: 2 },
      5,
      { kind: 'gap', index: 1, count: 4 },
      { kind: 'folded', hunks: [1, 2] },
      { kind: 'gap', index: 3, count: null },
    ])
    expect(segmentsOf(three, undefined, NONE, new Set([0, 2])).map(brief)).toEqual([
      { kind: 'gap', index: 0, count: 2 },
      { kind: 'folded', hunks: [0] },
      { kind: 'gap', index: 1, count: 4 },
      2,
      { kind: 'gap', index: 2, count: 1 },
      { kind: 'folded', hunks: [2] },
      { kind: 'gap', index: 3, count: null },
    ])
  })

  it('names where each gap sits and the new-side lines it hides, whose old numbers are its offset higher', () => {
    expect(segmentsOf(file(), NEW_SIDE, NONE).filter(segment => segment.kind === 'gap')).toEqual([
      { kind: 'gap', index: 0, count: 2, edge: 'leading', from: 1, to: 2, offset: 0 },
      { kind: 'gap', index: 1, count: 4, edge: 'middle', from: 7, to: 10, offset: -1 },
      { kind: 'gap', index: 2, count: 2, edge: 'trailing', from: 12, to: 13, offset: 0 },
    ])
    expect(segmentsOf(file(), undefined, NONE).at(-1)).toEqual({ kind: 'gap', index: 2, count: null, edge: 'trailing', from: 12, to: null, offset: 0 })
  })

  it('draws the lines a reveal shows at the top and bottom of a gap and keeps the rest collapsed', () => {
    const segments = segmentsOf(file(), NEW_SIDE, new Map([[1, { top: 1, bottom: 2 }]]))
    expect(segments.map(brief)).toEqual([{ kind: 'gap', index: 0, count: 2 }, 6, { kind: 'gap', index: 1, count: 1 }, 4, { kind: 'gap', index: 2, count: 2 }])
    const [, above, gap, below] = segments
    if (above?.kind !== 'rows' || below?.kind !== 'rows') throw new Error('expected rows around the gap')
    expect(above.rows.at(-1)).toEqual({ kind: 'context', old: 6, new: 7, text: 'a6' })
    expect(gap).toMatchObject({ kind: 'gap', index: 1, from: 8, to: 8 })
    expect(below.rows.slice(0, 2)).toEqual([{ kind: 'context', old: 8, new: 9, text: 'a8' }, { kind: 'context', old: 9, new: 10, text: 'a9' }])
  })

  it('joins the rows around a gap that its reveal covers, however the steps add up', () => {
    expect(segmentsOf(file(), NEW_SIDE, new Map([[1, { top: 3, bottom: 1 }]])).map(brief)).toEqual([{ kind: 'gap', index: 0, count: 2 }, 11, { kind: 'gap', index: 2, count: 2 }])
    expect(segmentsOf(file(), NEW_SIDE, new Map([[1, { top: 40, bottom: 40 }]])).map(brief)).toEqual([{ kind: 'gap', index: 0, count: 2 }, 11, { kind: 'gap', index: 2, count: 2 }])
  })

  it('keeps a revealed gap collapsed until the new side is read', () => {
    expect(segmentsOf(file(), undefined, new Map([[2, { top: EXPAND_STEP, bottom: 0 }]])).at(-1)).toMatchObject({ kind: 'gap', index: 2, count: null })
    expect(segmentsOf(file(), NEW_SIDE, new Map([[2, { top: EXPAND_STEP, bottom: 0 }]])).map(brief)).toEqual([{ kind: 'gap', index: 0, count: 2 }, 5, { kind: 'gap', index: 1, count: 4 }, 4])
  })

  it('draws nothing for a file without hunks', () => {
    expect(segmentsOf(file({ status: 'renamed', previousPath: 'old.ts', hunks: [] }), undefined, NONE)).toEqual([])
  })
})

describe('drawnLines', () => {
  it('counts the lines of every hunk except missing-newline markers', () => {
    expect(drawnLines(file())).toBe(7)
    expect(drawnLines(file({ hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '\\ No newline at end of file', '+b'] }] }))).toBe(2)
  })
})

describe('revealGap', () => {
  it('shows one step more down from the hunk above or up from the hunk below, or the whole gap', () => {
    const down = revealGap(undefined, 1, 'down')
    expect(down.get(1)).toEqual({ top: EXPAND_STEP, bottom: 0 })
    const both = revealGap(down, 1, 'up')
    expect(both.get(1)).toEqual({ top: EXPAND_STEP, bottom: EXPAND_STEP })
    expect(revealGap(both, 1, 'down').get(1)).toEqual({ top: 2 * EXPAND_STEP, bottom: EXPAND_STEP })
    expect(revealGap(both, 0, 'all')).toEqual(new Map([[1, { top: EXPAND_STEP, bottom: EXPAND_STEP }], [0, { top: Number.POSITIVE_INFINITY, bottom: 0 }]]))
    expect(down.get(1)).toEqual({ top: EXPAND_STEP, bottom: 0 })
  })
})

describe('hidesLine', () => {
  it('finds the lines a gap still hides on either side', () => {
    const middle = segmentsOf(file(), NEW_SIDE, new Map([[1, { top: 1, bottom: 2 }]]))[2]
    if (middle?.kind !== 'gap') throw new Error('expected the middle gap')
    expect([hidesLine(middle, 'R', 7), hidesLine(middle, 'R', 8), hidesLine(middle, 'R', 9)]).toEqual([false, true, false])
    expect([hidesLine(middle, 'L', 6), hidesLine(middle, 'L', 7), hidesLine(middle, 'L', 8)]).toEqual([false, true, false])
    const rest = segmentsOf(file(), undefined, NONE).at(-1)
    if (rest?.kind !== 'gap') throw new Error('expected the gap after the last hunk')
    expect([hidesLine(rest, 'R', 11), hidesLine(rest, 'R', 400), hidesLine(rest, 'L', 12)]).toEqual([false, true, true])
  })
})
