/** Regression coverage for reusing one parse across the Markdown gate helpers. */

import { describe, expect, it } from 'vitest'
import { markdownHeadingLines, markdownProseLines, parseMarkdown } from './markdown.ts'

const SOURCE = [
  '# Title',
  '',
  'Prose <!-- hidden --> kept.',
  '<!-- comment only -->',
  '',
  '```ts',
  '# not a heading',
  '```',
  '',
  'Setext heading',
  '--------------',
  '',
].join('\n')

describe('Markdown parse reuse', () => {
  it('derives prose lines and headings from a supplied parse exactly as from its own parse', () => {
    const tree = parseMarkdown(SOURCE)
    const unchanged = structuredClone(tree)

    const prose = markdownProseLines(SOURCE, tree)
    const headings = markdownHeadingLines(SOURCE, tree)

    expect(prose).toEqual(markdownProseLines(SOURCE))
    expect(headings).toEqual(markdownHeadingLines(SOURCE))
    expect(prose.map(line => line.index)).toEqual([1, 2, 3, 5, 9, 10, 11, 12])
    expect(headings).toEqual([
      { depth: 1, index: 1, raw: '# Title', text: 'Title' },
      { depth: 2, index: 10, raw: 'Setext heading', text: 'Setext heading' },
    ])
    expect(tree).toEqual(unchanged)
  })
})
