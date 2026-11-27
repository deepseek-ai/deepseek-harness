import { describe, expect, it } from 'vitest'
import { extractMarkdownPlainText } from '@deepseek-ai/dsh-client-ui-primitives/client'

const MARKDOWN = [
  '# Release notes',
  '',
  'First **paragraph** with [a link](https://example.com) and ![diagram](diagram.png).',
  '',
  '- shipped',
  '- `verified`',
  '',
  '```ts',
  'const ready = true',
  '```',
].join('\n')

describe('extractMarkdownPlainText', () => {
  it('projects the complete GFM document without presentation syntax', () => {
    expect(extractMarkdownPlainText(MARKDOWN)).toBe([
      'Release notes',
      '',
      'First paragraph with a link and diagram.',
      '',
      'shipped',
      'verified',
      '',
      'const ready = true',
    ].join('\n'))
  })

  it('selects the first visible line or first semantic paragraph', () => {
    expect(extractMarkdownPlainText(MARKDOWN, { mode: 'first-line' })).toBe('Release notes')
    expect(extractMarkdownPlainText(MARKDOWN, { mode: 'first-paragraph' }))
      .toBe('First paragraph with a link and diagram.')
  })

  it('preserves raw HTML while removing Markdown presentation markup', () => {
    const block = [
      '<background-job-complete id="trajectory-ui-watch">',
      'Command: pnpm test',
      'Exit code: 0',
      '</background-job-complete>',
    ].join('\n')
    expect(extractMarkdownPlainText(block)).toBe(block)
    expect(extractMarkdownPlainText('**Status:** <span data-state="ok">ready</span>'))
      .toBe('Status: <span data-state="ok">ready</span>')
    expect(extractMarkdownPlainText(block, { mode: 'first-paragraph' }))
      .toBe('<background-job-complete id="trajectory-ui-watch">')
  })

  it('projects GFM tables, references, hard breaks, and block structure', () => {
    const markdown = [
      '> first\\',
      '> second with ![diagram][asset] and <span>visible</span>',
      '',
      '---',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| alpha | `1` |',
      '',
      '[asset]: diagram.png',
    ].join('\n')
    expect(extractMarkdownPlainText(markdown)).toBe([
      'first second with diagram and <span>visible</span>',
      '',
      'Name\tValue',
      'alpha\t1',
    ].join('\n'))
  })
})
