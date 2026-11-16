/**
 * Compact markdown tables as CSS text: a hosting layout (the chat transcript)
 * may widen a wide table and place a spacer before it, and compact markdown
 * must cancel both so its tables stay in the column.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(fileURLToPath(new URL('../src/markdown/MarkdownText.module.css', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')

function declarations(selector: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const [, selectorList = '', body = ''] of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon !== -1) found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim())
    }
  }
  return found
}

describe('compact markdown tables', () => {
  it('keeps the table wrapper in the column and drops any spacer before the table', () => {
    const wrapper = declarations('.markdown.compact .tableScroll')
    expect([wrapper.get('width'), wrapper.get('max-width'), wrapper.get('padding-left')]).toEqual(['100%', '100%', '0'])
    expect(declarations('.markdown.compact .tableScroll::before').get('content')).toBe('none')
  })
})
