/** Client-face source catalog behavior. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClientSourceCatalog, discoverInspectorClientSourceCatalog } from '../src/client/cdp/sources.ts'
import { inspectorId } from '../src/shared/bridge/ids.ts'

const scriptKey = inspectorId<'RuntimeScriptKey'>('bundle', 'scriptKey')

afterEach(() => { vi.unstubAllGlobals() })

function discoveredCatalog(url: string, source: string, mapUrl?: string, mapStatus = 200) {
  const base = 'https://client.test/mounted/'
  const sourceUrl = new URL(url, base).href
  const sourceMap = JSON.stringify({ version: 3, sources: ['client.ts'], mappings: 'AAAA' })
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const requestedUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (requestedUrl === sourceUrl) return new Response(source)
    if (requestedUrl === mapUrl) return new Response(sourceMap, { status: mapStatus })
    throw new Error(`Unexpected source fetch: ${requestedUrl}`)
  })
  vi.stubGlobal('__DSH_BOOT__', { entries: [{ id: '@deepseek-ai/dsh-experimental-inspector', url, rev: 'abc' }] })
  vi.stubGlobal('document', { baseURI: base })
  vi.stubGlobal('location', { href: 'https://client.test/mounted/session/selected' })
  vi.stubGlobal('fetch', fetch)
  const catalog = discoverInspectorClientSourceCatalog()
  if (catalog === undefined) throw new Error('Expected the boot graph to supply the Inspector source catalog')
  return { catalog, fetch, sourceUrl, sourceMap }
}

const discoveredScriptKey = inspectorId<'RuntimeScriptKey'>('client-bundle', 'scriptKey')

async function readMap(catalog: ClientSourceCatalog) {
  return catalog.execute({ op: 'get-content-chunk', scriptKey: discoveredScriptKey,
    content: 'source-map', offset: 0, maxBytes: 1_024 }, 1_024)
}

describe('Client source catalog', () => {
  it.each([
    ['plugins/??@deepseek-ai/dsh-experimental-inspector/client.js&rev=abc',
      '??@deepseek-ai/dsh-experimental-inspector/client.js.map&rev=abc',
      'https://client.test/mounted/plugins/??@deepseek-ai/dsh-experimental-inspector/client.js.map&rev=abc'],
    ['assets/client.js?rev=abc', 'client.js.map?rev=abc', 'https://client.test/mounted/assets/client.js.map?rev=abc'],
    ['assets/client.js?rev=abc', '../maps/inspector.map?rev=map-rev', 'https://client.test/mounted/maps/inspector.map?rev=map-rev'],
  ])('resolves the emitted map reference for %s against the loaded script URL', async (url, reference, mapUrl) => {
    const source = `export const value = 42\n//# sourceMappingURL=${reference}\r\n`
    try {
      const h = discoveredCatalog(url, source, mapUrl)
      expect(h.fetch).not.toHaveBeenCalled()
      const result = await h.catalog.execute({ op: 'list-scripts' }, 1_024)
      expect(result).toMatchObject({ scripts: [{ url: h.sourceUrl, hash: 'abc', sourceMapUrl: mapUrl }] })
      const map = await readMap(h.catalog)
      if (map.op !== 'get-content-chunk' || !map.available) throw new Error('Expected a source map chunk')
      expect(atob(map.data)).toBe(h.sourceMap)
      await readMap(h.catalog)
      expect(h.fetch.mock.calls).toEqual([[h.sourceUrl], [mapUrl]])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('loads the script before a map-first read and shares that source with later metadata reads', async () => {
    const mapUrl = 'https://client.test/mounted/plugins/??@deepseek-ai/dsh-experimental-inspector/client.js.map&rev=abc'
    try {
      const h = discoveredCatalog('plugins/??@deepseek-ai/dsh-experimental-inspector/client.js&rev=abc',
        'export {}\n//# sourceMappingURL=??@deepseek-ai/dsh-experimental-inspector/client.js.map&rev=abc\n', mapUrl)
      expect(await readMap(h.catalog)).toMatchObject({ available: true })
      expect(await h.catalog.execute({ op: 'list-scripts' }, 1_024)).toMatchObject({ scripts: [{ sourceMapUrl: mapUrl }] })
      expect(h.fetch.mock.calls).toEqual([[h.sourceUrl], [mapUrl]])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('omits source-map metadata and avoids a map fetch when the script has no map reference', async () => {
    try {
      const h = discoveredCatalog('assets/client.js?rev=abc', 'export {}\n')
      expect(await readMap(h.catalog)).toMatchObject({ available: false })
      const result = await h.catalog.execute({ op: 'list-scripts' }, 1_024)
      if (result.op !== 'list-scripts') throw new Error('Expected script metadata')
      expect(result.scripts[0]).not.toHaveProperty('sourceMapUrl')
      expect(h.fetch.mock.calls).toEqual([[h.sourceUrl]])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports a failed map fetch without losing the loaded script or its advertised map URL', async () => {
    const mapUrl = 'https://client.test/mounted/assets/client.js.map?rev=abc'
    try {
      const h = discoveredCatalog('assets/client.js?rev=abc', 'export {}\n//# sourceMappingURL=client.js.map?rev=abc\n', mapUrl, 404)
      await expect(readMap(h.catalog)).rejects.toMatchObject({ code: 'load-failed' })
      expect(await h.catalog.execute({ op: 'list-scripts' }, 1_024)).toMatchObject({ scripts: [{ sourceMapUrl: mapUrl }] })
      expect(h.fetch.mock.calls).toEqual([[h.sourceUrl], [mapUrl]])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('describes scripts and transfers UTF-8 source and maps in bounded chunks', async () => {
    const source = 'const greeting = "你好"\nconsole.log(greeting)\n'
    const sourceMap = JSON.stringify({ version: 3, sources: ['client.ts'], mappings: 'AAAA' })
    const catalog = new ClientSourceCatalog([{
      scriptKey,
      url: 'http://client.test/plugins/inspector/client.js?rev=abc',
      hash: 'abc',
      sourceMapUrl: 'http://client.test/plugins/inspector/client.js.map?rev=abc',
      isModule: false,
      loadSource: async () => source,
      loadSourceMap: async () => sourceMap,
    }])

    await expect(catalog.execute({ op: 'list-scripts' }, 1_024)).resolves.toEqual({
      op: 'list-scripts',
      scripts: [{
        scriptKey,
        url: 'http://client.test/plugins/inspector/client.js?rev=abc',
        hash: 'abc',
        buildId: '',
        sourceMapUrl: 'http://client.test/plugins/inspector/client.js.map?rev=abc',
        startLine: 0,
        startColumn: 0,
        endLine: 2,
        endColumn: 0,
        isModule: false,
        length: source.length,
      }],
    })

    const bytes: Uint8Array[] = []
    let offset = 0
    while (true) {
      const result = await catalog.execute({
        op: 'get-content-chunk',
        scriptKey,
        content: 'source',
        offset,
        maxBytes: 7,
      }, 1_024)
      if (result.op !== 'get-content-chunk' || !result.available) throw new Error('missing source chunk')
      bytes.push(Uint8Array.from(atob(result.data), character => character.charCodeAt(0)))
      offset = result.nextOffset
      if (result.eof) break
    }
    const combined = new Uint8Array(bytes.reduce((total, chunk) => total + chunk.byteLength, 0))
    let cursor = 0
    for (const chunk of bytes) {
      combined.set(chunk, cursor)
      cursor += chunk.byteLength
    }
    expect(new TextDecoder().decode(combined)).toBe(source)

    const map = await catalog.execute({
      op: 'get-content-chunk',
      scriptKey,
      content: 'source-map',
      offset: 0,
      maxBytes: 1_024,
    }, 1_024)
    if (map.op !== 'get-content-chunk' || !map.available) throw new Error('missing source map')
    expect(new TextDecoder().decode(Uint8Array.from(atob(map.data), character => character.charCodeAt(0))))
      .toBe(sourceMap)
  })

  it('rejects assets above the configured aggregate limit', async () => {
    const catalog = new ClientSourceCatalog([{
      scriptKey,
      url: 'http://client.test/client.js',
      hash: 'abc',
      loadSource: async () => 'x'.repeat(101),
    }])
    await expect(catalog.execute({ op: 'list-scripts' }, 100)).rejects.toMatchObject({ code: 'result-too-large' })
  })
})
