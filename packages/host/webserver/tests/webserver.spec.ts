/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts the webserver row, and every assertion observes the
 * user-visible HTTP surface of the running server (routing precedence, index
 * taps, fallback-seat semantics, per-request error containment, the TLS
 * listener and its teardown). The bind-address schema and both address
 * predicates are asserted directly, before any server binds; one wildcard load
 * denial goes through the real Loader.
 */

import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { Agent, request as httpsRequest } from 'node:https'
import { connect, createServer as createTcpServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Duplex } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer, { isLoopbackHost, normalizeBindAddress, renderIndexInjections, type TlsConfig } from '../src/index.ts'
import { materializeTlsFixture, type TlsFixture } from './tls-fixture.ts'

/** One-shot barrier for disposal overlapping a pending PEM read. */
const tlsReadGate = vi.hoisted(() => {
  let held: { entered: () => void; resume: Promise<void> } | undefined
  return {
    /** Arm the gate and return the barrier the reading side reaches. */
    arm() {
      const entered = Promise.withResolvers<undefined>()
      const resumed = Promise.withResolvers<undefined>()
      held = { entered: () => { entered.resolve(undefined) }, resume: resumed.promise }
      return { entered: entered.promise, release: () => { resumed.resolve(undefined) } }
    },
    async hold(path: string): Promise<void> {
      if (held === undefined || !path.endsWith('.pem')) return
      const gate = held
      held = undefined
      gate.entered()
      await gate.resume
    },
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async readFile(...args: Parameters<typeof actual.readFile>) {
      if (typeof args[0] === 'string') await tlsReadGate.hold(args[0])
      return actual.readFile(...args)
    },
  }
})

// Every composition a test boots owns a temp root and a fiber; both are released
// even when an assertion fails, so a test may boot more than one.
let compositions: { context: Context; root: string }[] = []
let tlsRoot: string | undefined

afterEach(async () => {
  const loaded = compositions
  compositions = []
  await Promise.all(loaded.map(async ({ context, root }) => {
    await context.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }))
  if (tlsRoot !== undefined) await rm(tlsRoot, { recursive: true, force: true })
  tlsRoot = undefined
})

/** Materialize the generated TLS fixture into a temp root this file cleans up. */
async function tlsFixture(): Promise<TlsFixture> {
  tlsRoot ??= await mkdtemp(join(tmpdir(), 'dsh-webserver-tls-'))
  return materializeTlsFixture(tlsRoot)
}

/**
 * Write a cordis.yml with one webserver row, then boot it through the real Loader.
 * @param tls - a TLS row (partial rows model a user's incomplete YAML), `null`
 * for an explicit empty `tls:` (what a user's `tls:` with no value parses to),
 * or undefined to omit the field entirely.
 */
async function loadComposition(
  port = 0,
  gzip = false,
  host = '127.0.0.1',
  tls?: Partial<TlsConfig> | null,
): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-webserver-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    `    host: '${host}'`,
    `    port: ${String(port)}`,
    ...(tls === undefined
      ? []
      : tls === null
        ? ['    tls:']
        : [
          '    tls:',
          ...(tls.certFile === undefined ? [] : [`      certFile: '${tls.certFile}'`]),
          ...(tls.keyFile === undefined ? [] : [`      keyFile: '${tls.keyFile}'`]),
        ]),
    ...(gzip
      ? [
        '    compression: gzip',
        '    compressionLevel: 1',
        '    compressionThresholdBytes: 16',
      ]
      : []),
    '',
  ].join('\n'))

  const context = new Context()
  compositions.push({ context, root })
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

/** The webserver row's fiber in a Loaded composition. */
function webserverFiber(context: Context) {
  return [...context.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-host-webserver')?.fiber
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

/**
 * GET one path over TLS. `ca` is the client's trust anchor, and a call without
 * it trusts nothing, so it only succeeds if the listener really speaks TLS.
 */
function tlsRequest(
  port: number,
  path: string,
  ca?: string,
  agent?: Agent,
): Promise<{ status: number; body: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>()
  const request = httpsRequest({
    host: '127.0.0.1',
    port,
    path,
    ...(ca === undefined ? {} : { ca }),
    ...(agent === undefined ? {} : { agent }),
  }, (response) => {
    let body = ''
    response.setEncoding('utf8')
    response.on('data', (chunk: string) => { body += chunk })
    response.on('end', () => { resolve({ status: response.statusCode ?? 0, body }) })
  })
  request.on('error', reject)
  request.end()
  return promise
}

/** Open one upgrade request over TLS and return after the handler answers 101. */
function tlsUpgrade(port: number, path: string, ca: string): Promise<{ status: number; socket: Duplex }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; socket: Duplex }>()
  const request = httpsRequest({
    host: '127.0.0.1',
    port,
    path,
    ca,
    headers: { Connection: 'Upgrade', Upgrade: 'dsh-test' },
  })
  request.on('upgrade', (response, socket) => {
    resolve({ status: response.statusCode ?? 0, socket })
  })
  request.on('error', reject)
  request.end()
  return promise
}

describe('real Loader composition', () => {
  it('accepts one concrete IP literal, keeping an IPv6 zone for listen', () => {
    for (const host of ['127.0.0.1', '10.1.2.3', '0.1.2.3', '::1', 'fd00::1', '::ffff:10.1.2.3', '::ffff:0.1.2.3', '0:0:0:0:0:0:0:1', 'fe80::1%lo', '::0.0.0.1', '::0.0.0.1%lo', '::127.0.0.1']) {
      expect(HttpServer.Config({ host, port: 0 }).host).toBe(host)
    }
  })

  it('rejects every wildcard spelling by address value, not by text', () => {
    // Every spelling node:net accepts that parses to the unspecified address:
    // IPv4 any, IPv6 any in long and short forms, IPv4-compatible, and the
    // IPv4-mapped forms of IPv4 any, with or without a zone.
    for (const host of [
      '0.0.0.0', '::', '::0', '0000::', '0::', '0:0:0:0:0:0:0:0', '::0.0.0.0', '::0.0.0.0%lo', '::%lo',
      '::ffff:0.0.0.0', '::ffff:0:0', '::ffff:0000:0000', '0:0:0:0:0:ffff:0:0',
      '0:0:0:0:0:ffff:0.0.0.0', '::ffff:0.0.0.0%eth0',
    ]) {
      expect(() => HttpServer.Config({ host, port: 0 })).toThrow(
        /is an unspecified \(wildcard\) address, which is not supported/,
      )
    }
    for (const host of ['localhost', 'example.com', '*', '[::]', '[fd00::1]', '10.1.2.3/8']) {
      expect(() => HttpServer.Config({ host, port: 0 }))
        .toThrow(/is not a concrete IPv4 or IPv6 address literal/)
    }
  })

  it('denies the IPv4-mapped wildcard through the real plugin load, not only the predicate', async () => {
    // The Loader is nontransactional: a rejected config leaves a FAILED fiber
    // whose await carries the schema error rather than rejecting loader.await().
    const denied = await loadComposition(0, false, '::ffff:0.0.0.0')
    const fiber = webserverFiber(denied)
    expect(fiber?.state).toBe(FiberState.FAILED)
    await expect(fiber?.await()).rejects.toThrow(/is an unspecified \(wildcard\) address/)
  })

  it('classifies loopback bind addresses from the parsed value, including mapped and zone forms', () => {
    for (const host of ['127.0.0.1', '127.8.9.10', '127.5.5.5', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::1%lo', '::0.0.0.1', '::0.0.0.1%lo']) {
      expect(isLoopbackHost(host)).toBe(true)
    }
    // A dotted-quad tail is the address's own low 32 bits, never an IPv4 tail:
    // ::127.0.0.1 is the unrelated IPv6 address ::7f00:1, not IPv4 loopback.
    for (const host of ['10.1.2.3', '::ffff:10.1.2.3', 'fd00::1', 'fe80::1%lo', '::2', 'localhost', '::127.0.0.1', '::127.0.0.1%lo', '::0.0.0.2']) {
      expect(isLoopbackHost(host)).toBe(false)
    }
  })

  it('reads a dotted-quad IPv6 tail as the address it names', () => {
    const rows: [string, string][] = [
      ['::0.0.0.1', '::1'],
      ['::0.0.0.1%lo', '::1'],
      ['::127.0.0.1', '::7f00:1'],
      ['::1', '::1'],
      ['10.1.2.3', '10.1.2.3'],
      // Genuinely IPv4-mapped literals keep their IPv4 form for a browser URL.
      ['::ffff:127.0.0.1', '127.0.0.1'],
      ['::ffff:7f00:1', '127.0.0.1'],
      ['::ffff:10.1.2.3', '10.1.2.3'],
    ]
    for (const [host, text] of rows) expect(normalizeBindAddress(host)).toBe(text)
    expect(() => normalizeBindAddress('localhost')).toThrow(/is not a concrete IPv4 or IPv6 address literal/)
  })


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

  it('serves HTTPS to a verifying client and reports the https protocol', { timeout: 60_000 }, async () => {
    const fixture = await tlsFixture()
    const tls = { certFile: fixture.certFile, keyFile: fixture.keyFile }
    expect(HttpServer.Config({ host: '127.0.0.1', port: 0, tls })).toEqual({
      host: '127.0.0.1',
      port: 0,
      tls,
      compression: 'none',
      compressionLevel: 1,
      compressionThresholdBytes: 1024,
    })

    const loaded = await loadComposition(0, false, '127.0.0.1', tls)
    const server = loaded.webServer
    expect(server.protocol).toBe('https:')
    server.register({
      kind: 'exact',
      path: '/tls',
      handler: (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('SECURE')
      },
    })

    // The fixture CA is the only reason the handshake succeeds, so this is a
    // verifying client rather than one that disabled its checks.
    expect(await tlsRequest(server.port, '/tls', fixture.ca)).toEqual({ status: 200, body: 'SECURE' })
    await expect(tlsRequest(server.port, '/tls')).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
    // The listener speaks TLS only: a plain-HTTP client cannot reach the route.
    await expect(request(server.port, '/tls')).rejects.toThrow()

    await loaded.fiber.dispose()
    await expect(tlsRequest(server.port, '/tls', fixture.ca)).rejects.toThrow()
  })

  it('treats an explicit null tls as no TLS and keeps serving plain HTTP', { timeout: 60_000 }, async () => {
    // A user's `tls:` with no value reaches the service as null through the schema.
    const loaded = await loadComposition(0, false, '127.0.0.1', null)
    const server = loaded.webServer
    expect(server.protocol).toBe('http:')
    server.register({ kind: 'exact', path: '/plain', handler: (_req, res) => { res.writeHead(200); res.end('PLAIN') } })
    expect(await request(server.port, '/plain')).toMatchObject({ status: 200, body: 'PLAIN' })
    await expect(tlsRequest(server.port, '/plain')).rejects.toThrow()
  })

  it('rejects unusable TLS material at activation, before the listener binds', { timeout: 60_000 }, async () => {
    const fixture = await tlsFixture()
    const directory = dirname(fixture.certFile)
    // A valid key that pairs with nothing, plus an empty and an absent file.
    const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const otherKeyFile = join(directory, 'tls-other-key.pem')
    const emptyFile = join(directory, 'tls-empty.pem')
    await writeFile(otherKeyFile, otherKey)
    await writeFile(emptyFile, '')

    // Holding the port makes the ordering observable: material validated only
    // after a successful bind would report EADDRINUSE here instead.
    const holder = createTcpServer()
    const listening = once(holder, 'listening')
    holder.listen(0, '127.0.0.1')
    await listening
    const port = (holder.address() as AddressInfo).port
    const cases: { label: string; config: Partial<TlsConfig>; expected: RegExp }[] = [
      {
        label: 'mismatched key',
        config: { certFile: fixture.certFile, keyFile: otherKeyFile },
        expected: /are not a usable certificate and key pair/,
      },
      {
        label: 'absent file',
        config: { certFile: join(directory, 'tls-absent.pem'), keyFile: fixture.keyFile },
        expected: /cannot read tls\.certFile/,
      },
      {
        label: 'empty file',
        config: { certFile: emptyFile, keyFile: fixture.keyFile },
        expected: /tls\.certFile .* is empty/,
      },
      {
        // Both files are one setting: a row naming only the certificate never resolves.
        label: 'incomplete pair',
        config: { certFile: fixture.certFile },
        expected: /tls\.keyFile/,
      },
    ]
    try {
      for (const { label, config, expected } of cases) {
        const denied = await loadComposition(port, false, '127.0.0.1', config)
        const fiber = webserverFiber(denied)
        expect(fiber?.state, label).toBe(FiberState.FAILED)
        if (fiber === undefined) throw new Error(`${label}: webserver row is missing from the composition`)
        const failure = await fiber.await().then(() => '', (error: unknown) => error instanceof Error ? error.message : String(error))
        expect(failure, label).toMatch(expected)
        expect(failure, label).not.toMatch(/EADDRINUSE/)
        // Diagnostics carry the paths that failed and never the material itself.
        expect(failure, label).not.toMatch(/PRIVATE KEY/)
        expect(failure, label).not.toContain(otherKey.split('\n')[1])
      }
    } finally {
      const closed = once(holder, 'close')
      holder.close()
      await closed
    }
  })

  it('reaches teardown quiescence for upgraded, idle, and handshaking TLS sockets', { timeout: 60_000 }, async () => {
    const fixture = await tlsFixture()
    const loaded = await loadComposition(0, false, '127.0.0.1', { certFile: fixture.certFile, keyFile: fixture.keyFile })
    const server = loaded.webServer
    let upgradeClosed = false
    server.registerUpgrade({
      path: '/events',
      handler: (_req, socket) => {
        socket.once('close', () => { upgradeClosed = true })
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
      },
    })
    server.register({ kind: 'exact', path: '/probe', handler: (_req, res) => { res.writeHead(200); res.end('EXACT') } })

    const clients = new Map<Duplex, Promise<void>>()
    const clientErrors: Error[] = []
    const observeClient = (socket: Duplex): void => {
      const onError = (error: Error): void => { clientErrors.push(error) }
      socket.on('error', onError)
      // Destruction may emit ECONNRESET before close; only close confirms release.
      clients.set(socket, new Promise<void>((resolve) => {
        socket.once('close', () => {
          socket.off('error', onError)
          resolve()
        })
      }))
    }
    const agent = new Agent({ keepAlive: true, ca: fixture.ca, maxSockets: 1 })
    const idleReady = new Promise<void>((resolve) => {
      agent.once('free', (socket: Duplex) => {
        observeClient(socket)
        resolve()
      })
    })
    try {
      const upgraded = await tlsUpgrade(server.port, '/events', fixture.ca)
      observeClient(upgraded.socket)
      expect(upgraded.status).toBe(101)
      expect(await tlsRequest(server.port, '/probe', fixture.ca, agent)).toEqual({ status: 200, body: 'EXACT' })
      await idleReady
      // A TCP connection without a ClientHello is absent from closeAllConnections().
      const handshaking = connect(server.port, '127.0.0.1')
      observeClient(handshaking)
      await once(handshaking, 'connect')

      expect(clientErrors).toEqual([])
      for (const socket of clients.keys()) expect(socket.destroyed).toBe(false)
      await loaded.fiber.dispose()

      await Promise.all(clients.values())
      for (const error of clientErrors) expect(error).toMatchObject({ code: 'ECONNRESET' })
      expect(upgradeClosed).toBe(true)
      await expect(tlsRequest(server.port, '/probe', fixture.ca)).rejects.toThrow()
    } finally {
      agent.destroy()
      for (const socket of clients.keys()) socket.destroy()
      await Promise.all(clients.values())
    }
  })

  it('closes the listener when disposal lands while the TLS material is still being read', { timeout: 60_000 }, async () => {
    const fixture = await tlsFixture()
    const gate = tlsReadGate.arm()
    const loading = loadComposition(0, false, '127.0.0.1', { certFile: fixture.certFile, keyFile: fixture.keyFile })
    await gate.entered
    // loadComposition registers the composition before its Loader starts, so the
    // booting one — and the service its constructor already provided — is
    // observable while initialization is parked inside the TLS read.
    const composed = compositions.at(-1)
    if (composed === undefined) throw new Error('the booting composition is not registered')
    const server = composed.context.webServer
    // Disposal is issued first and settles only after the read, the listen, and
    // the teardown it owns: the listener bound in between must be closed.
    const disposal = composed.context.fiber.dispose()
    gate.release()
    await disposal
    await loading
    expect(server.port).toBeGreaterThan(0)
    await expect(tlsRequest(server.port, '/', fixture.ca)).rejects.toThrow()
  })

  it('fails the fiber when the port is already taken (fail-loud at activation)', { timeout: 60_000 }, async () => {
    const first = await loadComposition()
    const second = await loadComposition(first.webServer.port)
    const fiber = webserverFiber(second)
    expect(fiber?.state).toBe(FiberState.FAILED)
    await expect(fiber?.await()).rejects.toThrow('EADDRINUSE')
  })
})
