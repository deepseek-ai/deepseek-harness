// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { LinkIconMedium, LinkIconRegular, classifyLinkPath, type LinkIconKind } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

describe('classifyLinkPath', () => {
  it.each([
    ['src/markdown/render.tsx', 'code'],
    ['styles/site.scss', 'code'],
    ['site/index.html', 'code'],
    ['data/export.CSV', 'document'],
    ['data/export.tsv', 'document'],
    ['shots/hero.png', 'image'],
    ['report.xlsm', 'document'],
    ['report.xlsb', 'document'],
    ['template.xltx', 'document'],
    ['sheet.ods', 'document'],
    ['template.ots', 'document'],
    ['budget.numbers', 'document'],
    ['deck.key', 'document'],
    ['letter.rtf', 'document'],
    ['letter.odt', 'document'],
    ['letter.pages', 'document'],
    ['report.pdf', 'document'],
    ['budget.xlsx', 'document'],
    ['deck.pptx', 'document'],
    ['notes.md', 'other'],
    ['clip.mp4', 'other'],
    ['notes.unknownext', 'other'],
    ['Makefile', 'other'],
    ['README', 'other'],
    ['C:\\work\\summary.docx', 'document'],
    ['archive.tar/.hidden', 'other'],
  ] as [string, LinkIconKind][])('%s → %s', (path, kind) => {
    expect(classifyLinkPath(path)).toBe(kind)
  })
})

describe('LinkIcon', () => {
  const kinds: LinkIconKind[] = ['url', 'folder', 'code', 'image', 'document', 'other']

  it.each(kinds)('%s renders a distinct aria-hidden svg with currentColor artwork only', (kind) => {
    const { container } = render(<LinkIconRegular kind={kind} />)
    const svg = container.querySelector('svg')!
    expect(svg).not.toBeNull()
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    const markup = container.innerHTML
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}"/)
    expect(markup).toContain('currentColor')
  })

  it('every kind draws its own glyph', () => {
    const paths = kinds.map((kind) => {
      const { container } = render(<LinkIconRegular kind={kind} />)
      return container.querySelector('path')!.getAttribute('d')
    })
    expect(new Set(paths).size).toBe(kinds.length)
  })

  it('defaults to the 14px inline link seat; size and className land on the svg', () => {
    const { container } = render(<LinkIconRegular kind="url" />)
    expect(container.querySelector('svg')!.getAttribute('width')).toBe('14')
    const sized = render(<LinkIconRegular kind="folder" size={20} className="x" />)
    const svg = sized.container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('20')
    expect(svg.getAttribute('height')).toBe('20')
    expect(svg.classList.contains('x')).toBe(true)
  })

  it('offers medium artwork with a 1.3px stroke', () => {
    const { container } = render(<LinkIconMedium kind="url" />)
    expect(container.querySelector('svg')?.getAttribute('stroke-width')).toBe('1.3')
  })
})

/** One host per mapped site, plus aliases that must resolve to a mark already listed. */
const SITE_URLS: string[] = [
  'https://github.com/org/repo',
  'https://gist.github.com/abc',
  'https://org.github.io/repo',
  'https://raw.githubusercontent.com/org/repo/main/a.ts',
  'https://gitlab.com/org/repo',
  'https://www.npmjs.com/package/x',
  'https://pypi.org/project/x',
  'https://stackoverflow.com/q/1',
  'https://developer.mozilla.org/en-US/docs/Web',
  'https://en.wikipedia.org/wiki/Harness',
  'https://news.ycombinator.com/item?id=1',
  'https://youtu.be/dQw4w9WgXcQ',
  'https://x.com/x',
  'https://www.bilibili.com/video/BV1',
  'https://zhuanlan.zhihu.com/p/1',
  'https://juejin.cn/post/1',
  'https://blog.csdn.net/post/1',
  'https://www.google.com/search?q=1',
  'https://baike.baidu.com/item/1',
  'https://duckduckgo.com/?q=1',
  'https://www.tiktok.com/@x',
  'https://www.netflix.com/title/1',
  'https://open.spotify.com/track/1',
  'https://www.facebook.com/x',
  'https://www.instagram.com/x',
  'https://www.reddit.com/r/x',
  'https://t.me/x',
  'https://weixin.qq.com/x',
  'https://im.qq.com/x',
  'https://wa.me/1',
  'https://weibo.com/x',
  'https://item.taobao.com/item.htm?id=1',
  'https://www.aliexpress.com/item/1',
  'https://www.ebay.com/itm/1',
  'https://www.quora.com/q/1',
  'https://www.v2ex.com/t/1',
  'https://www.apple.com/mac',
]

/** The single path data of the mark a URL renders. */
function glyphPath(href: string): string {
  const { container } = render(<LinkIconMedium kind="url" href={href} />)
  return container.querySelector('path')!.getAttribute('d')!
}

describe('LinkIcon site marks', () => {
  it('draws each mapped site its own mark, not the globe', () => {
    const globe = render(<LinkIconMedium kind="url" />).container.querySelector('path')!.getAttribute('d')
    const marks = SITE_URLS.map(glyphPath)
    expect(marks).not.toContain(globe)
    // Thirty-seven destinations, thirty-four mapped sites: the three extra
    // GitHub hosts share the GitHub mark, and any other number means the site
    // list grew without this expectation moving with it.
    expect(new Set(marks).size).toBe(34)
  })

  it('resolves the aliases of one site to the same mark', () => {
    const github = glyphPath('https://github.com/org/repo')
    expect(glyphPath('https://gist.github.com/abc')).toBe(github)
    expect(glyphPath('https://org.github.io/repo')).toBe(github)
    expect(glyphPath('https://raw.githubusercontent.com/org/repo/main/a.ts')).toBe(github)
    expect(glyphPath('https://www.npmjs.com/package/x')).toBe(glyphPath('https://npmjs.com/package/x'))
    expect(glyphPath('https://en.wikipedia.org/wiki/Harness')).toBe(glyphPath('https://www.wikipedia.org'))
    expect(glyphPath('https://youtu.be/dQw4w9WgXcQ')).toBe(glyphPath('https://m.youtube.com/watch?v=1'))
    expect(glyphPath('https://twitter.com/x')).toBe(glyphPath('https://x.com/x'))
    expect(glyphPath('https://telegram.org/x')).toBe(glyphPath('https://t.me/x'))
    expect(glyphPath('https://whatsapp.com/x')).toBe(glyphPath('https://wa.me/1'))
  })

  it('keeps the longer suffix mark for a subdomain of a mapped host', () => {
    // weixin.qq.com ends in qq.com as well, so the longest match has to win.
    expect(glyphPath('https://weixin.qq.com/x')).not.toBe(glyphPath('https://im.qq.com/x'))
  })

  it.each([
    ['no destination', undefined],
    ['an unknown host', 'https://example.com/a'],
    ['a host that only ends in a mapped name', 'https://notgithub.com/a'],
    ['a non-http scheme', 'mailto:owner@example.com'],
    ['a destination that is not a URL', 'src/index.ts'],
    ['a single-label host', 'https:///a'],
  ])('keeps the globe for %s', (_case, href) => {
    const globe = render(<LinkIconMedium kind="url" />).container.querySelector('svg')!.outerHTML
    expect(render(<LinkIconMedium kind="url" href={href} />).container.querySelector('svg')!.outerHTML).toBe(globe)
  })

  it('ignores the destination for file categories', () => {
    const plain = render(<LinkIconMedium kind="code" />).container.querySelector('svg')!.outerHTML
    expect(render(<LinkIconMedium kind="code" href="https://github.com/a" />).container.querySelector('svg')!.outerHTML).toBe(plain)
  })

  it('sizes the site mark through the shared seat', () => {
    const { container } = render(<LinkIconMedium kind="url" href="https://github.com/a" size={20} className="x" />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('20')
    expect(svg.getAttribute('height')).toBe('20')
    expect(svg.classList.contains('x')).toBe(true)
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(container.innerHTML).toContain('currentColor')
    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}"/)
  })
})
