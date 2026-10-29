/** Shared Markdown blockquote formatting. */
import { describe, expect, it } from 'vitest'
import { formatQuoteText } from '../src/markdown/quote-text.ts'

describe('blockquote formatting', () => {
  it('normalizes selected text and prefixes every line', () => {
    expect(formatQuoteText('first\r\n> nested\rthird')).toBe('> first\n> > nested\n> third')
  })
})
