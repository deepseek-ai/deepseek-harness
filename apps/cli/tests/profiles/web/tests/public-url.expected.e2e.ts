/** Built Web-profile acceptance for concrete bind addresses, the advertised public root, and browser authentication. */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { probeNonLoopbackIpv4, probeZonedLoopback } from '../../../../../../scripts/test-non-loopback-address.ts'
import { startPrefixProxy } from '../../../../../../apps/web/tests/prefix-proxy.ts'
import { PROCESS_SHUTDOWN_TIMEOUT_MS } from '../../../../src/process-shutdown.ts'
import { materializeTlsFixture } from '../../../../../../packages/host/webserver/tests/tls-fixture.ts'

const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))
const dshBin = join(repoRoot, 'apps/cli/lib/bin.js')
const builtArtifactsExist = existsSync(dshBin)

/** Browser-facing mount the reference proxy serves and strips. */
const MOUNT = '/tools/dsh/'

const NON_LOOPBACK_IPV4 = builtArtifactsExist ? await probeNonLoopbackIpv4() : undefined

const ZONED_LOOPBACK = builtArtifactsExist ? await probeZonedLoopback() : undefined

/**
 * Every spelling that binds IPv6 loopback. `::0.0.0.1` is the same address as
 * `::1`, and the zoned rows reuse the probed scope on that same address.
 */
const IPV6_LOOPBACKS = ZONED_LOOPBACK === undefined
  ? ['::1', '::0.0.0.1']
  : ['::1', '::0.0.0.1', ZONED_LOOPBACK, ZONED_LOOPBACK.replace('::1%', '::0.0.0.1%')]

/** One live Web child, as `execa` types it. */
type WebChild = ReturnType<typeof spawnWeb>

/** Settled result of a stopped child, carrying the stderr a case asserts on. */
type StoppedWeb = Awaited<WebChild>

/** Start one keyless Web process with an outer lifetime deadline. */
function spawnWeb(root: string, patch: string, interrupt: string, flags: string[]) {
  return execa(process.execPath, [
    dshBin,
    '--profile', 'web',
    '--patch', patch,
    '--no-open',
    '--port', '0',
    ...flags,
  ], {
    cwd: root,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: 'keyless-web-public-url-no-call',
      DSH_AGENTS_HOME: join(root, '.agents'),
      DSH_HOME: join(root, 'home'),
      DSH_TELEMETRY_DISABLED: '1',
      NODE_NO_WARNINGS: '1',
      WEB_INTERRUPT_FILE: interrupt,
    },
    input: '',
    reject: false,
    timeout: 90_000,
    killSignal: 'SIGKILL',
  })
}

/** One booted Web process: its child, bound port, printed startup URL, and bounded stop. */
interface RunningWeb {
  child: WebChild
  port: number
  startup: URL
  /** Stop the child within the shutdown deadline; every caller shares the one settlement. */
  stop(): Promise<StoppedWeb>
}

/**
 * Boot the built CLI and wait for its `dsh web:` line and bound listener port.
 * The marker plugin also polls for the interrupt file and emits `SIGTERM` on
 * the child's own process, because Windows has no deliverable SIGTERM.
 */
async function bootWeb(root: string, flags: string[]): Promise<RunningWeb> {
  const marker = join(root, 'listen-port.mjs')
  const interrupt = join(root, 'interrupt')
  writeFileSync(marker, [
    "import { existsSync } from 'node:fs'",
    "export const name = 'public-url-listen-port'",
    "export const inject = ['webServer']",
    'export function apply(ctx) {',
    "  console.log('public-url-listen-port: ' + ctx.webServer.port)",
    '  const heartbeat = setInterval(() => {',
    '    if (!existsSync(process.env.WEB_INTERRUPT_FILE)) return',
    '    clearInterval(heartbeat)',
    "    process.emit('SIGTERM')",
    '  }, 20)',
    '  ctx.effect(() => () => { clearInterval(heartbeat) })',
    '}',
    '',
  ].join('\n'))
  const patch = join(root, 'extra.yml')
  writeFileSync(patch, `- insert:\n    - name: ${JSON.stringify(pathToFileURL(marker).href)}\n`)
  const child = spawnWeb(root, patch, interrupt, flags)
  const lines = createInterface({ input: child.stdout })
  const ready = Promise.withResolvers<RunningWeb>()
  let stopping: Promise<StoppedWeb> | undefined
  let port: number | undefined
  let startup: URL | undefined
  const announced = (): void => {
    if (port === undefined || startup === undefined) return
    ready.resolve({ child, port, startup, stop: () => stopping ??= stop(child, interrupt) })
  }
  lines.on('line', (line) => {
    if (line.startsWith('public-url-listen-port: ')) port = Number(line.slice('public-url-listen-port: '.length))
    if (line.startsWith('dsh web: http')) startup = new URL(line.slice('dsh web: '.length))
    announced()
  })
  void child.then((result) => {
    ready.reject(new Error(`Web exited before readiness (code ${String(result.exitCode)})\n${result.stderr}`))
  })
  let deadline: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => { reject(new Error('Web profile did not print its URL line and bound port')) }, 60_000)
  })
  try {
    return await Promise.race([ready.promise, expired])
  } catch (error) {
    child.kill('SIGKILL')
    await child
    throw error
  } finally {
    clearTimeout(deadline)
    lines.close()
  }
}

/** Boot one Web process in a private root, run `scenario`, then always stop it and remove the root. */
async function withWeb(flags: string[], scenario: (web: RunningWeb) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-web-public-url-'))
  let web: RunningWeb | undefined
  try {
    web = await bootWeb(root, flags)
    await scenario(web)
  } finally {
    try {
      if (web !== undefined) await web.stop()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

/** Ask the child to shut down through its interrupt marker within a bounded grace period, then force-kill it. */
async function stop(child: WebChild, interrupt: string) {
  writeFileSync(interrupt, '')
  const deadline = setTimeout(() => { child.kill('SIGKILL') }, PROCESS_SHUTDOWN_TIMEOUT_MS * 2)
  try {
    return await child
  } finally {
    clearTimeout(deadline)
  }
}

/** Assert the child reached its own clean exit rather than the fixture's deadline. */
function expectCleanExit(stopped: StoppedWeb): void {
  expect(stopped.timedOut, stopped.stderr).toBe(false)
  expect(stopped.signal, stopped.stderr).toBeUndefined()
  expect(stopped.exitCode, stopped.stderr).toBe(0)
}

/**
 * One request to an explicit transport address with a browser-facing authority.
 * HTTPS verifies the certificate and hostname against the supplied CA or system roots.
 */
async function request(
  protocol: 'http:' | 'https:',
  dial: string, port: number, path: string, host: string, method: 'GET' | 'POST', cookie?: string, ca?: string,
): Promise<Response> {
  const { promise, resolve, reject } = Promise.withResolvers<IncomingMessage>()
  const req = (protocol === 'http:' ? httpRequest : httpsRequest)({
    host: dial, port, path, method,
    ...ca === undefined ? {} : { ca },
    headers: {
      host, 'content-type': 'application/json',
      ...protocol === 'http:' ? {} : { origin: `https://${host}` },
      ...cookie === undefined ? {} : { cookie },
    },
  }, resolve)
  req.once('error', reject)
  req.setTimeout(10_000, () => { req.destroy(new Error('HTTP request timed out')) })
  req.end(method === 'POST'
    ? JSON.stringify({ type: 'client-request', rpcId: 'public-url', method: 'session/create', payload: { args: { request: {} } } })
    : undefined)
  const response = await promise
  const headers = new Headers()
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    headers.append(response.rawHeaders[i]!, response.rawHeaders[i + 1]!)
  }
  return new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status: response.statusCode!, headers })
}

/** Establish the browser session needed by the protected API, keeping the minted cookie's own attributes. */
async function exchange(
  protocol: 'http:' | 'https:',
  dial: string, port: number, path: string, host: string, ca?: string,
): Promise<{ cookie: string; setCookie: string }> {
  const response = await request(protocol, dial, port, path, host, 'GET', undefined, ca)
  const setCookie = response.headers.get('set-cookie')
  await response.arrayBuffer()
  if (setCookie === null) throw new Error(`entry returned ${String(response.status)} without a browser cookie`)
  return { cookie: setCookie.split(';', 1)[0]!, setCookie }
}

describe.skipIf(!builtArtifactsExist)('dsh Web profile bind address and advertised root', () => {
  it('serves the default advertised URL over verified TLS with Secure browser authentication', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-web-tls-'))
    try {
      const tls = await materializeTlsFixture(root)
      await withWeb(['--tls-cert', tls.certFile, '--tls-key', tls.keyFile], async (web) => {
        expect(web.startup.origin).toBe(`https://127.0.0.1:${String(web.port)}`)
        await expect(request('https:', '127.0.0.1', web.port, '/', web.startup.host, 'GET'))
          .rejects.toThrow(/self-signed certificate/i)
        const { cookie, setCookie } = await exchange(
          'https:', '127.0.0.1', web.port, `${web.startup.pathname}${web.startup.search}`, web.startup.host, tls.ca,
        )
        expect(setCookie).toContain('; Secure')
        const index = await request('https:', '127.0.0.1', web.port, '/', web.startup.host, 'GET', cookie, tls.ca)
        expect(index.status).toBe(200)
        expect(await index.text()).toContain('<html')
        const response = await request('https:', '127.0.0.1', web.port, '/api/session/create', web.startup.host, 'POST', cookie, tls.ca)
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ result: { ok: true } })
        const unauthenticated = await request('https:', '127.0.0.1', web.port, '/api/session/create', web.startup.host, 'POST', undefined, tls.ca)
        expect(unauthenticated.status).toBe(401)
        await unauthenticated.arrayBuffer()
        expectCleanExit(await web.stop())
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('serves authenticated requests at the advertised mount and at loopback', async () => {
    await withWeb(['--public-url', `http://gateway.example${MOUNT.slice(0, -1)}`, '--trusted-host', 'gateway.example'], async (web) => {
      expect(web.startup.origin).toBe('http://gateway.example')
      expect(web.startup.pathname).toBe(MOUNT)
      expect(web.startup.searchParams.get('token')).not.toBeNull()
      const proxy = await startPrefixProxy({ prefix: MOUNT })
      try {
        proxy.setTarget(web.port)
        const entries = [
          { dial: '127.0.0.1', port: proxy.port, prefix: MOUNT, host: web.startup.host },
          { dial: '127.0.0.1', port: web.port, prefix: '/', host: `127.0.0.1:${String(web.port)}` },
        ]
        for (const entry of entries) {
          const { cookie } = await exchange('http:', entry.dial, entry.port, `${entry.prefix}${web.startup.search}`, entry.host)
          const response = await request('http:', entry.dial, entry.port, `${entry.prefix}api/session/create`, entry.host, 'POST', cookie)
          expect(response.status).toBe(200)
          expect(await response.json()).toMatchObject({ result: { ok: true } })
        }
        const foreign = await request('http:', '127.0.0.1', proxy.port, `${MOUNT}api/session/create`, 'evil.example', 'POST')
        expect(foreign.status).toBe(403)
        await foreign.arrayBuffer()
      } finally {
        await proxy.close()
      }
      expectCleanExit(await web.stop())
    })
  })

  it.skipIf(NON_LOOPBACK_IPV4 === undefined)('serves the bound address and a declared authority, refusing any other name', async () => {
    const trustedHost = 'dsh-direct.example'
    await withWeb(['--host', NON_LOOPBACK_IPV4!, '--trusted-host', trustedHost], async (web) => {
      expect(web.startup.origin).toBe(`http://${NON_LOOPBACK_IPV4!}:${String(web.port)}`)
      expect(web.startup.pathname).toBe('/')
      const token = web.startup.searchParams.get('token')
      expect(token).not.toBeNull()
      const authority = `${NON_LOOPBACK_IPV4!}:${String(web.port)}`
      const { cookie, setCookie } = await exchange('http:', NON_LOOPBACK_IPV4!, web.port, `/${web.startup.search}`, authority)
      // The carrier is plain HTTP, where a browser never returns a Secure cookie.
      expect(setCookie).not.toContain('; Secure')
      const authenticated = await request('http:', NON_LOOPBACK_IPV4!, web.port, '/api/session/create', authority, 'POST', cookie)
      expect(authenticated.status).toBe(200)
      expect(await authenticated.json()).toMatchObject({ result: { ok: true } })

      // A declared authority is admitted without being advertised; any other
      // name for the same socket is a rebound Host.
      const declared = `${trustedHost}:${String(web.port)}`
      const declaredSession = await exchange('http:', NON_LOOPBACK_IPV4!, web.port, `/${web.startup.search}`, declared)
      const viaDeclared = await request('http:', NON_LOOPBACK_IPV4!, web.port, '/api/session/create', declared, 'POST', declaredSession.cookie)
      expect(viaDeclared.status).toBe(200)
      await viaDeclared.arrayBuffer()
      const rebound = await request('http:', NON_LOOPBACK_IPV4!, web.port, '/api/session/create', `evil.example:${String(web.port)}`, 'POST', cookie)
      expect(rebound.status).toBe(403)
      await rebound.arrayBuffer()

      const stopped = await web.stop()
      expectCleanExit(stopped)
      expect(stopped.stderr).toContain(`listening on ${NON_LOOPBACK_IPV4!} over plain HTTP`)
      expect(stopped.stderr).not.toContain(token!)
    })
  })


  it.skipIf(NON_LOOPBACK_IPV4 === undefined)('warns about the plain-HTTP bind even when an HTTPS root is advertised', async () => {
    await withWeb(['--host', NON_LOOPBACK_IPV4!, '--public-url', 'https://app.example/', '--trusted-host', 'app.example'], async (web) => {
      expect(web.startup.origin).toBe('https://app.example')
      expect(web.startup.host).toBe('app.example')
      const token = web.startup.searchParams.get('token')
      expect(token).not.toBeNull()
      const { cookie } = await exchange('http:', NON_LOOPBACK_IPV4!, web.port, `/${web.startup.search}`, 'app.example')
      const authenticated = await request('http:', NON_LOOPBACK_IPV4!, web.port, '/api/session/create', 'app.example', 'POST', cookie)
      expect(authenticated.status).toBe(200)
      expect(await authenticated.json()).toMatchObject({ result: { ok: true } })

      const stopped = await web.stop()
      expectCleanExit(stopped)
      expect(stopped.stderr).toContain(`listening on ${NON_LOOPBACK_IPV4!} over plain HTTP`)
    })
  })

  it.each([
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
  ])('prints an IPv4 root for mapped loopback %s and serves it', async (host) => {
    await withWeb(['--host', host], async (web) => {
      expect(web.startup.origin).toBe(`http://127.0.0.1:${String(web.port)}`)
      const { cookie } = await exchange('http:', web.startup.hostname, web.port, `/${web.startup.search}`, web.startup.host)
      const authenticated = await request(
        'http:', web.startup.hostname, web.port, '/api/session/create', web.startup.host, 'POST', cookie,
      )
      expect(authenticated.status).toBe(200)
      expect(await authenticated.json()).toMatchObject({ result: { ok: true } })

      const stopped = await web.stop()
      expectCleanExit(stopped)
      expect(stopped.stderr).not.toContain('plain HTTP')
    })
  })

  it.each(IPV6_LOOPBACKS)('prints the IPv6 loopback root for %s and serves it', async (host) => {
    await withWeb(['--host', host], async (web) => {
      expect(web.startup.origin).toBe(`http://[::1]:${String(web.port)}`)
      const authority = `[::1]:${String(web.port)}`
      const { cookie } = await exchange('http:', '::1', web.port, `/${web.startup.search}`, authority)
      const authenticated = await request('http:', '::1', web.port, '/api/session/create', authority, 'POST', cookie)
      expect(authenticated.status).toBe(200)
      expect(await authenticated.json()).toMatchObject({ result: { ok: true } })

      const stopped = await web.stop()
      expectCleanExit(stopped)
      expect(stopped.stderr).not.toContain('plain HTTP')
    })
  })
})
