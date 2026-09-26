// @vitest-environment jsdom
/** Inert parsing precedes the restrictive policy so source markup cannot navigate or load frames. */
import { expect, it } from 'vitest'
import { createBasicHtmlDocument } from '../src/client/html/basic-document.ts'

it('removes MathML navigation and links exposed by parser mutation', () => {
  const cases = [
    '<math href="https://example.invalid/"><mi xlink:href="https://example.invalid/">x</mi></math>',
    '<form><math><mtext></form><form><mglyph><style></math><a href="https://example.invalid/">go</a>',
  ]
  for (const source of cases) {
    const clean = createBasicHtmlDocument(new TextEncoder().encode(source))
    const reparsed = new DOMParser().parseFromString(clean, 'text/html')
    expect(reparsed.querySelector('[href], [xlink\\:href]')).toBeNull()
    expect(reparsed.querySelectorAll('meta[http-equiv]')).toHaveLength(1)
  }
})

it('preserves static content and removes navigation, policy overrides and active documents', () => {
  const html = createBasicHtmlDocument(new TextEncoder().encode(`<!doctype html><html><head>
    <meta http-equiv="refresh" content="0;url=https://example.invalid">
    <meta http-equiv="Content-Security-Policy" content="default-src *">
    <base href="https://example.invalid"><style>p {color: red}</style>
    </head><body><p>Static</p><script>alert(1)</script><iframe src="https://example.invalid"></iframe>
    <object data="https://example.invalid"></object><embed src="https://example.invalid">
    <a href="https://example.invalid">Link</a><svg><a xlink:href="https://example.invalid">SVG</a></svg>
    <img src="data:image/png;base64,AA=="></body></html>`))
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  expect(parsed.head.firstElementChild?.getAttribute('http-equiv')).toBe('Content-Security-Policy')
  expect(parsed.querySelector('meta')?.getAttribute('content')).toContain("connect-src 'none'")
  expect(parsed.querySelectorAll('script, iframe, object, embed, base, a[href], a[xlink\\:href]')).toHaveLength(0)
  expect(parsed.querySelectorAll('meta[http-equiv]')).toHaveLength(1)
  expect(parsed.querySelector('p')?.textContent).toBe('Static')
  expect(parsed.querySelector('style')?.textContent).toContain('color: red')
  expect(parsed.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AA==')
})

it('preserves document styling and removes navigation inside nested templates and SVG animation', () => {
  const html = createBasicHtmlDocument(new TextEncoder().encode(`<html lang="zh" class="dark"><head><link rel="preconnect" href="https://example.invalid"></head><body style="margin:0" dir="rtl">
    <noscript><meta http-equiv="refresh" content="0;url=https://example.invalid"></noscript>
    <div><template shadowrootmode="open"><template><a href="https://example.invalid">Nested</a><iframe src="https://example.invalid"></iframe></template></template></div>
    <svg><a href="https://example.invalid"><set attributeName="href" to="https://example.invalid"/><animate attributeName="href" values="https://example.invalid"/></a></svg>
  </body></html>`))
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  expect(parsed.documentElement.lang).toBe('zh')
  expect(parsed.documentElement.className).toBe('dark')
  expect(parsed.body.style.margin).toBe('0px')
  expect(parsed.body.dir).toBe('rtl')
  expect(parsed.querySelectorAll('noscript, link, set, animate')).toHaveLength(0)
  const nested = parsed.querySelector('template')!.content.querySelector('template')!.content
  expect(nested.querySelector('a')!.hasAttribute('href')).toBe(false)
  expect(nested.querySelector('iframe')).toBeNull()
})
