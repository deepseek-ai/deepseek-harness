/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts the webserver row, and every assertion observes the
 * user-visible HTTP surface of the running server (routing precedence, index
 * taps, fallback-seat semantics, per-request error containment, teardown).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer, { renderIndexInjections } from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Write a cordis.yml with one webserver row, then boot it through the real Loader. */
async function loadComposition(port = 0, gzip = false): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-webserver-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    `    port: ${String(port)}`,
    ...(gzip
      ? [
        '    compression: gzip',
        '    compressionLevel: 1',
        '    compressionThresholdBytes: 16',
      ]
      : []),
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** GET (by default) one path against the running server; returns status plus a body prefix. */
async function request(
  port: number,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: string; headers: Headers }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, init)
  return { status: response.status, body: (await response.text()).slice(0, 80), headers: response.headers }
}

/** Open one raw upgrade request and return after the handler writes its response. */
async function upgrade(port: number, path: string): Promise<ReturnType<typeof connect>> {
  const socket = connect(port, '127.0.0.1')
  await once(socket, 'connect')
  const response = once(socket, 'data')
  socket.write([
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${String(port)}`,
    'Connection: Upgrade',
    'Upgrade: dsh-test',
    '',
    '',
  ].join('\r\n'))
  const [data] = await response as [Buffer]
  expect(String(data)).toContain('101 Switching Protocols')
  return socket
}

describe('real Loader composition', () => {
  it('applies gzip only to eligible socket-backed HTTP responses', { timeout: 60_000 }, async () => {
    expect(HttpServer.Config({ host: '127.0.0.1', port: 0 })).toEqual({
      host: '127.0.0.1',
      port: 0,
      compression: 'none',
      compressionLevel: 1,
      compressionThresholdBytes: 1024,
    })
    expect(() => HttpServer.Config({
      host: '127.0.0.1', port: 0, compressionLevel: 10,
    })).toThrow()

    const loaded = await loadComposition(0, true)
    const server = loaded.webServer
    const body = 'compressible response '.repeat(8)
    server.register({
      kind: 'exact',
      path: '/text',
      handler: (_req, res) => {
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': String(Buffer.byteLength(body)),
        })
        res.end(body)
      },
    })
    server.register({
      kind: 'exact',
      path: '/stream',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.write(body.slice(0, 40))
        res.end(body.slice(40))
      },
    })
    server.register({
      kind: 'exact',
      path: '/small',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '5' })
        res.end('small')
      },
    })
    server.register({
      kind: 'exact',
      path: '/events',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(body)
      },
    })
    server.register({
      kind: 'exact',
      path: '/archive',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/gzip' })
        res.end(body)
      },
    })
    server.register({
      kind: 'exact',
      path: '/range',
      handler: (_req, res) => {
        res.writeHead(206, { 'content-type': 'text/plain', 'content-range': 'bytes 0-15/160' })
        res.end(body.slice(0, 16))
      },
    })

    const compressed = await request(server.port, '/text', { headers: { 'accept-encoding': 'br, gzip, deflate' } })
    expect(compressed).toMatchObject({ status: 200, body: body.slice(0, 80) })
    expect(compressed.headers.get('content-encoding')).toBe('gzip')
    expect(compressed.headers.get('content-length')).toBeNull()
    expect(compressed.headers.get('vary')).toBe('Accept-Encoding')
    const streamed = await request(server.port, '/stream', { headers: { 'accept-encoding': 'gzip' } })
    expect(streamed).toMatchObject({ body: body.slice(0, 80) })
    expect(streamed.headers.get('content-encoding')).toBe('gzip')
    expect((await request(server.port, '/small', { headers: { 'accept-encoding': 'gzip' } }))
      .headers.get('content-encoding')).toBeNull()

    const identity = await request(server.port, '/text', {
      headers: { 'accept-encoding': 'gzip;q=0.5, identity;q=1' },
    })
    expect(identity.headers.get('content-encoding')).toBeNull()
    expect(identity.headers.get('vary')).toBe('Accept-Encoding')
    expect((await request(server.port, '/events', { headers: { 'accept-encoding': 'gzip' } }))
      .headers.get('content-encoding')).toBeNull()
    expect((await request(server.port, '/archive', { headers: { 'accept-encoding': 'gzip' } }))
      .headers.get('content-encoding')).toBeNull()
    expect((await request(server.port, '/range', { headers: { 'accept-encoding': 'gzip' } }))
      .headers.get('content-encoding')).toBeNull()
  })

  // Real-Loader composition resolves workspace packages through tsx at test
  // time; first resolution after the host/client program split is slow enough
  // to trip the default 5s budget on cold caches.
  it('serves registered routes, index taps, and the fallback-seat semantics', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const server = loaded.webServer
    expect(server).toBeInstanceOf(HttpServer)
    const port = server.port
    expect(port).toBeGreaterThan(0)

    // Routing precedence: exact beats prefix, longest prefix wins, a prefix
    // route answers its own path, and routes own their method handling
    // (POST reaches a registered prefix; 405 is fallback-only semantics).
    server.register({ kind: 'exact', path: '/probe', handler: (_req, res) => { res.writeHead(200); res.end('EXACT') } })
    server.register({ kind: 'prefix', path: '/api', handler: (_req, res) => { res.writeHead(200); res.end('API') } })
    server.register({ kind: 'prefix', path: '/api/deep', handler: (_req, res) => { res.writeHead(200); res.end('DEEP') } })
    expect(await request(port, '/probe')).toMatchObject({ status: 200, body: 'EXACT' })
    expect(await request(port, '/api/anything')).toMatchObject({ status: 200, body: 'API' })
    expect(await request(port, '/api/deep/leaf')).toMatchObject({ status: 200, body: 'DEEP' })
    expect(await request(port, '/api')).toMatchObject({ status: 200, body: 'API' })
    expect(await request(port, '/api/anything', { method: 'POST' })).toMatchObject({ status: 200, body: 'API' })

    // Fallback seat: 404 while unclaimed; the owner answers everything no
    // named route matches; index taps are the owner's to apply; the seat
    // admits exactly one owner and the disposer releases it.
    expect((await request(port, '/no/such/route')).status).toBe(404)
    const untap = server.tapIndex(html => html.replace('<head>', '<head><script>window.__T__=1</script>'))
    expect(server.applyIndexTaps('<head></head>')).toContain('__T__')
    const releaseFallback = server.registerFallback((req, res) => {
      // Decode like a real static server would — a malformed %-escape throws
      // here, probing the webserver's per-request error containment.
      decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(server.applyIndexTaps('<head></head><body>shell</body>'))
    })
    expect(() => server.registerFallback(() => {})).toThrow(/fallback already registered/)
    expect((await request(port, '/no/such/route')).body).toContain('__T__')
    untap()
    expect((await request(port, '/no/such/route')).body).not.toContain('__T__')
    expect((await request(port, '/no/such/route')).body).toContain('shell')

    // Per-request error containment: a malformed %-escape answers 400 and the
    // server keeps serving afterwards (no process-level failure path).
    expect((await request(port, '/%zz')).status).toBe(400)
    expect(await request(port, '/probe')).toMatchObject({ status: 200, body: 'EXACT' })

    // Duplicate (kind, path) is a misconfiguration and throws; the disposer
    // restores registrability (register/disposer symmetry).
    expect(() => server.register({ kind: 'exact', path: '/probe', handler: () => {} }))
      .toThrow(/duplicate exact route/)
    const disposeOnce = server.register({ kind: 'exact', path: '/once', handler: (_req, res) => { res.writeHead(200); res.end('ONCE') } })
    expect(await request(port, '/once')).toMatchObject({ status: 200, body: 'ONCE' })
    disposeOnce()
    expect((await request(port, '/once')).body).toContain('shell') // back to the fallback owner
    expect(() => server.register({ kind: 'exact', path: '/once', handler: () => {} })).not.toThrow()

    // Releasing the seat restores the unclaimed 404 and registrability.
    releaseFallback()
    expect((await request(port, '/no/such/route')).status).toBe(404)
    expect(() => server.registerFallback(() => {})).not.toThrow()

    // Upgrade routes match exact pathnames, reject duplicate ownership, and
    // become registrable again after disposal. The accepted socket stays open
    // so the teardown assertion also covers upgraded-connection ownership.
    let upgradedServerClosed = false
    const disposeUpgrade = server.registerUpgrade({
      path: '/events',
      handler: (_req, socket) => {
        socket.once('close', () => { upgradedServerClosed = true })
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
      },
    })
    expect(() => server.registerUpgrade({ path: '/events', handler: () => {} }))
      .toThrow(/duplicate upgrade route/)
    const upgraded = await upgrade(port, '/events?stream=mux')
    disposeUpgrade()
    expect(() => server.registerUpgrade({ path: '/events', handler: () => {} })).not.toThrow()

    // The webserver contains raw-socket errors even before an upgrade handler
    // has installed its protocol implementation.
    server.registerUpgrade({
      path: '/upgrade-error',
      handler: async (_req, socket) => {
        await Promise.resolve()
        socket.destroy(new Error('test upgrade transport failure'))
      },
    })
    const failedUpgrade = connect(port, '127.0.0.1')
    failedUpgrade.on('error', () => { /* The server-side reset is the fixture outcome. */ })
    await once(failedUpgrade, 'connect')
    const failedUpgradeClosed = once(failedUpgrade, 'close')
    failedUpgrade.write([
      'GET /upgrade-error HTTP/1.1',
      `Host: 127.0.0.1:${String(port)}`,
      'Connection: Upgrade',
      'Upgrade: dsh-test',
      '',
      '',
    ].join('\r\n'))
    await failedUpgradeClosed
    expect(await request(port, '/probe')).toMatchObject({ status: 200, body: 'EXACT' })

    // Teardown closes both ordinary and upgraded sockets before it resolves.
    await loaded.fiber.dispose()
    expect(upgradedServerClosed).toBe(true)
    upgraded.destroy()
    await expect(request(port, '/probe')).rejects.toThrow()
  })

  it('collects injection rows fresh per render and layers taps over the rendered rows', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const server = loaded.webServer
    let flag = 'dark'
    loaded.on('webserver/index-inject', (table) => {
      table.push(
        { kind: 'script', placement: 'head', text: 'window.__Q__=1' },
        { kind: 'script-src', placement: 'head', src: '/plugins/a.js?rev="1"&x=<y>' },
        { kind: 'script-preload', src: '/plugins/b.js?rev="2"&x=<z>' },
        { kind: 'global', name: '__DSH_BOOT__', value: { rev: '</script><b>' } },
        { kind: 'style', text: 'body{margin:0}' },
        { kind: 'html', placement: 'head', html: '<meta name="probe">' },
        { kind: 'script', placement: 'body', text: `window.__P__=${JSON.stringify(flag)}` },
      )
    })

    const html = server.renderIndex('<html><head></head><body>shell</body></html>')
    // Head rows land right after the opening head tag in table order; the body
    // row lands right after the opening body tag.
    const order = [
      '<head>',
      '<script>window.__Q__=1</script>',
      '<script src="/plugins/a.js?rev=&quot;1&quot;&amp;x=&lt;y&gt;"></script>',
      '<link rel="preload" as="script" href="/plugins/b.js?rev=&quot;2&quot;&amp;x=&lt;z&gt;">',
      'globalThis["__DSH_BOOT__"] = {"rev":"\\u003c/script>\\u003cb>"}',
      '<style>body{margin:0}</style>',
      '<meta name="probe">',
      '<body>',
      '<script>window.__P__="dark"</script>',
      'shell',
    ].map(part => html.indexOf(part))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(order.every(at => at !== -1)).toBe(true)

    // Fresh collection per render: the listener reads live state at emit time.
    flag = 'light'
    expect(server.renderIndex('<head></head><body></body>')).toContain('window.__P__="light"')

    // Raw taps still run, over the already-rendered rows.
    const untap = server.tapIndex(h => h.replace('window.__Q__=1', 'window.__Q__=2'))
    expect(server.renderIndex('<head></head><body></body>')).toContain('window.__Q__=2')
    untap()

    // Tag-less fragments: head rows prepend, body rows append, and the
    // boot-readiness tail lands after the last body row.
    expect(renderIndexInjections('<main>x</main>', [
      { kind: 'script', placement: 'head', text: 'H' },
      { kind: 'script', placement: 'body', text: 'B' },
    ])).toBe('<script>H</script><main>x</main><script>B</script>'
      + '<script>(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()</script>')
  })

  it('fails the fiber when the port is already taken (fail-loud at activation)', { timeout: 60_000 }, async () => {
    const first = await loadComposition()
    const takenPort = first.webServer.port
    const firstRoot = root
    root = undefined // keep the first composition's files until the end

    let second: Context | undefined
    try {
      second = await loadComposition(takenPort)
      const entry = [...second.loader.entries()].find(e => e.options.name === '@deepseek-ai/dsh-host-webserver')
      expect(entry?.fiber?.state).toBe(FiberState.FAILED)
      await expect(entry?.fiber?.await()).rejects.toThrow('EADDRINUSE')
    } finally {
      await second?.fiber.dispose()
      context = first
      if (root !== undefined) await rm(root, { recursive: true, force: true })
      root = firstRoot
    }
  })
})
