/** Host package-asset route: exported `./assets/*` files streamed under their revisioned names. */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type { ReadStream } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, LoggerLevel } from '@deepseek-ai/cordis'
import { ModuleLoader } from '@deepseek-ai/cordis-plugin-loader'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { packageAssetReference } from '../src/assets.ts'
import { ClientModuleRegistry } from '../src/index.ts'

/** File read streams the route opens, in order, to observe hashing and body streaming. */
const opened = vi.hoisted(() => [] as { path: string; stream: ReadStream }[])

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    createReadStream: (path: Parameters<typeof actual.createReadStream>[0], options?: Parameters<typeof actual.createReadStream>[1]) => {
      const stream = actual.createReadStream(path, options)
      opened.push({ path: String(path), stream })
      return stream
    },
  }
})

const ASSETS_ID = '@fixture/assets'
const NO_EXPORT_ID = '@fixture/no-export'
const INACTIVE_ID = '@fixture/inactive'
/** Response headers the asset route owns. */
const ASSET_HEADERS = ['content-type', 'cache-control', 'etag', 'x-content-type-options', 'content-security-policy'] as const
const IMMUTABLE = 'public, max-age=31536000, immutable'
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const WEBP = Buffer.from('RIFF....WEBP')

let root: string | undefined
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
  opened.length = 0
})

/** Own one fresh temporary directory per test. */
function fixtureRoot(): string {
  root ??= realpathSync(mkdtempSync(join(tmpdir(), 'dsh-client-assets-')))
  return root
}

/** Write one file, creating its parent directories. */
function writeFile(path: string, contents: string | Buffer): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
  return path
}

/** Create a built client package below the fixture's `node_modules`; returns its `lib/assets` directory. */
function writeClientPackage(packageName: string, exports: Record<string, string | null>): string {
  const pkgRoot = join(fixtureRoot(), 'node_modules', ...packageName.split('/'))
  writeFile(join(pkgRoot, 'package.json'), JSON.stringify({
    name: packageName,
    exports: { '.': './lib/index.js', './client': './lib/client.js', './package.json': './package.json', ...exports },
    dsh: { client: { platform: 'web' } },
  }))
  writeFile(join(pkgRoot, 'lib', 'index.js'), 'export default {}\n')
  writeFile(join(pkgRoot, 'lib', 'client.js'), 'module.exports = {}\n')
  writeFile(join(pkgRoot, 'secret.png'), PNG)
  return join(pkgRoot, 'lib', 'assets')
}

/** Create the active, inactive, and export-less packages; returns the active package's `lib/assets`. */
function writeFixture(): string {
  const assets = writeClientPackage(ASSETS_ID, { './assets/private/*': null, './assets/*': './lib/assets/*' })
  writeFile(join(assets, 'icon.svg'), SVG)
  writeFile(join(assets, 'photo.png'), PNG)
  writeFile(join(assets, 'nested', 'a b.webp'), WEBP)
  // `*` is covered by the reference unit test; Windows cannot create it on disk.
  writeFile(join(assets, "whale(2x)!'.png"), PNG)
  writeFile(join(assets, 'notes.txt'), 'text\n')
  writeFile(join(assets, 'folder.png', 'inner.png'), PNG)
  writeFile(join(assets, 'private', 'hidden.png'), PNG)
  // `a#b.png` resolves here because Node reads `#` in the subpath as a fragment.
  writeFile(join(assets, 'a'), PNG)
  writeFile(join(writeClientPackage(NO_EXPORT_ID, {}), 'photo.png'), PNG)
  writeFile(join(writeClientPackage(INACTIVE_ID, { './assets/*': './lib/assets/*' }), 'photo.png'), PNG)
  return assets
}

/** One route answer reduced to the parts the asset route owns. */
interface Answer {
  status: number
  headers: Partial<Record<typeof ASSET_HEADERS[number], string>>
  body: Buffer
}

function assetHeaders(read: (name: string) => string | string[] | null | undefined): Answer['headers'] {
  const headers: Answer['headers'] = {}
  for (const name of ASSET_HEADERS) {
    const value = read(name)
    if (typeof value === 'string') headers[name] = value
  }
  return headers
}

interface AssetRequestInit {
  method?: string
  headers?: Record<string, string>
}

/** Composed Host: the modules service and a requester through both carriers. */
interface Host {
  service: ClientModuleRegistry
  /** Port of the real Web server. */
  port: number
  /** Warnings any plugin of the composed Host logged. */
  warnings: unknown[][]
  /**
   * Send one raw request target over HTTP, through `webServer.readResource`,
   * and through `fetchBundle`, and require identical answers.
   */
  both: (path: string, init?: AssetRequestInit) => Promise<Answer>
}

/** Compose the real Web server and the modules service over a Loader double listing the active rows. */
async function composeHost(): Promise<Host> {
  const internal = ModuleLoader.fromInternal()
  if (internal === undefined) throw new Error('package-asset tests require the Node module loader internals')
  const context = new Context()
  contexts.push(context)
  const warnings: unknown[][] = []
  context.logger.exporter({ levels: { default: LoggerLevel.WARN }, export: (message) => { if (message.type === 'warn') warnings.push(message.args) } })
  const baseUrl = pathToFileURL(fixtureRoot()).href + '/'
  context.baseUrl = baseUrl
  context.provide('loader', {
    internal,
    *entries() {
      for (const name of [NO_EXPORT_ID, ASSETS_ID]) {
        yield { options: { name }, fiber: {}, disabled: false, parent: { tree: { ctx: { baseUrl } } } }
      }
    },
  })
  await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await context.plugin(ClientModuleRegistry)
  const service = context.get('clientModules')!
  const port = context.webServer.port!
  const http = (path: string, init: AssetRequestInit = {}): Promise<Answer> => new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: init.headers, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('error', reject)
      res.on('end', () => {
        resolve({ status: res.statusCode!, headers: assetHeaders(name => res.headers[name]), body: Buffer.concat(chunks) })
      })
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
  const reader = { principal: { kind: 'owner' } } as Parameters<WebServer['readResource']>[1]
  const both = async (path: string, init?: AssetRequestInit): Promise<Answer> => {
    const answer = await http(path, init)
    for (const response of [
      await context.webServer.readResource(new Request(`http://localhost${path}`, init), reader),
      await service.fetchBundle(new Request(`http://localhost${path}`, init)),
    ]) {
      expect({
        status: response.status,
        headers: assetHeaders(name => response.headers.get(name)),
        body: Buffer.from(await response.arrayBuffer()),
      }).toEqual(answer)
    }
    return answer
  }
  // The Web route registers once the injected webServer is ready.
  await expect.poll(async () => (await http(assetUrl(ASSETS_ID, 'photo.png'))).status).toBe(200)
  return { service, port, warnings, both }
}

/** Absolute route the browser requests for the document-relative build reference to an emitted file. */
function assetUrl(packageName: string, emittedPath: string): string {
  return `/${packageAssetReference(packageName, emittedPath)}`
}

describe('package asset route', () => {
  it('streams exported assets with immutable typed headers and the path as entity tag', async () => {
    writeFixture()
    const { both } = await composeHost()

    expect(await both(assetUrl(ASSETS_ID, 'icon.svg'))).toEqual({
      status: 200,
      headers: {
        'content-type': 'image/svg+xml',
        'cache-control': IMMUTABLE,
        etag: '"icon.svg"',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "script-src 'none'",
      },
      body: SVG,
    })
    expect(await both(assetUrl(ASSETS_ID, 'photo.png'))).toEqual({
      status: 200,
      headers: {
        'content-type': 'image/png',
        'cache-control': IMMUTABLE,
        etag: '"photo.png"',
        'x-content-type-options': 'nosniff',
      },
      body: PNG,
    })
    const nested = await both(assetUrl(ASSETS_ID, 'nested/a b.webp'))
    expect([nested.status, nested.headers.etag, nested.body]).toEqual([200, '"nested/a%20b.webp"', WEBP])
    // The reference encodes the characters an unquoted CSS url() rejects; the route decodes them back.
    const special = await both(assetUrl(ASSETS_ID, "whale(2x)!'.png"))
    expect([special.status, special.headers.etag, special.body]).toEqual([200, '"whale%282x%29%21%27.png"', PNG])
    // The revision lives in the emitted name; a query does not select content.
    expect((await both(`${assetUrl(ASSETS_ID, 'photo.png')}?rev=anything`)).body).toEqual(PNG)
  })

  it('answers HEAD with the same headers and no body, and rejects other methods', async () => {
    writeFixture()
    const { both } = await composeHost()
    const url = assetUrl(ASSETS_ID, 'icon.svg')
    const get = await both(url)

    expect(await both(url, { method: 'HEAD' })).toEqual({ ...get, body: Buffer.alloc(0) })
    expect((await both(url, { method: 'POST' })).status).toBe(405)
  })

  it('answers 304 without opening the file only when If-None-Match equals the entity tag', async () => {
    const assets = writeFixture()
    const { both } = await composeHost()
    const url = assetUrl(ASSETS_ID, 'icon.svg')
    const get = await both(url)
    const opens = opened.filter(entry => entry.path === join(assets, 'icon.svg')).length

    expect(await both(url, { headers: { 'if-none-match': '"icon.svg"' } }))
      .toEqual({ status: 304, headers: get.headers, body: Buffer.alloc(0) })
    expect(opened.filter(entry => entry.path === join(assets, 'icon.svg'))).toHaveLength(opens)
    expect(await both(url, { headers: { 'if-none-match': '"photo.png"' } })).toEqual(get)
  })

  it('streams an asset spanning several read chunks intact through both carriers', async () => {
    const assets = writeFixture()
    // Several default 64 KiB read-stream chunks; small enough for the deep body comparison.
    const large = Buffer.alloc(160 * 1024, 7)
    writeFile(join(assets, 'large.png'), large)
    const { both } = await composeHost()

    const answer = await both(assetUrl(ASSETS_ID, 'large.png'))
    expect(answer.status).toBe(200)
    expect(answer.body.equals(large)).toBe(true)
  })

  it('logs nothing when the browser cancels a streamed asset response', async () => {
    const assets = writeFixture()
    const file = writeFile(join(assets, 'large.png'), Buffer.alloc(8 * 1024 * 1024, 7))
    const { port, warnings } = await composeHost()

    await new Promise<void>((resolve) => {
      const outgoing = request({ host: '127.0.0.1', port, path: assetUrl(ASSETS_ID, 'large.png'), agent: false }, (res) => {
        res.once('data', () => {
          outgoing.destroy()
          resolve()
        })
      })
      // The destroyed request reports its own abort; the cancellation is the point of the test.
      outgoing.on('error', () => undefined)
      outgoing.on('close', () => { resolve() })
      outgoing.end()
    })
    const stream = opened.findLast(entry => entry.path === file)?.stream
    if (stream === undefined) throw new Error('the asset route opened no file stream')
    // The cancelled response body closes the file stream; only the close matters here.
    if (!stream.closed) await new Promise<void>((resolve) => { stream.once('close', () => { resolve() }) })
    // The webserver settles the cancelled exchange in the turn after the file stream closes; nothing is logged then.
    await new Promise(resolve => setImmediate(resolve))
    expect(warnings).toEqual([])
  })

  it('closes the file stream when a shell-carrier body is cancelled', async () => {
    const assets = writeFixture()
    const { service } = await composeHost()
    const response = await service.fetchBundle(new Request(`http://localhost${assetUrl(ASSETS_ID, 'photo.png')}`))
    const body = opened.findLast(entry => entry.path === join(assets, 'photo.png'))?.stream

    await response.body?.cancel()
    expect(body?.destroyed).toBe(true)
  })

  const base = `/plugins/${ASSETS_ID}/assets`
  it.each([
    ['an excluded export subpath', `${base}/private/hidden.png`],
    ['a package without the asset export', `/plugins/${NO_EXPORT_ID}/assets/photo.png`],
    ['a missing file', `${base}/missing.png`],
    ['`..` leaving the asset prefix', `${base}/../../secret.png`],
    ['`%2e%2e` leaving the asset prefix', `${base}/%2e%2e/%2e%2e/secret.png`],
    ['an encoded `..` path', `${base}/..%2f..%2fsecret.png`],
    ['an empty asset path', `${base}/`],
    ['a malformed percent-escape', `${base}/photo%zz.png`],
    ['a decoded `%`', `${base}/100%25.png`],
    ['a decoded `#` that Node reads as a fragment', `${base}/a%23b.png`],
    ['an unsupported extension', `${base}/notes.txt`],
    ['a directory', `${base}/folder.png`],
    ['an inactive package', `/plugins/${INACTIVE_ID}/assets/photo.png`],
  ])('answers 404 for %s', async (_case, url) => {
    writeFixture()
    const { both } = await composeHost()

    expect(await both(url)).toEqual({ status: 404, headers: {}, body: Buffer.alloc(0) })
  })
})
