// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { LinkIcon, classifyLinkPath, type LinkIconKind } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

describe('classifyLinkPath', () => {
  it.each([
    ['src/markdown/render.tsx', 'code'],
    ['site/index.html', 'code'],
    ['data/export.CSV', 'code'],
    ['shots/hero.png', 'image'],
    ['report.pdf', 'document'],
    ['deck.pptx', 'document'],
    ['notes.unknownext', 'other'],
    ['Makefile', 'other'],
    ['C:\\work\\summary.docx', 'document'],
    ['archive.tar/.hidden', 'other'],
  ] as [string, LinkIconKind][])('%s → %s', (path, kind) => {
    expect(classifyLinkPath(path)).toBe(kind)
  })
})

describe('LinkIcon', () => {
  const kinds: LinkIconKind[] = ['url', 'folder', 'code', 'image', 'document', 'other']

  it.each(kinds)('%s renders a distinct aria-hidden svg with currentColor fills only', (kind) => {
    const { container } = render(<LinkIcon kind={kind} />)
    const svg = container.querySelector('svg')!
    expect(svg).not.toBeNull()
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    const markup = container.innerHTML
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}"/)
    expect(markup).toContain('currentColor')
  })

  it('every kind draws its own glyph', () => {
    const paths = kinds.map((kind) => {
      const { container } = render(<LinkIcon kind={kind} />)
      return container.querySelector('path')!.getAttribute('d')
    })
    expect(new Set(paths).size).toBe(kinds.length)
  })

  it('defaults to the 14px inline link seat; size and className land on the svg', () => {
    const { container } = render(<LinkIcon kind="url" />)
    expect(container.querySelector('svg')!.getAttribute('width')).toBe('14')
    const sized = render(<LinkIcon kind="folder" size={20} className="x" />)
    const svg = sized.container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('20')
    expect(svg.getAttribute('height')).toBe('20')
    expect(svg.classList.contains('x')).toBe(true)
  })
})
