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
  it('renders the highlighted tree for TypeScript', () => {
    const view = render(<CodeBlock code={'const a = 1\n'} lang="ts" />)
    const pre = view.container.querySelector('pre.shiki')
    expect(pre).not.toBeNull()
    expect(pre!.textContent).toBe('const a = 1')
    expect(pre!.querySelectorAll('span[style]').length).toBeGreaterThan(1)
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
