/** Owner-side served-page resources: rendered index, shell assets, and plugin bundles for a viewer. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { readViewerAsset } from '../src/host/viewer-assets.ts'
import { createViewerReadService } from '../src/host/viewer-read.ts'

const alice = { providerId: 'mock', tenantId: 'tenant', subjectId: 'alice' }
/** The reader's own Peer: the frontend renders that Peer's opening access rows, never a snapshot we pass. */
const readerPeer: PeerScope = {
  id: 'viewer-peer' as PeerId,
  ctx: {} as Context,
  principal: { kind: 'owner' },
  signal: new AbortController().signal,
  interactions: 'none',
  dispose: async () => {},
}

/** A connection double handing every dispatch the reader's own Peer. */
const readerConnection = { createPeer: () => readerPeer } as never

function ownerContext(services: Record<string, unknown>): Context {
  return { get: (name: string) => services[name] } as Pick<Context, 'get'> as Context
}

/**
 * Content type the real frontend resource gives each top-level page file, keyed by the pathname the
 * request carries. Mirrors the `MIME` table in `packages/host/frontend-static/src/index.ts`.
 */
const TOP_LEVEL_CONTENT_TYPES: Record<string, string> = {
  '/manifest.webmanifest': 'application/manifest+json',
  '/favicon.svg': 'image/svg+xml',
  '/favicon-dark.svg': 'image/svg+xml',
}

/** A webserver double whose resource read is the only member the page reader calls. */
const resourceReader = (
  read: (request: Request, peer: PeerScope) => Response | Promise<Response>,
): Pick<WebServer, 'readResource'> => ({ readResource: async (request, peer) => read(request, peer) })

/** Answer one page request from the dist a real `webServer.readResource` would serve. */
const distResource = (request: Request): Response => {
  const pathname = decodeURIComponent(new URL(request.url).pathname)
  if (pathname === '/' || pathname === '/index.html') {
    return new Response('<html>owner</html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })
  }
  if (pathname === '/assets/index.js') {
    return new Response(new TextEncoder().encode('export {}'), {
      headers: { 'content-type': 'text/javascript; charset=utf-8' },
    })
  }
  const contentType = TOP_LEVEL_CONTENT_TYPES[pathname]
  return contentType === undefined
    ? new Response(null, { status: 404 })
    : new Response(new TextEncoder().encode('served'), { headers: { 'content-type': contentType } })
}

const decode = (body: unknown): string => Buffer.from((body as { base64: string }).base64, 'base64').toString()

describe('viewer page resources', () => {
  it('answers the rendered index and shell assets from the webserver resource read', async () => {
    const requested: string[] = []
    const ctx = ownerContext({
      webServer: resourceReader((request) => {
        const url = new URL(request.url)
        requested.push(url.pathname + url.search)
        return distResource(request)
      }),
    })
    const index = await readViewerAsset(ctx, '', readerPeer)
    expect(index).toMatchObject({ status: 200, body: { contentType: 'text/html; charset=utf-8' } })
    expect(decode(index.body)).toBe('<html>owner</html>')
    expect(decode((await readViewerAsset(ctx, 'assets/index.js?v=1', readerPeer)).body)).toBe('export {}')
    expect(await readViewerAsset(ctx, 'assets/missing.js', readerPeer)).toEqual({ status: 404, body: { error: 'asset-not-found' } })
    // The page-relative path and its query reach the resource exactly as the page asked for them.
    expect(requested).toEqual(['/', '/assets/index.js?v=1', '/assets/missing.js'])
  })

  it('renders the index from the reader\u2019s own Peer, not from a snapshot the owner builds', async () => {
    const peers: PeerScope[] = []
    const ctx = ownerContext({
      webServer: resourceReader((_request, peer) => {
        peers.push(peer)
        return new Response(JSON.stringify(peer), { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }),
    })

    const index = await readViewerAsset(ctx, '', readerPeer)
    expect(peers).toEqual([readerPeer])
    expect(JSON.parse(decode(index.body))).toEqual(JSON.parse(JSON.stringify(readerPeer)))
  })

  it('answers plugin bundles from the client module registry, query included', async () => {
    const requested: string[] = []
    const ctx = ownerContext({
      clientModules: {
        fetchBundle: async (request: Request) => {
          requested.push(new URL(request.url).pathname + new URL(request.url).search)
          return request.url.includes('missing')
            ? new Response(null, { status: 404 })
            : new Response('bundle', { headers: { 'content-type': 'text/javascript' } })
        },
      },
    })
    const bundle = await readViewerAsset(ctx, 'plugins/??a/client.js&rev=1', readerPeer)
    expect(bundle).toMatchObject({ status: 200, body: { contentType: 'text/javascript' } })
    expect(decode(bundle.body)).toBe('bundle')
    expect(requested).toEqual(['/plugins/??a/client.js&rev=1'])
    expect(await readViewerAsset(ctx, 'plugins/missing', readerPeer)).toEqual({ status: 404, body: { error: 'asset-not-found' } })
  })

  it('answers a plugin bundle without a declared type as JavaScript', async () => {
    const ctx = ownerContext({
      clientModules: { fetchBundle: async () => new Response(new TextEncoder().encode('bundle')) },
    })
    const bundle = await readViewerAsset(ctx, 'plugins/a/client.js', readerPeer)
    expect(bundle).toMatchObject({ status: 200, body: { contentType: 'text/javascript; charset=utf-8' } })
    expect(decode(bundle.body)).toBe('bundle')
  })

  it('answers a served file without a declared type as opaque bytes', async () => {
    // A resource the owner's own webserver serves from disk may carry no content type; the Relay
    // forwards the answer as octets instead of guessing a type the owner did not state.
    const ctx = ownerContext({
      webServer: resourceReader(() => new Response(new TextEncoder().encode('raw'), { headers: {} })),
    })
    const asset = await readViewerAsset(ctx, 'assets/raw.bin', readerPeer)
    expect(asset).toMatchObject({ status: 200, body: { contentType: 'application/octet-stream' } })
    expect(Buffer.from((asset.body as { base64: string }).base64, 'base64').toString()).toBe('raw')
  })

  it('reports a Host without a served page as unavailable', async () => {
    const ctx = ownerContext({})
    expect((await readViewerAsset(ctx, '', readerPeer)).status).toBe(503)
    expect((await readViewerAsset(ctx, 'plugins/x', readerPeer)).status).toBe(503)
  })

  it('serves only page paths to an admitted viewer', async () => {
    const asked: string[] = []
    let stopped = false
    const read = createViewerReadService({
      connection: readerConnection,
      sharedSessionId: () => 'source',
      forkStateOf: () => ({ shareId: 'share', sessionId: 'source', sessionMode: 'view',
        allowsFork: false, viewerAdmitted: true, stopped }),
      readAsset: async (path, peer) => {
        expect(peer).toBe(readerPeer)
        asked.push(path)
        return { status: 200, body: { contentType: 'text/plain', base64: '' } }
      },
    })
    expect((await read.answer('share', { op: 'asset', path: 'assets/a.js' }, alice)).status).toBe(200)
    expect((await read.answer('share', { op: 'asset', path: 'api/session/list' }, alice)).status).toBe(404)
    stopped = true
    expect((await read.answer('share', { op: 'asset', path: '' }, alice)).status).toBe(403)
    expect(asked).toEqual(['assets/a.js'])
    read.close()
    const pageless = createViewerReadService({ sharedSessionId: () => 'source' })
    expect((await pageless.answer('share', { op: 'asset', path: '' }, alice)).status).toBe(503)
    pageless.close()
  })
})

/**
 * A read service that records every path it is asked for and answers 200 to each.
 * @returns The service, the requested paths in order, and its closer.
 */
function recordingService() {
  const asked: string[] = []
  const read = createViewerReadService({
    connection: readerConnection,
    sharedSessionId: () => 'source',
    forkStateOf: () => ({ shareId: 'share', sessionId: 'source', sessionMode: 'view',
      allowsFork: false, viewerAdmitted: true, stopped: false }),
    readAsset: async (path) => {
      asked.push(path)
      return { status: 200, body: { contentType: 'application/octet-stream', base64: '' } }
    },
  })
  return { read, asked }
}

describe('viewer page top-level files', () => {
  it('answers the three exact top-level files the Relay forwards, with their query intact', async () => {
    const { read, asked } = recordingService()
    onTestFinished(() => { read.close() })

    for (const path of ['manifest.webmanifest', 'favicon.svg', 'favicon-dark.svg', 'manifest.webmanifest?rev=3']) {
      expect((await read.answer('share', { op: 'asset', path }, alice)).status).toBe(200)
    }

    expect(asked).toEqual(['manifest.webmanifest', 'favicon.svg', 'favicon-dark.svg', 'manifest.webmanifest?rev=3'])
  })

  it('keeps every other top-level name refused, including a sibling of an admitted one', async () => {
    const { read, asked } = recordingService()
    onTestFinished(() => { read.close() })

    for (const path of [
      'robots.txt', 'manifest.json', 'favicon.svg.map', 'favicon.svg/extra', 'assets', '/assets', 'plugins',
    ]) {
      expect(await read.answer('share', { op: 'asset', path }, alice))
        .toEqual({ status: 404, body: { error: 'asset-not-found' } })
    }

    expect(asked).toEqual([])
  })

  it('serves the viewer document without its manifest link and leaves the static file alone', async () => {
    const indexHtml = [
      '<!doctype html>',
      '<html lang="en">',
      '  <head>',
      '    <meta charset="utf-8" />',
      '    <link rel="manifest" href="./manifest.webmanifest" />',
      '    <title>owner</title>',
      '  </head>',
      '  <body></body>',
      '</html>',
      '',
    ].join('\n')
    const indexed = resourceReader(
      () => new Response(indexHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    )
    const ctx = ownerContext({ webServer: indexed })
    const read = createViewerReadService({
      connection: readerConnection,
      sharedSessionId: () => 'source',
      forkStateOf: () => ({ shareId: 'share', sessionId: 'source', sessionMode: 'view',
        allowsFork: false, viewerAdmitted: true, stopped: false }),
      readAsset: (path, peer) => readViewerAsset(ctx, path, peer),
    })
    onTestFinished(() => { read.close() })

    const served = await read.answer('share', { op: 'asset', path: '' }, alice)
    expect(served.status).toBe(200)
    const html = decode(served.body)
    expect(html).not.toContain('rel="manifest"')
    // Exactly one line less, every other byte preserved.
    expect(html).toBe(indexHtml.split('\n').filter(line => !line.includes('rel="manifest"')).join('\n'))
    // The Owner's own page reads the same static file and keeps the link.
    expect(decode((await readViewerAsset(ctx, '', readerPeer)).body)).toBe(indexHtml)
  })

  it('refuses every source map while the resources it belongs to stay served', async () => {
    const { read, asked } = recordingService()
    onTestFinished(() => { read.close() })

    for (const path of ['assets/client.js', 'assets/index-abc.js', 'assets/client.css', 'plugins/??a,b/client.js']) {
      expect((await read.answer('share', { op: 'asset', path }, alice)).status).toBe(200)
    }
    expect(asked).toEqual(['assets/client.js', 'assets/index-abc.js', 'assets/client.css', 'plugins/??a,b/client.js'])

    for (const path of ['assets/client.js.map', 'assets/index-abc.js.map', 'assets/client.css.map',
      'plugins/??a,b/client.js.map', 'assets/client.js.map?v=1']) {
      expect(await read.answer('share', { op: 'asset', path }, alice))
        .toEqual({ status: 404, body: { error: 'asset-not-found' } })
    }
    // No map reached the reader: the list is still exactly the four resources served above.
    expect(asked).toEqual(['assets/client.js', 'assets/index-abc.js', 'assets/client.css', 'plugins/??a,b/client.js'])
  })

  it('refuses a source map an `asset` op forwards, in every path spelling', async () => {
    // The Relay reads neither the request line nor the body of `/__share/rpc`, and it forwards both a
    // page-resource read and a raw forwarded read as this same `asset` op, so this gate is the authority:
    // a percent-encoded `.map` names the file the same readers resolve.
    const { read, asked } = recordingService()
    onTestFinished(() => { read.close() })

    for (const path of ['assets/index-x.js.map', 'plugins/??a,b/x.js.map&rev=1',
      'assets/index-x.js%2Emap', 'assets/index-x.js%2emap?v=1', 'plugins/??a,b/x.js%2Emap&rev=1']) {
      expect(await read.answer('share', { op: 'asset', path }, alice))
        .toEqual({ status: 404, body: { error: 'asset-not-found' } })
    }

    expect(asked).toEqual([])
  })

  it('serves an admitted top-level file with the resource\u2019s own content type', async () => {
    const ctx = ownerContext({ webServer: resourceReader(distResource) })

    expect(await readViewerAsset(ctx, 'manifest.webmanifest?rev=3', readerPeer))
      .toMatchObject({ status: 200, body: { contentType: 'application/manifest+json' } })
    expect(await readViewerAsset(ctx, 'favicon.svg', readerPeer))
      .toMatchObject({ status: 200, body: { contentType: 'image/svg+xml' } })
    expect(await readViewerAsset(ctx, 'favicon-dark.svg', readerPeer))
      .toMatchObject({ status: 200, body: { contentType: 'image/svg+xml' } })
    // The directory form stays refused, so admitting names is not a directory grant.
    expect(await readViewerAsset(ctx, 'favicon.svg/extra', readerPeer))
      .toEqual({ status: 404, body: { error: 'asset-not-found' } })
  })
})

describe('viewer page resource diagnostics', () => {
  /**
   * One read service over a share whose every asset read answers the same nine bytes.
   * @param debug - Viewer-debugging switch, omitted for the default.
   * @returns The service; the caller closes it.
   */
  const service = (debug: boolean | undefined) => createViewerReadService({
    connection: readerConnection,
    sharedSessionId: () => 'source',
    forkStateOf: () => ({ shareId: 'share', sessionId: 'source', sessionMode: 'view',
      allowsFork: false, viewerAdmitted: true, stopped: false }),
    ...(debug === undefined ? {} : { debug }),
    readAsset: async () => ({
      status: 200,
      body: { contentType: 'text/javascript', base64: Buffer.from('export {}').toString('base64') },
    }),
  })

  it('names each served resource with its byte count and duration while viewer debugging is on', async () => {
    const lines: unknown[][] = []
    const logged = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args) })
    onTestFinished(() => { logged.mockRestore() })
    const read = service(true)
    onTestFinished(() => { read.close() })

    expect((await read.answer('share', { op: 'asset', path: 'assets/a.js' }, alice)).status).toBe(200)

    expect(lines).toHaveLength(1)
    expect(String(lines[0]?.[0])).toMatch(/^\[liveshare\] viewer asset share=share path=assets\/a\.js bytes=9 ms=\d+$/)
  })

  it('stays silent while viewer debugging is off', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {})
    onTestFinished(() => { logged.mockRestore() })
    const read = service(undefined)
    onTestFinished(() => { read.close() })

    expect((await read.answer('share', { op: 'asset', path: 'assets/a.js' }, alice)).status).toBe(200)

    expect(logged).not.toHaveBeenCalled()
  })
})
