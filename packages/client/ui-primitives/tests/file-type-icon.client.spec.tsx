// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyFileType, fileExtension, FileTypeIcon, type FileTypeKind,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from '../src/FileTypeIcon.module.css'

afterEach(cleanup)

describe('fileExtension', () => {
  it.each([
    ['src/README.md', 'md'],
    ['C:\\work\\REPORT.PDF', 'PDF'],
    ['.env', 'env'],
    ['settings.env', 'env'],
    ['archive.tar.gz', 'gz'],
    ['Makefile', ''],
    ['trailing.', ''],
  ])('%s → %s', (path, extension) => {
    expect(fileExtension(path)).toBe(extension)
  })
})

describe('classifyFileType', () => {
  it.each([
    ['src/index.TSX', 'react'],
    ['site/index.html', 'html'],
    ['data/export.CSV', 'code'],
    ['shots/hero.png', 'image'],
    ['notes/README.MDX', 'markdown'],
    ['report.xlsm', 'excel'],
    ['budget.numbers', 'excel'],
    ['deck.key', 'ppt'],
    ['letter.rtf', 'word'],
    ['letter.odt', 'word'],
    ['letter.pages', 'word'],
    ['report.pdf', 'pdf'],
    ['deck.pptx', 'ppt'],
    ['clip.webm', 'video'],
    ['letter.docx', 'word'],
    ['budget.xlsx', 'excel'],
    ['Makefile', 'makefile'],
    ['README', 'markdown'],
    ['.env', 'env'],
    ['settings.env', 'env'],
    ['.hidden', 'other'],
    ['notes.unknownext', 'other'],
    ['extensionless', 'other'],
    ['archive.tar/.hidden', 'other'],
  ] as [string, Exclude<FileTypeKind, 'folder'>][])('%s → %s', (path, type) => {
    expect(classifyFileType(path)).toBe(type)
  })
})

describe('FileTypeIcon', () => {
  const types: FileTypeKind[] = [
    'code', 'excel', 'folder', 'html', 'image', 'markdown', 'other', 'pdf', 'ppt', 'video', 'word',
  ]

  it.each(types)('%s renders a distinct aria-hidden svg without literal colors', (type) => {
    const { container } = render(<FileTypeIcon kind={type} />)
    const svg = container.querySelector('svg')!
    expect(svg).not.toBeNull()
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.classList.contains(css.icon!)).toBe(true)
    expect(svg.classList.contains(css[type]!)).toBe(true)
    const markup = container.innerHTML
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    const paints = [...container.querySelectorAll('[fill], [stroke]')].flatMap(node =>
      ['fill', 'stroke'].map(attribute => node.getAttribute(attribute)).filter(value => value !== null),
    )
    expect(paints).toContain('currentColor')
    expect(paints.every(value => [
      'currentColor', 'none', 'var(--dsw-static-neutral-00)', 'var(--dsw-static-neutral-400)',
    ].includes(value))).toBe(true)
  })

  it.each(types)('%s uses a solid sheet fill', (type) => {
    const { container } = render(<FileTypeIcon kind={type} />)
    const sheet = container.querySelector('svg > path')!
    expect(sheet.getAttribute('fill')).toBe('currentColor')
    expect(sheet.getAttribute('fill-opacity')).toBeNull()
  })

  it('uses white marks and fold for coloured sheets, with a darker grey fold for other', () => {
    const coloured = render(<FileTypeIcon kind="pdf" />).container
    expect(coloured.querySelector('[data-file-type-mark]')?.getAttribute('color'))
      .toBe('var(--dsw-static-neutral-00)')
    expect(coloured.querySelector('svg > path:nth-of-type(2)')?.getAttribute('fill'))
      .toBe('var(--dsw-static-neutral-00)')

    const other = render(<FileTypeIcon kind="other" />).container
    expect(other.querySelector('svg > path:nth-of-type(2)')?.getAttribute('fill'))
      .toBe('var(--dsw-static-neutral-400)')
  })

  it('draws one distinct glyph for every category', () => {
    const paths = types.map((type) => {
      const { container } = render(<FileTypeIcon kind={type} />)
      return [...container.querySelectorAll('path')].map(path => path.getAttribute('d')).join('|')
    })
    expect(new Set(paths).size).toBe(types.length)
  })

  it.each(['code', 'folder', 'html', 'image', 'video'] as const)(
    'enlarges the %s center mark without scaling the file shell',
    (type) => {
      const { container } = render(<FileTypeIcon kind={type} />)
      expect(container.querySelector('[data-file-type-mark]')?.getAttribute('transform')).toContain('scale(1.12)')
      expect(container.querySelector('svg > path')?.getAttribute('transform')).toBeNull()
    },
  )

  it.each(['excel', 'markdown', 'pdf', 'ppt', 'word'] as const)(
    'gives the %s center mark the larger emphasis scale',
    (type) => {
      const { container } = render(<FileTypeIcon kind={type} />)
      expect(container.querySelector('[data-file-type-mark]')?.getAttribute('transform')).toContain('scale(1.22)')
      expect(container.querySelector('svg > path')?.getAttribute('transform')).toBeNull()
    },
  )

  it('keeps the generic file glyph without an invented center mark', () => {
    const { container } = render(<FileTypeIcon kind="other" />)
    expect(container.querySelector('[data-file-type-mark]')).toBeNull()
  })

  it('classifies the path by default and forwards size and className', () => {
    const inferred = render(<FileTypeIcon path="report.pdf" />)
    const explicit = render(<FileTypeIcon kind="pdf" />)
    expect(inferred.container.innerHTML).toBe(explicit.container.innerHTML)
    expect(inferred.container.querySelector('svg')!.getAttribute('width')).toBe('28')

    const sized = render(<FileTypeIcon path="photo.png" size={20} className="x" />)
    const svg = sized.container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('20')
    expect(svg.getAttribute('height')).toBe('20')
    expect(svg.classList.contains('x')).toBe(true)
  })
})
