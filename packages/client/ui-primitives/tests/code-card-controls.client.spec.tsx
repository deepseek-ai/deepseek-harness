// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CodeBlock } from '../src/markdown/CodeBlock.tsx'
import { MarkdownText } from '../src/markdown/MarkdownText.tsx'
import { ReadBlock } from '../src/ReadBlock.tsx'
import { DiffBlock } from '../src/DiffBlock.tsx'
import { diffBlockLabels, readBlockLabels } from './labels.client.ts'

const toolbarLabels = { codeLabel: 'Code block', wrapLabel: 'Wrap lines', unwrapLabel: 'Do not wrap lines' }
const labels = { copyLabel: 'Copy', copiedLabel: 'Copied', toolbarLabels }

afterEach(() => {
  cleanup()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('code-card controls', () => {
  it.each([undefined, 'unregistered'])('labels the %s language with the localized code title', (lang) => {
    render(<CodeBlock code="plain source" lang={lang} {...labels} />)
    expect(screen.getByText('Code block')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy' }).textContent).toBe('')
  })

  it('keeps a known grammar name while its highlighter is not yet visible', () => {
    render(<CodeBlock code="const x = 1" lang="typescript" {...labels} />)
    expect(screen.getByText('typescript')).toBeTruthy()
    expect(screen.queryByText('Code block')).toBeNull()
  })

  it.each(['code', 'read', 'diff'] as const)('toggles %s wrapping without changing source text', (kind) => {
    const code = 'const longName = "a long value whose source must stay intact"'
    const view = render(kind === 'code'
      ? <CodeBlock code={code} lang="ts" {...labels} />
      : kind === 'read'
        ? <ReadBlock lines={[{ number: 24, text: code }]} totalLines={30} lang="ts" labels={{ ...readBlockLabels, ...toolbarLabels }} />
        : <DiffBlock diffs={[{ path: 'example.ts', oldText: 'old', newText: code }]} labels={{ ...diffBlockLabels, ...toolbarLabels }} />)
    const button = screen.getByRole('button', { name: 'Wrap lines' })
    const wasWrapped = button.getAttribute('aria-pressed') === 'true'
    fireEvent.click(button)
    expect(button.getAttribute('aria-pressed')).toBe(String(!wasWrapped))
    expect(button.getAttribute('aria-label')).toBe('Wrap lines')
    expect(view.container.textContent).toContain(code)
    fireEvent.click(button)
    expect(button.getAttribute('aria-pressed')).toBe(String(wasWrapped))
  })

  it('shows hover tooltips for copying and wrapping and updates the wrapping action', () => {
    render(<CodeBlock code="source" {...labels} />)
    const copy = screen.getByRole('button', { name: 'Copy' })
    fireEvent.mouseEnter(copy)
    expect(screen.getByRole('tooltip').textContent).toBe('Copy')
    fireEvent.mouseLeave(copy)
    const wrap = screen.getByRole('button', { name: 'Wrap lines' })
    fireEvent.mouseEnter(wrap)
    expect(screen.getByRole('tooltip').textContent).toBe('Do not wrap lines')
    fireEvent.click(wrap)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.mouseEnter(wrap)
    expect(screen.getByRole('tooltip').textContent).toBe('Wrap lines')
  })

  it('copies source through the icon and announces success', async () => {
    vi.useFakeTimers()
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      render(<CodeBlock code={'const x = 1\n'} {...labels} />)
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy' })) })
      expect(writeText).toHaveBeenCalledWith('const x = 1')
      expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()
    } finally {
      if (original === undefined) Reflect.deleteProperty(navigator, 'clipboard')
      else Object.defineProperty(navigator, 'clipboard', original)
    }
  })

  it('shows compact Markdown icon actions and preserves custom source controls', () => {
    const view = render(<MarkdownText text={'```ts\nconst x = 1\n```'} variant="compact" labels={{ code: labels, footnotes: 'Footnotes' }} />)
    const wrap = screen.getByRole('button', { name: 'Wrap lines' })
    expect(wrap.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(wrap)
    expect(wrap.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: 'Copy' }).textContent).toBe('')
    view.rerender(<CodeBlock code="source" copyLabel="Copy" copiedLabel="Copied" />)
    expect(screen.getByRole('button', { name: 'Copy' }).textContent).toBe('Copy')
  })

  it('uses the fallback title for diffs containing different languages', () => {
    render(<DiffBlock diffs={[
      { path: 'example.ts', oldText: '', newText: 'export {}' },
      { path: 'example.py', oldText: '', newText: 'print(1)' },
    ]} labels={{ ...diffBlockLabels, ...toolbarLabels }} />)
    expect(screen.getByText('Code block')).toBeTruthy()
  })
})
