/** Raw requests must not replace Vite's page-module responses. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { rawMarkdownRoute } from '../../scripts/project-doc-site.ts'
import { rawMarkdownMiddleware } from '../raw-markdown.ts'

vi.mock('../../scripts/project-doc-site.ts', () => ({ rawMarkdownRoute: vi.fn() }))

function request(url: string | undefined, destination?: string, method = 'GET', base = '/') {
  const req = { url, method, headers: { 'sec-fetch-dest': destination } } as IncomingMessage
  const res = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() }
  const next = vi.fn()
  rawMarkdownMiddleware(base, () => '# Index\n')(req, res as unknown as ServerResponse, next)
  return { res, next }
}

beforeEach(() => {
  vi.mocked(rawMarkdownRoute).mockReset().mockImplementation(path => path === 'en/reference/index.md' ? '# Reference\n' : undefined)
})

describe('raw Markdown development middleware', () => {
  it.each([undefined, 'document', 'empty'])('serves an explicit raw fetch with destination %s', (destination) => {
    const { res, next } = request('/deepseek-harness/en/reference/index.md?dsh-raw=1#section', destination, 'GET', '/deepseek-harness/')
    expect(rawMarkdownRoute).toHaveBeenCalledWith('en/reference/index.md')
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/markdown; charset=utf-8')
    expect(res.end).toHaveBeenCalledWith('# Reference\n')
    expect(next).not.toHaveBeenCalled()
  })

  it.each([undefined, 'document'])('retains ordinary raw navigation with destination %s', (destination) => {
    expect(request('/en/reference/index.md', destination).res.end).toHaveBeenCalledWith('# Reference\n')
  })

  it.each([
    ['/en/reference/index.md', 'script'],
    ['/en/reference/index.md?dsh-raw=1', 'script'],
    ['/en/reference/index.md', 'empty'],
    ['/en/reference/index.md?dsh-raw=0', 'empty'],
    ['/en/reference/index.md?dsh-raw=1', 'style'],
    ['/en/reference/index.md?dsh-raw=1', 'image'],
  ])('delegates %s (%s) to Vite', (url, destination) => {
    const { res, next } = request(url, destination)
    expect(next).toHaveBeenCalledExactlyOnceWith()
    expect(res.end).not.toHaveBeenCalled()
    expect(rawMarkdownRoute).not.toHaveBeenCalled()
  })

  it.each(['/missing.md', '/en/reference.md'])('returns 404 for explicit unpublished route %s', (url) => {
    const { res, next } = request(`${url}?dsh-raw=1`, 'empty')
    expect(res.statusCode).toBe(404)
    expect(res.end).toHaveBeenCalledExactlyOnceWith()
    expect(next).not.toHaveBeenCalled()
  })

  it('preserves llms.txt and omits bodies for HEAD', () => {
    expect(request('/llms.txt').res.end).toHaveBeenCalledWith('# Index\n')
    for (const url of ['/llms.txt', '/en/reference/index.md?dsh-raw=1']) {
      const { res } = request(url, undefined, 'HEAD')
      expect(res.setHeader).toHaveBeenCalledOnce()
      expect(res.end).toHaveBeenCalledWith(undefined)
    }
  })

  it('delegates missing paths, unrelated routes, other bases and non-read methods', () => {
    for (const { next } of [
      request(undefined), request('/missing.md'), request('/guide.html'),
      request('/en/reference/index.md?dsh-raw=1', 'empty', 'GET', '/deepseek-harness/'),
      request('/en/reference/index.md?dsh-raw=1', 'empty', 'POST'),
    ]) expect(next).toHaveBeenCalledExactlyOnceWith()
  })

  it.each(['http://[', 'http://[::1'])('delegates an unparseable request target %s', (url) => {
    const { res, next } = request(url, 'empty')
    expect(next).toHaveBeenCalledExactlyOnceWith()
    expect(res.end).not.toHaveBeenCalled()
    expect(rawMarkdownRoute).not.toHaveBeenCalled()
  })

  it('does not turn a projection error into a successful raw response', () => {
    vi.mocked(rawMarkdownRoute).mockImplementation(() => { throw new Error('Source missing') })
    expect(() => request('/en/reference/index.md?dsh-raw=1', 'empty')).toThrow('Source missing')
  })
})
