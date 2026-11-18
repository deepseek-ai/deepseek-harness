/** The content tab's address parsing, content conversion, and title rules. */
import { describe, expect, it } from 'vitest'
import { documentContentOf, textPage } from '../src/client/content/content.ts'
import { iconKindOf } from '../src/client/content/title.ts'
import type { PreviewContent } from '../src/client/content/contract.ts'

describe('content conversion', () => {
  it('counts lines the way the workspace file reader does', () => {
    expect(textPage('')).toEqual({ text: '', lines: 0 })
    expect(textPage('\n')).toEqual({ text: '', lines: 1 })
    expect(textPage('a')).toEqual({ text: 'a', lines: 1 })
    expect(textPage('a\nb\n')).toEqual({ text: 'a\nb', lines: 2 })
    expect(textPage('a\n\n')).toEqual({ text: 'a\n', lines: 2 })
  })

  it('keeps the complete text beside its page', () => {
    const content: PreviewContent = { mediaType: 'text/plain', text: 'x\n' }
    expect(documentContentOf(content, 'text-pages')).toEqual({ kind: 'text', text: 'x\n', pages: [{ offset: 1, text: 'x', lines: 1 }], eof: true })
  })
})

describe('titles and icons', () => {
  it('chooses a file icon by media type essence and top-level type', () => {
    expect(iconKindOf(undefined)).toBe('other')
    expect(iconKindOf('Text/Markdown; charset=utf-8')).toBe('markdown')
    expect(iconKindOf('text/html')).toBe('html')
    expect(iconKindOf('text/csv')).toBe('excel')
    expect(iconKindOf('application/pdf')).toBe('pdf')
    expect(iconKindOf('image/png')).toBe('image')
    expect(iconKindOf('video/mp4')).toBe('video')
    expect(iconKindOf('text/plain')).toBe('other')
    expect(iconKindOf('image')).toBe('image')
  })
})
