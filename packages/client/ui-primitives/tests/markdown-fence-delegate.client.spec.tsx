// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MarkdownText } from '../src/markdown/MarkdownText.tsx'
import { MarkdownDelegateProvider } from '../src/markdown/MarkdownDelegate.tsx'
import { FenceCodeBlock } from '../src/markdown/FenceBlocks.tsx'
import type { MarkdownDelegateFenceInfo } from '../src/markdown/MarkdownDelegate.tsx'
import { markdownLabels } from './labels.client.ts'

afterEach(cleanup)

const FENCE_TS = ['```TS', 'const a = 1', '```'].join('\n')
const FENCE_PLAIN = ['```', 'plain', '```'].join('\n')
const FENCE_EMPTY_TS = ['```ts', '```'].join('\n')
const FENCE_MATH = ['```math', 'x', '```'].join('\n')
const FENCE_DIFF = ['```diff', '-a', '+b', '```'].join('\n')

function renderFenceSpy() {
  return vi.fn((fence: MarkdownDelegateFenceInfo): ReactNode => <output data-testid="fence">{fence.lang}:{fence.code}</output>)
}

describe('MarkdownDelegate.renderCode', () => {
  it('passes a final-language fence to the delegate with its lowercased language', () => {
    const renderCode = renderFenceSpy()
    const { container } = render(
      <MarkdownDelegateProvider renderCode={renderCode}>
        <MarkdownText text={FENCE_TS} labels={markdownLabels} />
      </MarkdownDelegateProvider>,
    )
    expect(renderCode).toHaveBeenCalledWith({ lang: 'ts', code: 'const a = 1', streaming: false })
    expect(renderCode.mock.calls[0]?.[0].meta).toBeUndefined()
    expect(screen.getByTestId('fence').textContent).toBe('ts:const a = 1')
    expect(container.querySelector('.md-code-block')).toBeNull()
  })

  it('passes the rest of the info string as meta', () => {
    const renderCode = renderFenceSpy()
    render(
      <MarkdownDelegateProvider renderCode={renderCode}>
        <MarkdownText text={'```HTML width=480 height=360\n<p>x</p>\n```'} labels={markdownLabels} />
      </MarkdownDelegateProvider>,
    )
    expect(renderCode).toHaveBeenCalledWith({ lang: 'html', code: '<p>x</p>', streaming: false, meta: 'width=480 height=360' })
    expect(renderCode.mock.calls[0]?.[0]).toHaveProperty('meta', 'width=480 height=360')
  })

  it('keeps language-less and empty fences on the built-in blocks', () => {
    const renderCode = renderFenceSpy()
    const { container } = render(
      <MarkdownDelegateProvider renderCode={renderCode}>
        <MarkdownText text={`${FENCE_PLAIN}\n\n${FENCE_EMPTY_TS}`} labels={markdownLabels} />
      </MarkdownDelegateProvider>,
    )
    expect(renderCode).not.toHaveBeenCalled()
    expect(container.querySelector('.md-code-block pre')?.textContent).toBe('plain')
    const empty = container.querySelector('pre > code.language-ts')
    expect(empty).not.toBeNull()
    expect(empty!.outerHTML).toBe('<code class="language-ts"></code>')
  })

  it('hands math and diff fences to the delegate too', () => {
    const renderCode = renderFenceSpy()
    const { container } = render(
      <MarkdownDelegateProvider renderCode={renderCode}>
        <MarkdownText text={`${FENCE_MATH}\n\n${FENCE_DIFF}`} labels={markdownLabels} />
      </MarkdownDelegateProvider>,
    )
    expect(renderCode).toHaveBeenCalledTimes(2)
    expect(renderCode.mock.calls.map(([fence]) => fence.lang)).toEqual(['math', 'diff'])
    expect(container.querySelector('.katex')).toBeNull()
  })

  it('waits for the info string to finish while streaming', () => {
    const renderCode = renderFenceSpy()
    const { rerender } = render(
      <MarkdownDelegateProvider renderCode={renderCode}>
        <MarkdownText text="```t" streaming labels={markdownLabels} />
      </MarkdownDelegateProvider>,
    )
    expect(renderCode).not.toHaveBeenCalled()
    rerender(
      <MarkdownDelegateProvider renderCode={renderCode}>
        <MarkdownText text={'```ts\nlet a'} streaming labels={markdownLabels} />
      </MarkdownDelegateProvider>,
    )
    expect(renderCode).toHaveBeenCalledTimes(1)
    expect(renderCode).toHaveBeenCalledWith({ lang: 'ts', code: 'let a', streaming: true })
  })

  it('a provider change reaches a frozen streaming fence', () => {
    const text = ['```ts', 'const a = 1', '```', '', 'alpha', '', 'beta', '', 'gamma'].join('\n')
    const first = (): ReactNode => <i>first</i>
    const second = (): ReactNode => <i>second</i>
    const { rerender } = render(
      <MarkdownDelegateProvider renderCode={first}>
        <MarkdownText text={text} streaming labels={markdownLabels} />
      </MarkdownDelegateProvider>,
    )
    expect(screen.getByText('first')).toBeTruthy()
    rerender(
      <MarkdownDelegateProvider renderCode={second}>
        <MarkdownText text={text} streaming labels={markdownLabels} />
      </MarkdownDelegateProvider>,
    )
    expect(screen.getByText('second')).toBeTruthy()
    expect(screen.queryByText('first')).toBeNull()
  })

  it('places the delegate output in a fence seat directly under the document root', () => {
    const renderCode = renderFenceSpy()
    const { container } = render(
      <MarkdownDelegateProvider renderCode={renderCode}>
        <MarkdownText text={`before\n\n${FENCE_TS}\n\nafter`} labels={markdownLabels} />
      </MarkdownDelegateProvider>,
    )
    const seat = screen.getByTestId('fence').parentElement
    expect(seat?.className).toContain('_fenceSeat_')
    expect(seat?.parentElement).toBe(container.firstElementChild)
    expect(seat?.children).toHaveLength(1)
  })

  it('renders fences without a seat when no delegate is present', () => {
    const { container } = render(<MarkdownText text={`${FENCE_TS}\n\n${FENCE_MATH}`} labels={markdownLabels} />)
    expect(container.querySelector('.md-code-block')).not.toBeNull()
    expect(container.querySelector('[class*="_fenceSeat_"]')).toBeNull()
  })

  it('keeps one delegated code block instance while the fence streams and settles', () => {
    const renderCode = vi.fn((fence: MarkdownDelegateFenceInfo): ReactNode => (
      <FenceCodeBlock lang={fence.lang} code={fence.code} streaming={fence.streaming} labels={markdownLabels.code} />
    ))
    const view = (text: string, streaming: boolean) => (
      <MarkdownDelegateProvider renderCode={renderCode}>
        <MarkdownText text={text} streaming={streaming} labels={markdownLabels} />
      </MarkdownDelegateProvider>
    )
    const { container, rerender } = render(view('```ts\nconst a = 1\n', true))
    const block = container.querySelector('.md-code-block')
    const seat = container.querySelector('[class*="_fenceSeat_"]')
    expect(block).not.toBeNull()
    expect(seat?.firstElementChild).toBe(block)
    rerender(view('```ts\nconst a = 1\nconst b = 2\n', true))
    expect(container.querySelector('.md-code-block')).toBe(block)
    expect(container.querySelector('[class*="_fenceSeat_"]')).toBe(seat)
    rerender(view('```ts\nconst a = 1\nconst b = 2\n```', false))
    expect(container.querySelector('.md-code-block')).toBe(block)
    expect(container.querySelector('[class*="_fenceSeat_"]')).toBe(seat)
    expect(renderCode.mock.calls.map(([fence]) => fence.streaming)).toEqual([true, true, false])
    expect(block?.querySelector('pre')?.textContent).toBe('const a = 1\nconst b = 2')
  })

  it('passes the info string meta while streaming', () => {
    const renderCode = renderFenceSpy()
    render(
      <MarkdownDelegateProvider renderCode={renderCode}>
        <MarkdownText text={'```ts title=x\nlet a'} streaming labels={markdownLabels} />
      </MarkdownDelegateProvider>,
    )
    expect(renderCode).toHaveBeenCalledWith({ lang: 'ts', code: 'let a', streaming: true, meta: 'title=x' })
  })

  it('renders the built-in blocks without a delegate', () => {
    const math = render(<MarkdownText text={FENCE_MATH} labels={markdownLabels} />)
    expect(math.container.querySelector('.katex')).not.toBeNull()
    math.unmount()
    const diff = render(<MarkdownText text={FENCE_DIFF} labels={markdownLabels} />)
    expect(diff.container.querySelector('pre')!.textContent).toBe('-a\n+b')
  })
})
