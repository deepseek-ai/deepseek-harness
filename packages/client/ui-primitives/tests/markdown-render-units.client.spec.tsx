// @vitest-environment jsdom
// Branch coverage for the mdast renderer that real parses cannot reach: the
// grammar only emits references whose definitions exist, always stamps
// positions and align arrays, and never emits bare list items — but the
// renderer is a pure function over mdast, so hand-built trees exercise its
// defensive arms directly.
import { StrictMode } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type * as Md from 'mdast'
import { MarkdownText } from './markdown-test-components.tsx'
import { markdownLabels } from './labels.client.ts'
import {
  collectReferenceTargets, createReferenceTargets, renderBlocks, renderFootnoteSection,
} from '../src/markdown/render.tsx'
import type { MarkdownRenderContext } from '../src/markdown/render.tsx'

afterEach(cleanup)

function makeContext(): MarkdownRenderContext {
  return {
    streaming: false,
    labels: markdownLabels,
    fileMentions: undefined,
    pathImages: undefined,
    targets: createReferenceTargets(),
    footnoteOrder: [],
    footnoteCounts: new Map(),
  }
}

function renderNodes(nodes: Md.RootContent[], context = makeContext()): HTMLElement {
  const { container } = render(
    <div>{renderBlocks(nodes.map((node, key) => ({ node, key })), context)}</div>,
  )
  return container
}

const text = (value: string): Md.Text => ({ type: 'text', value })

describe('renderBlocks over hand-built trees', () => {
  it('reverts unresolved references to their bracketed source', () => {
    const container = renderNodes([
      {
        type: 'paragraph',
        children: [
          { type: 'linkReference', identifier: 'a', referenceType: 'shortcut', children: [text('one')] },
          { type: 'linkReference', identifier: 'b', referenceType: 'collapsed', children: [text('two')] },
          { type: 'linkReference', identifier: 'c', label: 'C', referenceType: 'full', children: [text('three')] },
          { type: 'imageReference', identifier: 'd', referenceType: 'full', alt: 'pic' },
          { type: 'imageReference', identifier: 'e', referenceType: 'shortcut', alt: null },
        ],
      },
    ])
    expect(container.textContent).toBe('[one][two][][three][C]![pic][d]![]')
    expect(container.querySelector('a')).toBeNull()
  })

  it('keeps the first definition when identifiers repeat', () => {
    const targets = createReferenceTargets()
    collectReferenceTargets([
      { type: 'definition', identifier: 'dup', url: 'https://example.com/first' },
      { type: 'definition', identifier: 'dup', url: 'https://example.com/second' },
      { type: 'footnoteDefinition', identifier: 'fn', children: [] },
      { type: 'footnoteDefinition', identifier: 'fn', children: [{ type: 'paragraph', children: [text('late')] }] },
    ], targets)
    expect(targets.definitions.get('DUP')?.url).toBe('https://example.com/first')
    expect(targets.footnotes.get('FN')?.children).toEqual([])
  })

  it('renders a bare list item, computing looseness from the item itself', () => {
    const item: Md.ListItem = {
      type: 'listItem',
      spread: null,
      children: [
        { type: 'paragraph', children: [text('alpha')] },
        { type: 'paragraph', children: [text('beta')] },
      ],
    }
    const container = renderNodes([item])
    // Two block children make the parentless item loose: paragraphs stay wrapped.
    expect([...container.querySelectorAll('li > p')].map(p => p.textContent)).toEqual(['alpha', 'beta'])
  })

  it('renders spread-null lists and align-less tables', () => {
    const container = renderNodes([
      {
        type: 'list',
        ordered: false,
        spread: null,
        children: [{ type: 'listItem', spread: null, children: [{ type: 'paragraph', children: [text('solo')] }] }],
      },
      {
        type: 'table',
        children: [
          { type: 'tableRow', children: [{ type: 'tableCell', children: [text('h')] }] },
          { type: 'tableRow', children: [{ type: 'tableCell', children: [text('short')] }] },
        ],
      },
    ])
    expect(container.querySelector('li')?.textContent).toBe('solo')
    expect(container.querySelector('th')?.getAttribute('style')).toBeNull()
    expect(container.querySelector('td')?.textContent).toBe('short')
  })

  it('renders a rowless align-less table as an empty fill wrapper', () => {
    // Zero columns is below the wide threshold, so the fill arm applies.
    const container = renderNodes([{ type: 'table', children: [] }])
    const wrapper = container.querySelector('table')?.parentElement
    expect(wrapper?.className).not.toContain('md-table-wide')
    expect(container.querySelector('table')?.childElementCount).toBe(0)
  })

  it('pads rows against the alignment width with empty cells', () => {
    const container = renderNodes([
      {
        type: 'table',
        align: ['left', 'right'],
        children: [
          { type: 'tableRow', children: [{ type: 'tableCell', children: [text('only')] }] },
        ],
      },
    ])
    const cells = [...container.querySelectorAll('th')]
    expect(cells).toHaveLength(2)
    expect(cells[1]?.textContent).toBe('')
  })

  it('renders a checked item without any content as a bare checkbox', () => {
    const container = renderNodes([
      {
        type: 'list',
        ordered: false,
        children: [
          { type: 'listItem', checked: true, children: [] },
          { type: 'listItem', checked: false, children: [{ type: 'paragraph', children: [] }] },
        ],
      },
    ])
    const items = [...container.querySelectorAll('li.task-list-item')]
    expect(items).toHaveLength(2)
    for (const item of items) {
      expect(item.querySelector('input[type="checkbox"]')).not.toBeNull()
      expect(item.textContent?.trim()).toBe('')
    }
  })

  it('renders images with a null alt as an empty alt attribute', () => {
    const targets = createReferenceTargets()
    targets.definitions.set('R', { type: 'definition', identifier: 'r', url: 'https://example.com/r.png' })
    const container = renderNodes([
      { type: 'paragraph', children: [{ type: 'image', url: 'https://example.com/x.png', alt: null }] },
      { type: 'paragraph', children: [{ type: 'imageReference', identifier: 'r', referenceType: 'full', alt: null }] },
    ], { ...makeContext(), targets })
    const images = [...container.querySelectorAll('img')]
    expect(images.map(image => image.getAttribute('alt'))).toEqual(['', ''])
  })

  it('drops a definition nested in a list item without leaving a separator behind', () => {
    const container = renderNodes([
      {
        type: 'list',
        ordered: true,
        start: 3,
        children: [{
          type: 'listItem',
          children: [
            { type: 'paragraph', children: [text('body')] },
            { type: 'definition', identifier: 'x', url: 'https://example.com' },
          ],
        }],
      },
    ])
    expect(container.querySelector('ol')?.getAttribute('start')).toBe('3')
    // The two mdast children make the item loose (wrap newlines around the
    // paragraph); the dropped definition contributes nothing else.
    expect(container.querySelector('li')?.textContent).toBe('\nbody\n')
  })

  it('renders nothing for node types without a mapping', () => {
    const container = renderNodes([
      { type: 'yaml', value: 'front: matter' },
      { type: 'tableRow', children: [] },
      { type: 'paragraph', children: [text('after')] },
    ])
    expect(container.textContent).toBe('after')
  })
})

describe('renderFootnoteSection edge shapes', () => {
  it('skips referenced footnotes without definitions and returns null when none remain', () => {
    const context = makeContext()
    context.footnoteOrder.push('GHOST')
    context.footnoteCounts.set('GHOST', 1)
    expect(renderFootnoteSection(context)).toBeNull()
  })

  it('renders no back-reference markers for an uncounted footnote', () => {
    const context = makeContext()
    context.targets.footnotes.set('Q', {
      type: 'footnoteDefinition',
      identifier: 'q',
      children: [{ type: 'paragraph', children: [text('quiet')] }],
    })
    context.footnoteOrder.push('Q')
    const { container } = render(<div>{renderFootnoteSection(context)}</div>)
    expect(container.querySelector('li')?.textContent).toBe('\nquiet \n')
  })

  it('appends back-references after a non-paragraph body', () => {
    const context = makeContext()
    context.targets.footnotes.set('N', {
      type: 'footnoteDefinition',
      identifier: 'n',
      children: [{ type: 'code', value: 'code body', lang: null }],
    })
    context.footnoteOrder.push('N')
    context.footnoteCounts.set('N', 1)
    const { container } = render(<div>{renderFootnoteSection(context)}</div>)
    const item = container.querySelector('li')
    expect(item?.querySelector('.md-code-block')).not.toBeNull()
    expect(item?.textContent).toContain('↩')
  })
})

describe('MarkdownText under StrictMode', () => {
  it('streams identically when React double-invokes render work', () => {
    const doc = 'one\n\ntwo\n\nthree\n\nfour\n\nfive'
    const strict = render(<StrictMode><MarkdownText text={doc.slice(0, 8)} streaming /></StrictMode>)
    strict.rerender(<StrictMode><MarkdownText text={doc} streaming /></StrictMode>)
    const plain = render(<MarkdownText text={doc} streaming />)
    expect(strict.container.innerHTML).toBe(plain.container.innerHTML)
    strict.unmount()
    plain.unmount()
  })
})
