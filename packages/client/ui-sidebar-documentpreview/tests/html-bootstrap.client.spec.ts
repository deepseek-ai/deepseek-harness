// @vitest-environment jsdom
/** Bootstrap serialization and resource creation in the receiving document's environment. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { createHtmlDocument } from '../src/client/html/bootstrap.ts'
import { decodeText, encodeText } from '../src/client/html/bytes.ts'

afterEach(() => { vi.restoreAllMocks() })

function run(html: string) {
  const open = vi.fn()
  const write = vi.fn<(html: string) => void>()
  const close = vi.fn()
  const createObjectURL = vi.fn<(blob: Blob) => string>().mockImplementation(() => `blob:null/resource-${createObjectURL.mock.calls.length}`)
  const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'))
  runInNewContext(script, {
    document: { open, write, close }, URL: { createObjectURL }, Blob, DOMParser, atob, TextDecoder,
  })
  return { open, write, close, createObjectURL, document: new DOMParser().parseFromString(write.mock.calls[0]![0], 'text/html') }
}

const utf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text)

describe('HTML bootstrap', () => {
  it('carries UTF-8 and script-ending text as data, then writes the unchanged complete HTML', () => {
    const source = '<!doctype html><html lang="zh"><body>你好<script>window.value="</script><p>文本</p>"</script></body></html>'
    const html = createHtmlDocument({ data: utf8(source), assets: [] })
    expect(html.match(/<\/script>/gu)).toHaveLength(1)
    expect(html).not.toContain('你好')
    const result = run(html)
    expect(result.write).toHaveBeenCalledExactlyOnceWith(source)
    expect(result.open).toHaveBeenCalledOnce()
    expect(result.close).toHaveBeenCalledOnce()
    expect(result.createObjectURL).not.toHaveBeenCalled()
  })

  it('creates local resources in the frame and preserves base, inline code and script order attributes', () => {
    const source = '<!doctype html><html lang="en"><head><base href="https://example.invalid/assets/"><link rel="stylesheet" href="./main.css"></head><body><script src="./one.js"></script><script>window.next=1</script><script defer src="./one.js"></script><script async src="https://example.invalid/remote.js"></script></body></html>'
    const result = run(createHtmlDocument({ data: utf8(source), assets: [
      { kind: 'script', reference: './one.js', data: utf8('window.first=1') },
      { kind: 'stylesheet', reference: './main.css', data: utf8('body{color:red}') },
    ] }))
    expect(result.createObjectURL).toHaveBeenCalledTimes(2)
    expect(result.createObjectURL.mock.calls.map(([blob]) => blob.type)).toEqual(['application/javascript', 'text/css'])
    const scripts = [...result.document.querySelectorAll('script')]
    expect(scripts.map(script => script.getAttribute('src'))).toEqual(['blob:null/resource-1', null, 'blob:null/resource-1', 'https://example.invalid/remote.js'])
    expect(scripts[1]?.textContent).toBe('window.next=1')
    expect(scripts[2]?.defer).toBe(true)
    expect(scripts[3]?.hasAttribute('async')).toBe(true)
    expect(result.document.querySelector('link')?.getAttribute('href')).toBe('blob:null/resource-2')
    expect(result.document.querySelector('base')?.getAttribute('href')).toBe('https://example.invalid/assets/')
    expect(result.document.documentElement.lang).toBe('en')
  })

  it('rejects non-UTF-8 root and asset bytes before creating an iframe document', () => {
    expect(() => createHtmlDocument({ data: utf8('<p>root</p>'), assets: [{ kind: 'script', reference: 'bad.js', data: new Uint8Array([255]) }] })).toThrow()
    expect(() => createHtmlDocument({ data: new Uint8Array([255]), assets: [] })).toThrow()
    expect(decodeText(utf8('雪\u2028\u2029'))).toBe('雪\u2028\u2029')
  })

  it('base64-encodes a large UTF-8 payload in browser-safe chunks', () => {
    const source = `${'0123456789abcdef'.repeat(16_384)}雪`
    const bytes = Uint8Array.from(atob(encodeText(source)), character => character.charCodeAt(0))
    expect(decodeText(bytes)).toBe(source)
  })
})
