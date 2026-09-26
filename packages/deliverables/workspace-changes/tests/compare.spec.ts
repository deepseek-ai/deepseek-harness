/** Line comparison with its timeout degradation. */
import { describe, expect, it } from 'vitest'
import { compareText } from '../src/compare.ts'

describe('compareText', () => {
  it('yields unified hunks with context and counts only changed lines', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n')
    const after = ['a', 'b', 'c', 'D', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].join('\n')
    const result = compareText(before, after, 100)
    expect(result.coarse).toBe(false)
    expect(result).toMatchObject({ added: 2, deleted: 1 })
    // Changes whose context lines touch share one hunk.
    expect(result.hunks).toEqual([
      { oldStart: 1, oldLines: 10, newStart: 1, newLines: 11, lines: [' a', ' b', ' c', '-d', '+D', ' e', ' f', ' g', ' h', ' i', ' j', '+k'] },
    ])
    const far = compareText(`${before}\n${'z\n'.repeat(10)}end`, `${after}\n${'z\n'.repeat(10)}END`, 100)
    expect(far.hunks.map(hunk => [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines])).toEqual([[1, 13, 1, 14], [18, 4, 19, 4]])
  })

  it('treats a missing side as no lines and an unterminated last line by content alone', () => {
    expect(compareText(null, 'x\ny\n', 100)).toMatchObject({ added: 2, deleted: 0, hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2 }] })
    expect(compareText('x\n', null, 100)).toMatchObject({ added: 0, deleted: 1 })
    expect(compareText('last', 'last\nadded', 100)).toMatchObject({ added: 1, deleted: 0 })
    expect(compareText('same\n', 'same\n', 100)).toEqual({ hunks: [], coarse: false, added: 0, deleted: 0 })
    expect(compareText(null, null, 100)).toEqual({ hunks: [], coarse: false, added: 0, deleted: 0 })
  })

  it('degrades to whole-file replacement once the timeout passes', () => {
    const before = Array.from({ length: 4000 }, (_, i) => `old ${i}`).join('\n')
    const after = Array.from({ length: 4000 }, (_, i) => `new ${i}`).join('\n')
    const result = compareText(before, after, 1)
    expect(result.coarse).toBe(true)
    expect(result).toMatchObject({ added: 4000, deleted: 4000 })
    expect(result.hunks).toHaveLength(1)
    expect(result.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 4000, newStart: 1, newLines: 4000 })
    expect(result.hunks[0]!.lines[0]).toBe('-old 0')
    expect(result.hunks[0]!.lines.at(-1)).toBe('+new 3999')
    const created = compareText(null, `${after}\n${before}`, 1)
    expect(created.coarse).toBe(true)
    expect(created).toMatchObject({ added: 8000, deleted: 0, hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 8000 }] })
  })
})
