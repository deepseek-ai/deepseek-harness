// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { DEFAULT_READ_MAX_LINES, ReadBlock as LocalizedReadBlock, type ReadBlockLine } from '../src/index.ts'
import { grammarLoadCount, highlightLines, subscribeGrammarLoaded } from '../src/markdown/highlight.ts'
import { readBlockLabels } from './labels.client.ts'

function ReadBlock(props: Omit<ComponentProps<typeof LocalizedReadBlock>, 'labels'>) {
  return <LocalizedReadBlock {...props} labels={readBlockLabels} />
}

afterEach(cleanup)

beforeEach(() => {
  vi.useRealTimers()
})

function lines(count: number, first = 1): ReadBlockLine[] {
  return Array.from({ length: count }, (_value, index) => ({ number: first + index, text: `line ${first + index}` }))
}

function rowTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[class^="_line_"]')].map(row => row.textContent ?? '')
}

function gutters(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[class^="_gutter_"]')].map(cell => cell.textContent ?? '')
}

describe('highlightLines', () => {
  it('tokenizes a registered grammar into per-line css-variables runs', () => {
    const result = highlightLines('const x = 1\n// c', 'ts')
    expect(result).not.toBeUndefined()
    expect(result).toHaveLength(2)
    // The keyword run carries a color style through a --shiki-* custom property.
    const keyword = result![0]!.find(span => span.text === 'const')
    expect(keyword?.style?.color).toContain('var(--shiki-')
    // Whitespace between tokens is a run of its own; the comment is line two.
    expect(result![0]!.map(span => span.text).join('')).toBe('const x = 1')
    expect(result![1]!.map(span => span.text).join('')).toBe('// c')
  })

  it('colors every run through a --shiki-* custom property', () => {
    // The css-variables theme colors even the whitespace run (as the foreground
    // token), so every run is a styled span; the plain fallback is the whole
    // unknown-language path, not a per-run one.
    const result = highlightLines('const x = 1', 'ts')
    for (const span of result!) for (const run of span) expect(run.style.color).toContain('var(--shiki-')
  })

  it('drops the trailing terminator line so the run count matches the source lines', () => {
    // `a\n` tokenizes to two lines in shiki (the second empty); the caller's own
    // line array has one entry, so the terminator line is dropped.
    const result = highlightLines('const a = 1\n', 'ts')
    expect(result).toHaveLength(1)
  })

  it('keeps a genuinely blank final line when the source ends in two newlines', () => {
    const result = highlightLines('a\n\n', 'ts')
    expect(result).toHaveLength(2)
    expect(result![1]).toEqual([])
  })

  it('returns undefined for an unknown or absent language', () => {
    expect(highlightLines('x', 'cobol')).toBeUndefined()
    expect(highlightLines('x', undefined)).toBeUndefined()
  })

  it('loads a lazy grammar on first use: plain first, highlighted after it registers', async () => {
    // A boot grammar (ts) is ready synchronously; a lazy grammar (python) is
    // not, so the first call renders plain and imports the grammar, and a
    // subscriber fires once it registers, after which the same call highlights.
    let notified = 0
    const stop = subscribeGrammarLoaded(() => { notified += 1 })
    // First touch: grammar not loaded yet, so plain fallback while it imports.
    expect(highlightLines('def f(): pass', 'py')).toBeUndefined()
    // The import + loadLanguageSync resolve on a microtask; wait for the notify.
    await vi.waitFor(() => { expect(notified).toBeGreaterThan(0) })
    expect(grammarLoadCount()).toBeGreaterThan(0)
    const result = highlightLines('def f(): pass', 'py')
    expect(result).not.toBeUndefined()
    // `def` is a python keyword and carries a --shiki-* color once highlighted.
    const keyword = result!.flat().find(span => span.text === 'def')
    expect(keyword?.style?.color).toContain('var(--shiki-')
    stop()
  })
})

describe('ReadBlock rows', () => {
  it('renders one gutter-numbered row per line, keeping the file line numbers', () => {
    const view = render(<ReadBlock label="a.ts" lines={lines(3, 41)} totalLines={3} />)
    expect(gutters(view.container)).toEqual(['41', '42', '43'])
    expect(rowTexts(view.container)).toEqual(['41line 41', '42line 42', '43line 43'])
  })

  it('highlights the content for a known language into token spans', () => {
    const view = render(
      <ReadBlock label="a.ts" lang="ts" lines={[{ number: 1, text: 'const a = 1' }]} totalLines={1} />,
    )
    const content = view.container.querySelector('[class^="_content_"]')
    expect(content?.querySelectorAll('span[style]').length).toBeGreaterThan(1)
    expect(content?.textContent).toBe('const a = 1')
  })

  it('renders the content as bare text with no span wrappers for an unknown language', () => {
    const view = render(
      <ReadBlock label="a.cob" lang="cobol" lines={[{ number: 1, text: 'IDENT DIVISION.' }]} totalLines={1} />,
    )
    const content = view.container.querySelector('[class^="_content_"]')
    expect(content?.querySelectorAll('span').length).toBe(0)
    expect(content?.textContent).toBe('IDENT DIVISION.')
  })

  it('renders bare text when no language is given', () => {
    const view = render(<ReadBlock label="x" lines={[{ number: 1, text: 'plain' }]} totalLines={1} />)
    const content = view.container.querySelector('[class^="_content_"]')
    expect(content?.querySelectorAll('span').length).toBe(0)
    expect(view.getByText('plain')).toBeTruthy()
  })
})

describe('ReadBlock banner', () => {
  it('shows the label, the language, and the count note when the read is a window', () => {
    const view = render(<ReadBlock label="src/a.ts" lang="ts" lines={lines(3, 41)} totalLines={180} />)
    expect(view.getByText('src/a.ts')).toBeTruthy()
    expect(view.getByText('ts')).toBeTruthy()
    expect(view.getByText('显示 3 / 180 行')).toBeTruthy()
  })

  it('omits the count note when the window is the whole file', () => {
    const view = render(<ReadBlock label="a.ts" lines={lines(3)} totalLines={3} />)
    expect(view.queryByText(/显示/u)).toBeNull()
  })

  it('uses the localized code title when no language is given', () => {
    render(<ReadBlock lines={lines(1)} totalLines={1} />)
    expect(screen.getByText('代码块')).toBeTruthy()
  })
})

describe('ReadBlock height cap', () => {
  it('renders every line and no expand control under the cap', () => {
    const view = render(<ReadBlock label="a" lines={lines(4)} totalLines={4} maxLines={4} />)
    expect(rowTexts(view.container)).toHaveLength(4)
    expect(view.container.querySelector('[aria-expanded]')).toBeNull()
  })

  it('slices head and tail over the cap and expands on click', () => {
    const view = render(<ReadBlock label="a" lines={lines(10)} totalLines={10} maxLines={4} />)
    // maxLines 4: head = ceil(4/2) = 2, tail = 4 - 2 = 2, 6 hidden.
    expect(gutters(view.container)).toEqual(['1', '2', '9', '10'])
    const toggle = view.getByRole('button', { name: '展开其余 6 行' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toBe('… 其余 6 行')

    fireEvent.click(toggle)
    expect(rowTexts(view.container)).toHaveLength(10)
    const collapse = view.getByRole('button', { name: '收起内容' })
    expect(collapse.getAttribute('aria-expanded')).toBe('true')
    expect(collapse.textContent).toBe('收起')

    fireEvent.click(collapse)
    expect(gutters(view.container)).toEqual(['1', '2', '9', '10'])
  })

  it('renders the head slice alone when the cap leaves no tail', () => {
    const view = render(<ReadBlock label="a" lines={lines(5)} totalLines={5} maxLines={1} />)
    expect(gutters(view.container)).toEqual(['1'])
    expect(view.getByRole('button', { name: '展开其余 4 行' })).toBeTruthy()
  })

  it('caps at the documented default when maxLines is absent', () => {
    const view = render(
      <ReadBlock label="a" lines={lines(DEFAULT_READ_MAX_LINES + 1)} totalLines={DEFAULT_READ_MAX_LINES + 1} />,
    )
    expect(rowTexts(view.container)).toHaveLength(DEFAULT_READ_MAX_LINES)
    expect(view.getByRole('button', { name: '展开其余 1 行' })).toBeTruthy()
  })
})

describe('ReadBlock copy', () => {
  it('copies the raw window text, joined by newlines, never the gutter numbers', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<ReadBlock label="a" lines={lines(3, 41)} totalLines={180} />)
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(writeText).toHaveBeenCalledWith('line 41\nline 42\nline 43')
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

  it('copies the whole window while the height cap hides its middle', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<ReadBlock label="a" lines={lines(10)} totalLines={10} maxLines={4} />)
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    expect(writeText).toHaveBeenCalledWith(lines(10).map(line => line.text).join('\n'))
    expect(await screen.findByRole('button', { name: '复制成功' })).toBeTruthy()
  })

  it('does not claim success when the host refuses the write', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    render(<ReadBlock label="a" lines={lines(1)} totalLines={1} />)
    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '复制成功' })).toBeNull()
  })

  it('merges className onto the wrapper', () => {
    const view = render(<ReadBlock className="x" label="a" lines={lines(1)} totalLines={1} />)
    expect(view.container.firstElementChild?.classList.contains('x')).toBe(true)
  })

  it('hides the copy control for an empty window so it cannot wipe the clipboard', () => {
    // A successful read of an empty file settles to lines: [] with card:'read',
    // so this branch is reachable; copying then would clear the clipboard.
    const view = render(<ReadBlock label="empty.ts" lines={[]} totalLines={0} />)
    expect(view.queryByRole('button', { name: '复制' })).toBeNull()
  })
})
