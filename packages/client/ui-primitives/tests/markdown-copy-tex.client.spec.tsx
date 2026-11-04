// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MarkdownText } from './markdown-test-components.tsx'
import { copyKatexAsTex } from '../src/markdown/copy-tex.ts'

// jsdom implements no layout or innerText, so textContent stands in for it here
// and these specs assert only the TeX fragments; math-rendering.e2e.ts covers
// the browser's line breaks.
const nativeInnerText = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText')
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement) { return this.textContent },
  })
})
afterAll(() => {
  if (nativeInnerText === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'innerText')
  else Object.defineProperty(HTMLElement.prototype, 'innerText', nativeInnerText)
})
afterEach(() => {
  document.getSelection()?.removeAllRanges()
  cleanup()
})

function select(start: Node, startOffset: number, end: Node, endOffset: number): void {
  const range = document.createRange()
  range.setStart(start, startOffset)
  range.setEnd(end, endOffset)
  document.getSelection()!.removeAllRanges()
  document.getSelection()!.addRange(range)
}

function copy(target: Element): { data: Map<string, string>; prevented: boolean } {
  const data = new Map<string, string>()
  const clipboardData = { setData: (type: string, value: string) => { data.set(type, value) } }
  const prevented = !fireEvent.copy(target, { clipboardData })
  return { data, prevented }
}

describe('MarkdownText math copy', () => {
  it('copies selected inline and display formulas as delimited TeX source', () => {
    const view = render(<MarkdownText text={'Energy $E=mc^2$ and\n\n$$\n\\frac{a}{b}\n$$\n\nend'} />)
    const paragraphs = view.container.querySelectorAll('p')
    const inlineVisual = view.container.querySelector('.katex-html')!
    const lastText = paragraphs[paragraphs.length - 1]!.firstChild!
    select(inlineVisual.firstChild!, 0, lastText, 3)
    const { data, prevented } = copy(inlineVisual)
    expect(prevented).toBe(true)
    for (const type of ['text/plain', 'text/html']) {
      expect(data.get(type)).toContain('$E=mc^2$ and')
      expect(data.get(type)).toContain('$$\\frac{a}{b}$$')
      expect(data.get(type)).toContain('end')
    }
    expect(data.get('text/html')).not.toMatch(/katex-(?:html|mathml)/u)
    expect(view.container.textContent).not.toContain('$E=mc^2$')
    expect(document.getSelection()!.getRangeAt(0).startContainer).toBe(inlineVisual.firstChild)
  })

  it('extends a selection starting or ending inside a formula to the whole formula', () => {
    const view = render(<MarkdownText text={'Energy $E=mc^2$ tail'} />)
    const paragraph = view.container.querySelector('p')!
    const visualText = view.container.querySelector('.katex-html .mord')!.firstChild!
    select(paragraph.firstChild!, 0, visualText, 1)
    expect(copy(paragraph).data.get('text/plain')).toBe('Energy $E=mc^2$')
    select(visualText, 0, paragraph.lastChild!, 3)
    expect(copy(paragraph).data.get('text/plain')).toBe('$E=mc^2$ ta')
  })

  it('marks a selection entirely inside display math as display TeX', () => {
    const view = render(<MarkdownText text={'$$\n\\frac{a}{b}\n$$'} />)
    const glyph = view.container.querySelector('.katex-display .katex-html .mord')!
    select(glyph, 0, glyph, 1)
    expect(copy(glyph).data.get('text/plain')).toBe('$$\\frac{a}{b}$$')
  })

  it('trims the trailing newline of a fenced math block', () => {
    const view = render(<MarkdownText text={'```math\n\\frac{a}{b}\n```'} />)
    const glyph = view.container.querySelector('.katex-display .katex-html .mord')!
    select(glyph, 0, glyph, 1)
    expect(copy(glyph).data.get('text/plain')).toBe('$$\\frac{a}{b}$$')
  })

  it('keeps native copy without math or with a collapsed selection', () => {
    const view = render(<MarkdownText text={'plain text and $x$'} />)
    const text = view.container.querySelector('p')!.firstChild!
    select(text, 0, text, 5)
    expect(copy(text.parentElement!)).toEqual({ data: new Map(), prevented: false })
    select(text, 0, text, 0)
    expect(copy(text.parentElement!).prevented).toBe(false)
  })

  it('keeps native copy for a selection reaching outside the Markdown document', () => {
    const view = render(<><MarkdownText text={'first $x$'} /><p>outside</p></>)
    const formula = view.container.querySelector('.katex-html')!
    const outside = view.container.lastElementChild!.firstChild!
    select(formula, 0, outside, 3)
    expect(copy(formula)).toEqual({ data: new Map(), prevented: false })
  })

  it('keeps data from an inner listener that prevented the default', () => {
    const view = render(<MarkdownText text={'value $x$'} />)
    const paragraph = view.container.querySelector('p')!
    paragraph.addEventListener('copy', (event) => {
      event.clipboardData!.setData('text/plain', 'inner')
      event.preventDefault()
    })
    select(paragraph, 0, paragraph, paragraph.childNodes.length)
    expect(copy(paragraph).data).toEqual(new Map([['text/plain', 'inner']]))
  })

  it('ignores a copy without clipboard data', () => {
    const view = render(<MarkdownText text={'value $x$'} />)
    const root = view.container.firstElementChild as HTMLElement
    select(root, 0, root, root.childNodes.length)
    const event = new Event('copy', { cancelable: true }) as ClipboardEvent
    Object.defineProperty(event, 'clipboardData', { value: null })
    copyKatexAsTex(event, root)
    expect(event.defaultPrevented).toBe(false)
  })

  it('leaves a formula without TeX annotation as rendered text', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>a <span class="katex">visual</span> b</p>'
    document.body.append(root)
    root.addEventListener('copy', (event) => { copyKatexAsTex(event, root) })
    select(root, 0, root, 1)
    expect(copy(root).data.get('text/plain')).toBe('a visual b')
    root.remove()
  })
})
