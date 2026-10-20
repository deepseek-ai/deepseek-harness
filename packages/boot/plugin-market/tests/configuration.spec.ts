/** Index sources persisted through the profile's Loader and Settings services. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import PluginMarket from '../src/index.ts'

/** The `pluginManager` reads the market makes, with an empty profile. */
class StubPluginManager extends Service {
  constructor(ctx: Context) { super(ctx, 'pluginManager') }
  listBundles() { return Promise.resolve([]) }
  listVersionExemptions() { return { exemptions: {}, warnings: [] } }
}

it('saves index sources without remounting, announces them, and restores them at restart', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-plugin-market-configuration-')))
  let ctx: Awaited<ReturnType<typeof boot>> | undefined
  try {
    const dir = join(home, 'profiles', 'test')
    initProfile(dir, ['test-bundle'])
    const bundle = join(dir, 'node_modules', 'test-bundle')
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    writeFileSync(join(bundle, 'cordis.patch.yml'), readFileSync(new URL('./fixtures/market.patch.yml', import.meta.url)))
    writeFileSync(join(dir, 'cordis.yml'), '[]\n')
    const profile: ProfileContext = {
      name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
      installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
    }
    const start = () => boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (root) => {
      root.provide('profileContext', profile)
      Object.assign(root.loader.builtins, { editor: ConfigEditor, settings: Settings, manager: StubPluginManager, market: PluginMarket })
    })
    ctx = await start()
    const market = ctx.get('pluginMarket')!
    expect(market.listIndexes()).toEqual([{ url: 'https://first.example/index.json' }])
    const entry = ctx.configEditor.entries().find(row => row.options.id === 'plugin-market')!
    const fiber = entry.fiber
    let changes = 0
    ctx.on('plugin-market/changed', () => { changes++ })
    await market.setIndexes(['https://second.example/index.json ', 'http://127.0.0.1:8080/index.json'])
    expect(market.listIndexes().map(index => index.url)).toEqual(['https://second.example/index.json', 'http://127.0.0.1:8080/index.json'])
    expect(entry.fiber === fiber).toBe(true)
    expect(changes).toBe(1)
    expect(readFileSync(profile.patchPath, 'utf8')).toContain('https://second.example/index.json')
    await ctx.fiber.dispose()
    ctx = await start()
    expect(ctx.get('pluginMarket')!.listIndexes().map(index => index.url)).toEqual(['https://second.example/index.json', 'http://127.0.0.1:8080/index.json'])
  } finally {
    try { await ctx?.fiber.dispose() } finally { rmSync(home, { recursive: true, force: true }) }
  }
})

/** The `connection` Fetch route registry, recording the routes the market registers. */
class RecordingConnection extends Service {
  static readonly routes = new Map<string, (request: Request) => Promise<Response>>()
  readonly fetch = {
    register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => {
      RecordingConnection.routes.set(route.path, route.fetch)
      return () => Promise.resolve(void RecordingConnection.routes.delete(route.path))
    },
  }

  constructor(ctx: Context) { super(ctx, 'connection') }
}

it('reads a market entry detail document and serves its images through the composed profile', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-plugin-market-detail-')))
  const commit = 'c'.repeat(40)
  const raw = `https://raw.githubusercontent.com/o/r/${commit}/pkg`
  const files: Record<string, string> = {
    'https://first.example/index.json': JSON.stringify({ format: 1, title: 'Market', plugins: [{
      name: 'from-git', versions: [{ version: '1.0.0', publishTimestamp: 1, source: { type: 'git', url: 'https://github.com/o/r', commit, path: 'pkg' }, engines: { dsh: '*' } }],
    }] }),
    [`${raw}/locale/en.json`]: JSON.stringify({ meta: { detail: 'guide/DETAIL.md' } }),
    [`${raw}/locale/zh.json`]: JSON.stringify({ meta: { detail: 'guide/DETAIL.zh.md' } }),
    [`${raw}/guide/DETAIL.md`]: '# Test entry\n\n![diagram](img/diagram.svg)\n',
    [`${raw}/guide/DETAIL.zh.md`]: '# 测试条目\n',
    [`${raw}/guide/img/diagram.svg`]: '<svg xmlns="http://www.w3.org/2000/svg"/>',
    // The repository is public, so a file missing from the raw host is missing from the repository.
    'https://github.com/o/r.git/info/refs?service=git-upload-pack': 'refs',
  }
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(url in files ? new Response(files[url]) : new Response('missing', { status: 404 }))))
  let ctx: Awaited<ReturnType<typeof boot>> | undefined
  try {
    const dir = join(home, 'profiles', 'test')
    initProfile(dir, ['test-bundle'])
    const bundle = join(dir, 'node_modules', 'test-bundle')
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    writeFileSync(join(bundle, 'cordis.patch.yml'), readFileSync(new URL('./fixtures/market.patch.yml', import.meta.url)))
    writeFileSync(join(dir, 'cordis.yml'), '- name: cordis:connection\n')
    const profile: ProfileContext = {
      name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
      installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
    }
    ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (root) => {
      root.provide('profileContext', profile)
      Object.assign(root.loader.builtins, {
        editor: ConfigEditor, settings: Settings, manager: StubPluginManager, market: PluginMarket, connection: RecordingConnection,
      })
    })
    const market = ctx.get('pluginMarket')!
    const detail = await market.readEntryDetail('https://first.example/index.json', 'from-git', '1.0.0', 'en-US')
    expect(detail).toMatchObject({ status: 'found', origin: 'locale', markdown: '# Test entry\n\n![diagram](img/diagram.svg)\n' })
    expect(await market.readEntryDetail('https://first.example/index.json', 'from-git', '1.0.0', 'zh-CN')).toMatchObject({ origin: 'locale', markdown: '# 测试条目\n' })
    if (detail.status !== 'found') throw new Error('expected a document')
    const serve = RecordingConnection.routes.get('/api/plugin-market/detail-file')!
    const image = await serve(new Request(`http://dsh.local/api/plugin-market/detail-file?document=${detail.document}&path=img%2Fdiagram.svg`))
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/svg+xml')
    expect(image.headers.get('content-security-policy')).toContain('sandbox')
    expect(await image.text()).toContain('<svg')
    expect((await serve(new Request(`http://dsh.local/api/plugin-market/detail-file?document=${detail.document}&path=..%2F..%2Fpackage.json`))).status).toBe(404)
    await ctx.fiber.dispose()
    ctx = undefined
    expect(RecordingConnection.routes.has('/api/plugin-market/detail-file')).toBe(false)
  } finally {
    vi.unstubAllGlobals()
    try { await ctx?.fiber.dispose() } finally { rmSync(home, { recursive: true, force: true }) }
  }
})
