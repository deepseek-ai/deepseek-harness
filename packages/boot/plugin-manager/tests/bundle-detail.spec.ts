/** Bundle detail documents and their images through a real profile Include and Loader. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Service, type Context } from '@deepseek-ai/cordis'
import { boot, getDshRuntimeVersion, initProfile, loadProfileDirectory, readProfileManifest, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { OFFICIAL_ON_DEMAND_CATALOG } from '@deepseek-ai/dsh-official-bundles'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import PluginManager, { type Config } from '../src/index.ts'
import * as operations from '../src/operations.ts'

afterEach(() => { vi.unstubAllGlobals() })

/** The `connection` Fetch route registry, recording the routes the manager registers. */
class RecordingConnection extends Service {
  /** The instance the latest fixture mounted. */
  static current: RecordingConnection | undefined
  readonly routes = new Map<string, (request: Request) => Promise<Response>>()
  readonly fetch = {
    register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => {
      this.routes.set(route.path, route.fetch)
      return () => Promise.resolve(void this.routes.delete(route.path))
    },
  }

  constructor(ctx: Context) {
    super(ctx, 'connection')
    RecordingConnection.current = this
  }
}

async function fixture(config: Config = {}) {
  const home = await realpath(mkdtempSync(join(tmpdir(), 'plugin-manager-detail-')))
  let owner: Context | undefined
  onTestFinished(async () => { await owner?.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  const dir = join(home, 'profiles', 'test')
  writeFileSync(join(home, 'package.json'), JSON.stringify({ name: 'installation', dependencies: {} }))
  initProfile(dir, ['core', 'documented'])
  const bundle = (name: string, files: Record<string, string>) => {
    const path = join(dir, 'node_modules', name)
    for (const [file, contents] of Object.entries({ 'cordis.patch.yml': '[]', ...files })) {
      mkdirSync(join(path, file, '..'), { recursive: true })
      writeFileSync(join(path, file), contents)
    }
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  }
  bundle('core', { 'cordis.patch.yml': JSON.stringify([{ insert: [{ id: 'manager', name: 'cordis:manager', config }, { id: 'connection', name: 'cordis:connection' }] }]) })
  bundle('documented', {
    'locale/en.json': JSON.stringify({ meta: { detail: 'guide/DETAIL.md' } }),
    'locale/zh.json': JSON.stringify({ meta: { detail: 'guide/DETAIL.zh.md' } }),
    'guide/DETAIL.md': '---\ntitle: x\n---\n# Documented\n\n![shot](img/shot.svg)\n',
    'guide/DETAIL.zh.md': '# 有说明\n',
    'guide/img/shot.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  })
  bundle('plain', { 'readme.md': '# Plain' })
  bundle('bare', {})
  bundle('broken', { 'locale/en.json': JSON.stringify({ meta: { detail: '../outside.md' } }) })
  const manifest = readProfileManifest('test', dir)
  manifest.dependencies = { documented: '1.0.0', plain: '1.0.0', bare: '1.0.0', broken: '1.0.0' }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: loadProfileDirectory('test', dir, join(home, 'package.json')).layers.map(layer => layer.packageName),
    dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (root) => {
    owner = root
    root.provide('profileContext', profile)
    Object.assign(root.loader.builtins, { manager: PluginManager, connection: RecordingConnection })
  })
  const registry = vi.spyOn(operations, 'readProfileRegistry').mockResolvedValue('https://registry.npmjs.org/')
  onTestFinished(() => { registry.mockRestore() })
  const connection = RecordingConnection.current as RecordingConnection
  const image = (query: string) => (connection.routes.get('/api/plugin-manager/detail-file') as (request: Request) => Promise<Response>)(
    new Request(`http://dsh.local/api/plugin-manager/detail-file?${query}`))
  return { manager: ctx.pluginManager, image, connection }
}

const failureOf = async (promise: Promise<unknown>) => remoteErrorOf(await promise.catch((error: unknown) => error))

it('reads an installed bundle\'s localized meta.detail file or README from its directory', async () => {
  const fetch = vi.fn(() => Promise.reject(new Error('no network')))
  vi.stubGlobal('fetch', fetch)
  const { manager } = await fixture()
  expect(await manager.readBundleDetail('documented', 'en-US')).toEqual({
    status: 'found', origin: 'locale', path: 'guide/DETAIL.md', markdown: '# Documented\n\n![shot](img/shot.svg)\n',
  })
  expect(await manager.readBundleDetail('documented', 'zh-CN')).toMatchObject({ origin: 'locale', markdown: '# 有说明\n' })
  expect(await manager.readBundleDetail('plain', 'en')).toEqual({ status: 'found', origin: 'readme', path: 'readme.md', markdown: '# Plain' })
  expect(await manager.readBundleDetail('bare', 'en')).toEqual({ status: 'none' })
  expect(fetch).not.toHaveBeenCalled()
  expect(await failureOf(manager.readBundleDetail('broken', 'en'))).toMatchObject({ code: 'plugin-manager/detail-unavailable', details: { reason: 'invalid' } })
  expect(await failureOf(manager.readBundleDetail('absent', 'en'))).toMatchObject({ code: 'plugin-manager/unknown-bundle', details: { name: 'absent' } })
  expect(await failureOf(manager.readBundleDetail('plain', 'x y'))).toMatchObject({ code: 'plugin-manager/invalid-language', details: { language: 'x y' } })
})

it('serves images beside a bundle document without caching and refuses other paths', async () => {
  const { image, manager, connection } = await fixture({ detailImageMaxBytes: 20 })
  const ok = await image('bundle=documented&document=guide%2FDETAIL.md&path=img%2Fshot.svg')
  expect([ok.status, ok.headers.get('content-type'), ok.headers.get('cache-control'), ok.headers.get('content-security-policy')?.startsWith('sandbox')])
    .toEqual([413, 'text/plain; charset=utf-8', 'no-store', true])
  expect(await ok.text()).toBe('too-large')
  expect((await image('bundle=documented&document=guide%2FDETAIL.md&path=..%2F..%2Fpackage.json')).status).toBe(404)
  expect((await image('bundle=documented&document=guide%2FDETAIL.md&path=img%2Fmissing.png')).status).toBe(404)
  expect((await image('bundle=absent&document=README.md&path=a.png')).status).toBe(404)
  expect((await image('bundle=documented&document=README.md')).status).toBe(400)
  const read = vi.spyOn(manager, 'listBundles').mockRejectedValueOnce(new TypeError('bug'))
  await expect(image('bundle=documented&document=README.md&path=a.png')).rejects.toThrow('bug')
  read.mockRestore()
  const { image: roomy } = await fixture()
  const served = await roomy('bundle=documented&document=guide%2FDETAIL.md&path=img%2Fshot.svg')
  expect([served.status, served.headers.get('content-type')]).toEqual([200, 'image/svg+xml'])
  expect(await served.text()).toContain('<svg')
  expect([...connection.routes.keys()]).toEqual(['/api/plugin-manager/detail-file'])
})

it('reads an offered official bundle from the npm CDNs at its offered version, npmmirror first when asked', async () => {
  const name = OFFICIAL_ON_DEMAND_CATALOG[0]!.packageName
  const version = getDshRuntimeVersion()
  const fetch = vi.fn((url: string) => Promise.resolve(url === `https://registry.npmmirror.com/${name}/${version}/files/README.md`
    ? new Response('# Official')
    : url.includes('/files/') ? new Response('missing', { status: 404 }) : Promise.reject(new Error(`unexpected ${url}`))))
  vi.stubGlobal('fetch', fetch)
  const { manager, image } = await fixture()
  expect(await manager.readBundleDetail(name, 'en', { npmFileSources: ['npmmirror'] })).toEqual({ status: 'found', origin: 'readme', path: 'README.md', markdown: '# Official' })
  expect(fetch.mock.calls[0]?.[0]).toBe(`https://registry.npmmirror.com/${name}/${version}/files/locale/en.json`)
  fetch.mockClear()
  expect((await image(`bundle=${encodeURIComponent(name)}&document=README.md&path=a.png&sources=npmmirror`)).status).toBe(404)
  expect(fetch.mock.calls[0]?.[0]).toBe(`https://registry.npmmirror.com/${name}/${version}/files/a.png`)
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
  expect(await failureOf(manager.readBundleDetail(name, 'en'))).toMatchObject({ code: 'plugin-manager/detail-unavailable', details: { reason: 'network' } })
  expect((await image(`bundle=${encodeURIComponent(name)}&document=README.md&path=a.png`)).status).toBe(502)
})

it.each([undefined, { npmFileSources: [] }])('asks the CDNs in configured order unless npmmirror is asked first (%o)', async (options) => {
  const name = OFFICIAL_ON_DEMAND_CATALOG[0]!.packageName
  const version = getDshRuntimeVersion()
  const fetch = vi.fn(() => Promise.resolve(new Response('missing', { status: 404 })))
  vi.stubGlobal('fetch', fetch)
  const { manager } = await fixture({ detailNpmFileSources: ['unpkg', 'npmmirror'] })
  expect(await manager.readBundleDetail(name, 'en', options)).toEqual({ status: 'none' })
  expect(fetch.mock.calls[0]).toEqual([`https://unpkg.com/${name}@${version}/locale/en.json`, expect.anything()])
})

it('shows no document for an offered bundle without a published version', async () => {
  const name = OFFICIAL_ON_DEMAND_CATALOG[0]!.packageName
  const { manager } = await fixture()
  const list = manager.listBundles.bind(manager)
  vi.spyOn(manager, 'listBundles').mockImplementation(async () => (await list()).map(bundle => bundle.name === name
    ? { ...bundle, installTarget: { spec: 'link:../x', version: 'link:../x' } }
    : bundle))
  expect(await manager.readBundleDetail(name, 'en')).toEqual({ status: 'none' })
  expect((await failureOf(manager.readBundleDetail('documented', 'en')))).toBeUndefined()
})

it('reports a listed bundle whose directory is gone, and keeps failures other than detail failures', async () => {
  const { manager, image } = await fixture()
  const list = manager.listBundles.bind(manager)
  const listing = vi.spyOn(manager, 'listBundles').mockImplementation(async () => [...await list(), {
    name: 'vanished', official: false, availability: 'profile', enabled: false, installed: true, optional: false, removable: true, updatable: false, rows: [], overrides: [],
  }])
  expect(await failureOf(manager.readBundleDetail('vanished', 'en'))).toMatchObject({ code: 'plugin-manager/unknown-bundle', details: { name: 'vanished' } })
  listing.mockRestore()
  // A failure outside the detail rules, here decoding the document, reaches the caller unchanged.
  const decoder = new TextDecoder()
  const decoding = vi.spyOn(TextDecoder.prototype, 'decode').mockImplementation((input) => {
    if (decoding.mock.calls.length > 1) throw new TypeError('bug')
    decoding.mockRestore()
    const text = decoder.decode(input)
    vi.spyOn(TextDecoder.prototype, 'decode').mockImplementation(() => { throw new TypeError('bug') })
    return text
  })
  await expect(manager.readBundleDetail('documented', 'en')).rejects.toThrow('bug')
  vi.restoreAllMocks()
  expect((await image('bundle=documented&document=guide%2FDETAIL.md&path=img%2Fshot.svg')).status).toBe(200)
})
