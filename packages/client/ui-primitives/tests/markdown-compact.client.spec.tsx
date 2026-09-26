// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MarkdownText } from './markdown-test-components.tsx'

afterEach(cleanup)

describe('compact MarkdownText', () => {
  it('retains the body variant semantics for headings, lists, quotes, links, code, tables, and math', () => {
    const text = [
      '# First', '## Second', '### Third', '#### Fourth', '##### Fifth', '###### Sixth',
      'Paragraph with **strong** and `inline`.',
      '- one\n- two\n  - nested',
      '1. ordered\n2. next',
      '> quoted',
      '[reference](https://example.com)',
      '```ts\nconst answer = 42\n```',
      '---',
      '| Name | Value |\n| --- | --- |\n| answer | 42 |',
      '$x^2$',
      '$$\nx + y = z\n$$',
    ].join('\n\n')
    const body = render(<MarkdownText text={text} />)
    const compact = render(<MarkdownText text={text} variant="compact" />)
    const bodyRoot = body.container.firstElementChild!
    const compactRoot = compact.container.firstElementChild!

    expect(bodyRoot.hasAttribute('data-markdown-variant')).toBe(false)
    expect(compactRoot.getAttribute('data-markdown-variant')).toBe('compact')
    expect(compactRoot.innerHTML).toBe(bodyRoot.innerHTML)
    expect(compactRoot.querySelectorAll('h1, h2, h3, h4, h5, h6')).toHaveLength(6)
    expect(compactRoot.querySelectorAll('ul')).toHaveLength(2)
    expect(compactRoot.querySelector('ol')).not.toBeNull()
    expect(compactRoot.querySelector('strong')?.textContent).toBe('strong')
    expect(compactRoot.querySelector('p > code')?.textContent).toBe('inline')
    expect(compactRoot.querySelector('blockquote')?.textContent?.trim()).toBe('quoted')
    expect(compactRoot.querySelector('a')?.getAttribute('href')).toBe('https://example.com')
    expect(compactRoot.querySelector('pre code')?.textContent).toBe('const answer = 42')
    expect(compactRoot.querySelector('hr')).not.toBeNull()
    expect(compactRoot.querySelector('table')).not.toBeNull()
    expect(compactRoot.querySelectorAll('.katex')).toHaveLength(2)
  })

  it('keeps frozen blocks and highlighted lines mounted across growth and variant changes', () => {
    const prefix = '# Heading\n\n**Completed** paragraph.\n\n- First\n\n'
    const initial = `${prefix}\`\`\`ts\nconst first = 1\nlet tail`
    const grown = `${initial} = 2\n\`\`\``
    const live = render(<MarkdownText text={initial} streaming variant="compact" />)
    const heading = live.container.querySelector('h1')
    const paragraph = live.container.querySelector('p')
    const firstLine = live.container.querySelector('pre .line')

    expect(heading?.textContent).toBe('Heading')
    expect(paragraph?.querySelector('strong')?.textContent).toBe('Completed')
    expect(firstLine?.textContent).toBe('const first = 1')

    live.rerender(<MarkdownText text={grown} streaming variant="compact" />)
    expect(live.container.querySelector('h1')).toBe(heading)
    expect(live.container.querySelector('p')).toBe(paragraph)
    expect(live.container.querySelector('pre .line')).toBe(firstLine)
    expect(live.container.querySelector('pre code')?.textContent).toBe('const first = 1\nlet tail = 2')

    live.rerender(<MarkdownText text={grown} streaming variant="body" />)
    expect(live.container.firstElementChild?.hasAttribute('data-markdown-variant')).toBe(false)
    expect(live.container.querySelector('h1')).toBe(heading)
    expect(live.container.querySelector('pre .line')).toBe(firstLine)

    live.rerender(<MarkdownText text={grown} variant="compact" />)
    expect(live.container.querySelector('h1')).toBe(heading)
    expect(live.container.querySelector('pre .line')).toBe(firstLine)
    expect(live.container.textContent).not.toContain('**Completed**')
  })
})
