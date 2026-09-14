// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { CodeBlock as LocalizedCodeBlock } from '../src/markdown/CodeBlock.tsx'
import { highlightToHtml, subscribeGrammarLoaded } from '../src/markdown/highlight.ts'
import { markdownLabels } from './labels.client.ts'

function CodeBlock(props: Omit<ComponentProps<typeof LocalizedCodeBlock>, 'copyLabel' | 'copiedLabel'>) {
  return <LocalizedCodeBlock {...props} {...markdownLabels.code} />
}

afterEach(cleanup)

beforeEach(() => {
  vi.useRealTimers()
})

describe('highlightToHtml', () => {
  it('highlights a registered grammar into css-variables token spans', () => {
    const html = highlightToHtml('const x: number = 1', 'typescript')
    expect(html).toContain('pre class="shiki css-variables"')
    expect(html).toContain('var(--shiki-')
  })

  it.each([['ts'], ['js'], ['bash'], ['sh'], ['jsonc']])('resolves the %s alias', (alias) => {
    expect(highlightToHtml('x', alias)).toContain('shiki')
  })

  it('returns undefined for unknown or absent languages', () => {
    expect(highlightToHtml('x', 'cobol')).toBeUndefined()
    expect(highlightToHtml('x', undefined)).toBeUndefined()
  })

  // Every read-tool language hint whose grammar loads lazily (the boot set —
  // ts/js/shell/sh/json — is covered above). Touching each one drives its own
  // dynamic import thunk, so the whole LAZY_GRAMMARS table is exercised.
  const LAZY_ALIASES = [
    'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'cs', 'kotlin', 'swift', 'php',
    'yaml', 'toml', 'ini', 'md', 'mdx', 'html', 'css', 'scss', 'less', 'sql',
    'xml', 'lua',
  ]

  it('lazily loads every read-card grammar: plain first, highlighted after load', async () => {
    const registered = Promise.withResolvers<undefined>()
    // Registration notifications, not a private polling deadline, establish readiness.
    const stop = subscribeGrammarLoaded(() => {
      if (LAZY_ALIASES.every(alias => highlightToHtml('x', alias) !== undefined)) registered.resolve(undefined)
    })
    try {
      for (const alias of LAZY_ALIASES) expect(highlightToHtml('x', alias), alias).toBeUndefined()
      await registered.promise
      for (const alias of LAZY_ALIASES) expect(highlightToHtml('x', alias), alias).toContain('shiki')
    } finally {
      stop()
    }
  })
})

describe('CodeBlock', () => {
  it('reports the stable source-content wrapper to its owner', () => {
    const contentRef = vi.fn<(node: HTMLDivElement | null) => void>()
    const view = render(<CodeBlock code="plain text" contentRef={contentRef} />)
    const content = view.container.querySelector('[data-code-block-content]')
    expect(contentRef).toHaveBeenCalledWith(content)
    view.rerender(<CodeBlock code="updated text" contentRef={contentRef} />)
    expect(view.container.querySelector('[data-code-block-content]')).toBe(content)
    view.unmount()
    expect(contentRef).toHaveBeenLastCalledWith(null)
  })

  it('renders the highlighted tree for TypeScript', () => {
    const view = render(<CodeBlock code={'const a = 1\n'} lang="ts" />)
    const pre = view.container.querySelector('pre.shiki')
    expect(pre).not.toBeNull()
    expect(pre!.textContent).toBe('const a = 1')
    expect(pre!.querySelectorAll('span[style]').length).toBeGreaterThan(1)
    expect(view.container.querySelector('[data-line-numbers]')).toBeNull()
  })

  it.each(['ts', 'unregistered'])('numbers %s source lines without copying the gutter', async (lang) => {
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.useFakeTimers()
    try {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
      const code = 'const first = 1\n\nconst last = 3'
      const view = render(<CodeBlock code={`${code}\n`} lang={lang} lineNumbers />)
      expect(view.container.querySelector('[data-line-numbers]')).not.toBeNull()
      expect([...view.container.querySelectorAll('code > .line')].map(line => line.textContent))
        .toEqual(['const first = 1', '', 'const last = 3'])
      expect(view.container.querySelector('pre')!.textContent).toBe(code)
      await act(async () => { fireEvent.click(view.getByRole('button', { name: '复制' })) })
      expect(writeText).toHaveBeenCalledWith(code)
      await act(async () => { await vi.runOnlyPendingTimersAsync() })
    } finally {
      cleanup()
      vi.useRealTimers()
      if (clipboard === undefined) Reflect.deleteProperty(navigator, 'clipboard')
      else Object.defineProperty(navigator, 'clipboard', clipboard)
    }
  })

  it('keeps an empty numbered line and widens the gutter as streaming content grows', () => {
    const view = render(<CodeBlock code="" lineNumbers />)
    expect(view.container.querySelectorAll('code > .line')).toHaveLength(1)
    expect(view.container.querySelector('pre')!.textContent).toBe('')
    const gutter = () => view.container.querySelector<HTMLElement>('[data-line-numbers]')!
      .style.getPropertyValue('--dsl-code-block-line-number-width')
    expect(gutter()).toBe('2ch')
    view.rerender(<CodeBlock code="const first = 1" lang="ts" streaming lineNumbers />)
    const code = ['const first = 1', ...Array.from({ length: 99 }, (_, index) => `const line${index} = 0`)].join('\n')
    view.rerender(<CodeBlock code={code} lang="ts" streaming lineNumbers />)
    expect(view.container.querySelectorAll('code > .line')).toHaveLength(100)
    const firstLine = view.container.querySelector('code > .line')
    expect(view.container.querySelector('pre')!.textContent).toBe(code)
    expect(gutter()).toBe('3ch')
    view.rerender(<CodeBlock code={code} lang="ts" lineNumbers />)
    expect(view.container.querySelector('code > .line')).toBe(firstLine)
    expect(gutter()).toBe('3ch')
  })

  it('renders the plain arm for an unknown language with the text verbatim', () => {
    const view = render(<CodeBlock code={'IDENTIFICATION DIVISION.'} lang="cobol" />)
    expect(view.container.querySelector('pre.shiki')).toBeNull()
    expect(view.getByText('IDENTIFICATION DIVISION.')).toBeTruthy()
  })

  it('renders the plain arm when no language is given', () => {
    const view = render(<CodeBlock code="plain text" />)
    expect(view.container.querySelector('pre.shiki')).toBeNull()
    expect(view.getByText('plain text')).toBeTruthy()
  })

  it('shows the language banner and copies the pre textContent', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(<CodeBlock code={'const a = 1\n'} lang="ts" />)
    expect(screen.getByText('ts')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(writeText).toHaveBeenCalledWith('const a = 1')
    // Flush the clipboard promise under fake timers before asserting the label.
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: '复制成功' })).toBeTruthy()
    // While the ok label is showing, further clicks are no-ops.
    fireEvent.click(screen.getByRole('button', { name: '复制成功' }))
    expect(writeText).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
  })

  it('does not claim success when clipboard.writeText rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(<CodeBlock code="plain body" />)
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '复制成功' })).toBeNull()
  })

  it('falls back to execCommand when clipboard.writeText is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
    const exec = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: exec,
    })
    render(<CodeBlock code="plain body" />)
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(exec).toHaveBeenCalledWith('copy')
    expect(await screen.findByRole('button', { name: '复制成功' })).toBeTruthy()
  })

  it('does not claim success when execCommand throws or is absent', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: () => {
        throw new Error('denied')
      },
    })
    const denied = render(<CodeBlock code="plain body" />)
    fireEvent.click(denied.getByRole('button', { name: '复制' }))
    await Promise.resolve()
    expect(denied.getByRole('button', { name: '复制' })).toBeTruthy()
    denied.unmount()

    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: undefined,
    })
    const absent = render(<CodeBlock code="plain body" />)
    fireEvent.click(absent.getByRole('button', { name: '复制' }))
    await Promise.resolve()
    expect(absent.getByRole('button', { name: '复制' })).toBeTruthy()
    expect(absent.queryByRole('button', { name: '复制成功' })).toBeNull()
  })
})
