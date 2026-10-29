/** Quote decoding and source offsets. */
import { describe, expect, it } from 'vitest'
import { messageQuoteRanges, quoteTextOf } from '../src/client/quote-text.ts'

describe('message blockquotes', () => {
  it('normalizes line endings and decodes one quote level', () => {
    expect(quoteTextOf('> first\r\n  > > nested\n>third')).toBe('first\n> nested\nthird')
  })

  it('recognizes consecutive explicit quote lines and preserves original offsets', () => {
    const text = 'before\n\n> first\n> line\n\n> second\n\nafter'
    expect(messageQuoteRanges(text)).toEqual([{ start: 8, end: 22 }, { start: 24, end: 32 }])
    expect(messageQuoteRanges('  > first\r\n>second')).toEqual([{ start: 0, end: 18 }])
  })

  it('leaves comparisons, indented code and blank excerpts as ordinary text', () => {
    expect(messageQuoteRanges('a > b\n    > code\n> \n>')).toEqual([])
    expect(messageQuoteRanges('')).toEqual([])
  })
})
