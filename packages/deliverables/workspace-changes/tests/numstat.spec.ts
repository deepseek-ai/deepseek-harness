/** Numstat parsing. */
import { describe, expect, it } from 'vitest'
import { parseNumstat } from '../src/numstat.ts'

describe('parseNumstat', () => {
  it('reads plain, binary, and rename records', () => {
    const output = ['3\t1\tsrc/a.ts', '-\t-\timg.png', '2\t0\t', 'old.txt', 'new.txt', ''].join('\0')
    expect(parseNumstat(output)).toEqual([
      { path: 'src/a.ts', added: 3, deleted: 1, binary: false },
      { path: 'img.png', added: 0, deleted: 0, binary: true },
      { path: 'new.txt', oldPath: 'old.txt', added: 2, deleted: 0, binary: false },
    ])
  })

  it('returns nothing for empty output', () => {
    expect(parseNumstat('')).toEqual([])
  })

  it('rejects output without a final terminator or with malformed records', () => {
    expect(() => parseNumstat('1\t1\ta.txt')).toThrow('NUL-terminated')
    expect(() => parseNumstat('garbage\0')).toThrow('malformed numstat record')
    expect(() => parseNumstat('1\t0\t\0old.txt\0')).toThrow('rename')
  })
})

describe('parseNumstat with unusual names', () => {
  it('keeps tabs inside a file name', () => {
    expect(parseNumstat(['1\t0\ta\tb.txt', '2\t0\t', 'old\tx', 'new\ty', ''].join('\0'))).toEqual([
      { path: 'a\tb.txt', added: 1, deleted: 0, binary: false },
      { path: 'new\ty', oldPath: 'old\tx', added: 2, deleted: 0, binary: false },
    ])
    expect(() => parseNumstat('1\ta.txt\0')).toThrow('malformed numstat record')
    expect(() => parseNumstat('garbage\0')).toThrow('malformed numstat record')
  })
})
