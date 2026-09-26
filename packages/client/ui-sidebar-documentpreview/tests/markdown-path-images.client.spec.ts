import { describe, expect, it } from 'vitest'
import { markdownImageUrl } from '../src/client/markdown/path-images.ts'

const BASE = 'https://example.test/tools/dsh/'

describe('Markdown preview image URLs', () => {
  it.each([
    ['images/a.png', '/work/guide/images/a.png'],
    ['./images/a.png', '/work/guide/./images/a.png'],
    ['../a.png', '/work/guide/../a.png'],
    ['/tmp/a.png', '/tmp/a.png'],
    ['images/中文%20图.png?size=2#detail', '/work/guide/images/中文 图.png'],
    ['images/a%23b%3Fc%25.png', '/work/guide/images/a#b?c%.png'],
  ])('serves %s through the deployment file route', (destination, path) => {
    const url = new URL(markdownImageUrl(BASE, '/work/guide/notes.md', destination)!)
    expect(url.origin + url.pathname).toBe(`${BASE}api/file`)
    expect(url.searchParams.get('path')).toBe(path)
    expect(url.hash).toBe('')
  })

  it.each([
    ['C:\\work\\guide\\notes.md', 'images/a.png', 'C:\\work\\guide\\images/a.png'],
    ['C:/work/guide/notes.md', 'C:/images/a.png', 'C:/images/a.png'],
    ['C:/work/guide/notes.md', 'C:\\images\\a.png', 'C:\\images\\a.png'],
  ])('preserves filesystem spelling from %s', (documentPath, destination, path) => {
    expect(new URL(markdownImageUrl(BASE, documentPath, destination)!).searchParams.get('path')).toBe(path)
  })

  it('waits for document metadata only for relative images', () => {
    expect(markdownImageUrl(BASE, undefined, 'a.png')).toBeUndefined()
    expect(new URL(markdownImageUrl(BASE, undefined, '/tmp/a.png')!).searchParams.get('path')).toBe('/tmp/a.png')
  })

  it.each(['', '#figure', '?size=2', '//cdn.test/a.png', '\\\\server\\a.png', 'file:///tmp/a.png',
    'javascript:alert(1)', 'data:image/png;base64,AAAA', 'https://example.test/a.png', 'C:a.png', '%ZZ.png', 'a%00.png',
  ])('does not rewrite unsupported destination %j', (destination) => {
    expect(markdownImageUrl(BASE, '/work/notes.md', destination)).toBeUndefined()
  })

  it.each(['about:blank', 'dsh-app://shell/', 'file:///app', 'ws://localhost/'])(
    'keeps the file route unavailable for %s', (base) => {
      expect(markdownImageUrl(base, '/work/notes.md', 'a.png')).toBeUndefined()
    },
  )

  it('retains the deployment prefix when the base includes an HTML filename', () => {
    expect(markdownImageUrl(`${BASE}index.html`, '/work/notes.md', 'a.png'))
      .toBe(`${BASE}api/file?path=${encodeURIComponent('/work/a.png')}`)
  })

  it('resolves relative and absolute images through the Desktop file route', () => {
    for (const destination of ['图%20片.png', '/work/guide/图%20片.png']) {
      const url = new URL(markdownImageUrl('dsh-app://app/', '/work/guide/notes.md', destination)!)
      expect(url.href.split('?')[0]).toBe('dsh-app://app/api/file')
      expect(url.searchParams.get('path')).toBe('/work/guide/图 片.png')
    }
  })
})
