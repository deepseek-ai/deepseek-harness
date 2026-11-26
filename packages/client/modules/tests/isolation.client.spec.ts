// @vitest-environment jsdom
/** Script isolation: boot-wire validation, per-package Realms, and their lifetimes. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import ScriptRealmRegistry, { type ScriptRealm, type ScriptRealmFactory } from '@deepseek-ai/dsh-client-script-realm/client'
import * as iframeProvider from '@deepseek-ai/dsh-client-script-realm-iframe/client'
import { IFrameScriptRealm } from '../../script-realm-iframe/src/client/iframe.ts'
import { DocumentStyles } from '../../ui-renderer/src/client/styles/document-styles.ts'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { PackageRealms } from '../src/client/isolated-realms.ts'
import { apply, createClientModuleSystem, parseBootManifest } from '../src/client/index.ts'
import type {
  ClientBundleRegistration, ClientModuleLoaderTarget, WebBootEntry, WebBootGraph,
} from '../src/client/index.ts'

const MODULES_ID = '@deepseek-ai/dsh-client-modules'
const REGISTRY_ID = '@deepseek-ai/dsh-client-script-realm'
const IFRAME_ID = '@deepseek-ai/dsh-client-script-realm-iframe'
const BATCH_URL = 'plugins/batch'

type Factory = ClientBundleRegistration['factory']
/** A scripted bundle: the factory it registers when executed in the named environment. */
type Bundle = ((environment: string) => Factory) & Pick<ClientBundleRegistration, 'meta'>

const url = (id: string, rev = '0'): string => `plugins/??${id}/client.js&rev=${rev}`
const chunkUrl = (id: string, fileName: string, rev = '0'): string => `plugins/${id}/${fileName}?rev=${rev}`
const entry = (id: string, extra: Partial<WebBootEntry> = {}): WebBootEntry => ({ id, url: url(id, extra.rev), rev: '0', ...extra })
const PROVIDERS = [entry(REGISTRY_ID), entry(IFRAME_ID)]

/** Graph whose single application batch holds every entry that keeps its scripts in the Main Realm. */
function graph(entries: readonly WebBootEntry[], rev = 'graph'): WebBootGraph {
  const batched = entries.filter(row => row.isolation !== 'script' && row.isolation !== 'scriptandstyle').map(row => row.id)
  return {
    rev, entries: [...entries],
    batches: batched.length === 0 ? [] : [{ phase: 'application', url: BATCH_URL, rev: 'batch', entries: batched }],
  }
}

/** Ids a fixture script registers: a batch registers its members, a one-resource URL its package. */
function scriptIds(scriptUrl: string, entries: readonly WebBootEntry[]): { ids: string[]; chunk?: string } {
  if (scriptUrl === BATCH_URL) return { ids: graph(entries).batches[0]?.entries ?? [] }
  const chunk = /^plugins\/(.+)\/(client\.[^/?]+\.js)\?rev=/.exec(scriptUrl)
  if (chunk !== null) return { ids: [chunk[1]!], chunk: chunk[2]! }
  return { ids: [scriptUrl.split('??')[1]!.split('/client.js')[0]!] }
}

function deliver(
  facade: ClientModuleLoaderTarget, scriptUrl: string, environment: string,
  entries: readonly WebBootEntry[], bundles: Record<string, Bundle>,
): void {
  const { ids, chunk } = scriptIds(scriptUrl, entries)
  for (const id of ids) {
    const bundle = bundles[chunk === undefined ? id : `${id}/${chunk}`]
    if (bundle) facade.load({ id, ...(chunk === undefined ? {} : { chunk }),
      factory: bundle(environment), ...bundle.meta && { meta: bundle.meta } })
  }
}

interface FakeRealm extends ScriptRealm {
  readonly bindings: Record<string, unknown>
  readonly executed: string[]
  disposed: number
}

/** Realm factory recording every created Realm; each Realm executes fixture bundles through its exposed facade. */
function realms(bundles: Record<string, Bundle>, entries: () => readonly WebBootEntry[], behavior: {
  create?: () => Promise<void>
  expose?: () => Promise<void>
  execute?: (scriptUrl: string) => Promise<void>
  dispose?: () => Promise<void>
} = {}) {
  const created: FakeRealm[] = []
  const factory = vi.fn<ScriptRealmFactory['create']>(async ({ id }) => {
    await behavior.create?.()
    const realm: FakeRealm = {
      id, bindings: {}, executed: [], disposed: 0,
      async expose(bindings) {
        await behavior.expose?.()
        Object.assign(realm.bindings, bindings)
      },
      async execute({ url: scriptUrl }) {
        realm.executed.push(scriptUrl)
        await behavior.execute?.(scriptUrl)
        deliver(realm.bindings.__ModuleLoader__ as ClientModuleLoaderTarget, scriptUrl, realm.id, entries(), bundles)
      },
      async dispose() {
        realm.disposed++
        await behavior.dispose?.()
      },
    }
    created.push(realm)
    return realm
  })
  return { factory, created }
}

/** Module system over scripted bundles; the Main Realm records each URL and registers its fixture factories. */
function system(entries: WebBootEntry[], bundles: Record<string, Bundle>, staticModules: ClientBundleRegistration[] = []) {
  const main: string[] = []
  const target: ClientModuleLoaderTarget = {
    mode: 'queue', pendingQueue: [], load: () => {},
    create: options => createClientModuleSystem(target, { id: MODULES_ID, exports: { inject: ['loader'], apply } }, options),
  }
  const modules = target.create({
    boot: graph(entries), staticModules,
    loadBundle: async (scriptUrl) => {
      main.push(scriptUrl)
      await Promise.resolve()
      deliver(target, scriptUrl, 'main', entries, bundles)
    },
  })
  return { modules, main, target }
}

/** Bundle exporting the environment that executed it and the module-table identity of a shared request. */
const reporting = (shared?: string): Bundle => environment => require => ({
  environment, ...(shared === undefined ? {} : { shared: require(shared) }),
})

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

describe('boot wire isolation', () => {
  it('decodes wire modes into independent script and style flags and batches only Main scripts', () => {
    const wire = graph([
      entry('plain'), entry('styled', { isolation: 'style' }),
      entry('scripted', { isolation: 'script' }), entry('both', { isolation: 'scriptandstyle' }),
    ])
    const manifest = parseBootManifest(wire)
    expect(manifest.modules.map(row => [row.id, row.isolation, row.initialUrl])).toEqual([
      ['plain', { script: false, style: false }, BATCH_URL],
      ['styled', { script: false, style: true }, BATCH_URL],
      ['scripted', { script: true, style: false }, url('scripted')],
      ['both', { script: true, style: true }, url('both')],
    ])
  })

  it('treats an explicit null on the wire like an omitted isolation mode', () => {
    const wire = graph([entry('plain')])
    const decoded = parseBootManifest({ ...wire, entries: [{ ...entry('plain'), isolation: null }] })
    expect(decoded).toEqual(parseBootManifest(wire))
  })

  it.each([
    { mode: 'shadow' }, { mode: 'toString' }, { mode: { script: true, style: false } }, { mode: ['script'] },
  ])('rejects invalid wire isolation $mode', ({ mode }) => {
    expect(() => parseBootManifest({ rev: 'g', entries: [{ ...entry('bad'), isolation: mode }], batches: [] }))
      .toThrow(`client-modules: boot manifest entry "bad" isolation must be "script", "style", or "scriptandstyle", received ${JSON.stringify(mode)}`)
  })

  it('rejects a batched isolated row, an unbatched plain row, and stage-one script isolation', () => {
    expect(() => parseBootManifest({
      rev: 'g', entries: [entry('scripted', { isolation: 'script' })],
      batches: [{ phase: 'application', url: BATCH_URL, rev: 'b', entries: ['scripted'] }],
    })).toThrow('boot manifest application batch names script-isolated entry "scripted"')
    expect(() => parseBootManifest({ rev: 'g', entries: [entry('plain')], batches: [] }))
      .toThrow('boot manifest entry "plain" belongs to no initial-load batch')
    expect(() => parseBootManifest(graph([entry('early', { isolation: 'script', immediately: true })])))
      .toThrow('boot manifest entry "early" cannot isolate scripts of a stage-one row')
  })

  it('carries the package flags on entry and chunk records, but never on the bootstrap or shell seeds', async () => {
    const pkg = '@example/client'
    const styled = { isolation: 'style' } as const
    const { modules, target } = system([entry(pkg, styled), entry(MODULES_ID, styled), entry('shell-library', styled)],
      {}, [{ id: 'shell-library', factory: () => ({}) }])
    target.load({ id: pkg, factory: require => ({ open: () => require.async('./client.lazy.js') }) })
    target.load({ id: pkg, chunk: 'client.lazy.js', factory: () => ({}) })
    const plugin = await modules.import(`${pkg}/client`) as { open(): Promise<unknown> }
    await plugin.open()
    await modules.import('shell-library')
    for (const id of [pkg, `${pkg}/client.lazy.js`]) {
      expect(modules.loadCache.get(id)).toMatchObject({ ownerId: pkg, isolation: { script: false, style: true } })
    }
    for (const id of [MODULES_ID, 'shell-library']) expect(modules.loadCache.get(id)?.isolation).toEqual({ script: false, style: false })
  })
})

/** A controllable external provider for acquisition and cancellation races. */
async function controlled(behavior: Parameters<typeof realms>[2] = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(ScriptRealmRegistry)
  const provider = realms({}, () => [], behavior)
  ctx.scriptRealms.register('iframe', { create: provider.factory })
  const isolated = new PackageRealms({ execute: () => Promise.reject(new Error('unexpected Main script')) }, { __ModuleLoader__: {} })
  ctx.effect(() => isolated.installRealmRegistry(ctx.scriptRealms))
  const execute = (url: string) => isolated.execute({ id: 'a', isolation: { script: true, style: false } }, url)
  return { isolated, provider, execute }
}

describe('script-isolated execution', () => {
  it('executes each script-isolated package and its chunks in its own Realm while sharing the module table', async () => {
    const shared = { identity: 'react' }
    const entries = [...PROVIDERS, entry('plain', { isolation: 'style' }),
      entry('a', { isolation: 'script' }), entry('b', { isolation: 'scriptandstyle' })]
    let loadDetails!: () => Promise<unknown>
    const bundles: Record<string, Bundle> = {
      'plain': () => () => ({ environment: 'main', apply() {} }), 'b': environment => require => ({ environment, shared: require('react'), apply() {} }),
      'a': environment => (require) => {
        loadDetails = () => require.async('./client.details.js')
        return { environment, shared: require('react'), apply() {} }
      },
      'a/client.details.js': reporting(),
    }
    const { modules, main, target, provider } = await page(entries, bundles, [{ id: 'react', factory: () => shared }])

    expect(await modules.import('plain')).toMatchObject({ environment: 'main' })
    const a = await modules.import('a') as { environment: string; shared: unknown }
    const b = await modules.import('b/client') as { environment: string; shared: unknown }
    expect(await loadDetails()).toEqual({ environment: a.environment })

    expect(main).toEqual([BATCH_URL])
    expect(provider.created.map(realm => [realm.id, realm.executed])).toEqual([
      ['a', [url('a'), chunkUrl('a', 'client.details.js')]],
      ['b', [url('b')]],
    ])
    expect(a.environment).toBe('a')
    expect(b.environment).toBe('b')
    expect(a.shared).toBe(shared)
    expect(b.shared).toBe(shared)
    for (const realm of provider.created) expect(realm.bindings).toEqual({ __ModuleLoader__: target })
    const [options] = provider.factory.mock.calls[0]!
    expect(options.signal.aborted).toBe(false)
  })

  it('never runs an isolated script in Main before the Loader supplies a registry', async () => {
    const { modules, main } = system([entry('a', { isolation: 'script' })], { a: reporting() })
    await expect(modules.import('a')).rejects.toThrow('Realm registry is not active')
    expect(main).toEqual([])
  })

  it('rejects script isolation of a module the page shell delivers', async () => {
    const { modules } = system([...PROVIDERS, entry('shell', { isolation: 'script' })], {}, [{ id: 'shell', factory: () => ({}) }])
    await expect(modules.import('shell')).rejects.toThrow('"shell" is loaded by the page shell and cannot isolate its scripts')
  })

  it('retries failed creation and exposure, but reuses a ready Realm after a script error', async () => {
    const { isolated, provider, execute } = await controlled({
      create: vi.fn(() => Promise.resolve()).mockRejectedValueOnce(new Error('iframe unavailable')),
      expose: vi.fn(() => Promise.resolve()).mockRejectedValueOnce(new Error('binding rejected')),
      execute: vi.fn(() => Promise.resolve()).mockRejectedValueOnce(new Error('script error')),
    })
    for (const message of ['iframe unavailable', 'binding rejected', 'script error']) {
      await expect(execute(url('a'))).rejects.toThrow(message)
    }
    await execute(url('a'))
    expect(provider.created.map(realm => realm.disposed)).toEqual([1, 0])
    await isolated.dispose()
  })

  it('shares a pending creation between simultaneous scripts of one package', async () => {
    const gate = Promise.withResolvers<undefined>()
    const { isolated, provider, execute } = await controlled({ create: () => gate.promise })
    const both = Promise.all([execute(url('a')), execute(chunkUrl('a', 'client.details.js'))])
    expect(provider.factory).toHaveBeenCalledOnce()
    gate.resolve(undefined)
    await both
    expect(provider.created[0]?.executed).toEqual([url('a'), chunkUrl('a', 'client.details.js')])
    await isolated.dispose()
  })

  it('waits for a cancelled creation to release its late Realm before disposal finishes', async () => {
    const created = Promise.withResolvers<undefined>()
    const disposing = Promise.withResolvers<undefined>()
    const disposed = Promise.withResolvers<undefined>()
    const { isolated, provider, execute } = await controlled({
      create: () => created.promise,
      dispose: () => { disposing.resolve(undefined); return disposed.promise },
    })
    const first = execute(url('a'))
    isolated.evict('a')
    expect(provider.factory.mock.calls[0]![0].signal.aborted).toBe(true)
    let finished = false
    const closing = isolated.dispose().then(() => { finished = true })
    created.resolve(undefined)
    await expect(first).rejects.toThrow('package iframe closed')
    await disposing.promise
    expect(finished).toBe(false)
    disposed.resolve(undefined)
    await closing
    expect(provider.created[0]!.disposed).toBe(1)
    expect(provider.created[0]!.executed).toEqual([])
  })

  it('disposes every Realm and reports a failed disposal without admitting later scripts', async () => {
    const failure = new Error('frame removal failed')
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const entries = ['a', 'b'].map(id => entry(id, { isolation: 'script' }))
    const bundles = { a: mounting([]), b: mounting([]) }
    const { modules } = system([], bundles)
    const provider = realms(bundles, () => entries, { dispose: vi.fn(() => Promise.resolve()).mockRejectedValueOnce(failure) })
    const ctx = new Context()
    await start(modules, ctx)
    await ctx.plugin(ScriptRealmRegistry)
    ctx.scriptRealms.register('iframe', { create: provider.factory })
    await modules.entries.sync(graph(entries))
    await expect(modules.dispose()).rejects.toMatchObject({ errors: [failure] })
    expect(reported).toHaveBeenCalledWith('client-modules: could not dispose isolated Realm a', failure)
    expect(provider.created.map(realm => realm.disposed)).toEqual([1, 1])
    modules.invalidate('a')
    await expect(modules.import('a')).rejects.toThrow('package Realms are disposed')
  })
})

async function start(modules: ReturnType<typeof system>['modules'], ctx = new Context()) {
  contexts.push(ctx)
  await ctx.plugin(Loader)
  ctx.loader.internal = modules as never
  const settling = vi.spyOn(ctx.loader, 'await')
  await modules.entries.start(ctx.loader, modules.manifest)
  return settling
}

/** Page Loader whose Realm registry and `iframe` provider are real entries; the provider creates recorded fake Realms. */
async function page(initial: WebBootEntry[], bundles: Record<string, Bundle>, staticModules: ClientBundleRegistration[] = []) {
  let current = initial
  const provider = realms(bundles, () => current)
  const { modules, main, target } = system(initial, {
    ...bundles,
    [REGISTRY_ID]: () => () => ({ default: ScriptRealmRegistry }),
    [IFRAME_ID]: () => () => ({
      inject: ['scriptRealms'],
      apply(ctx: Context) { ctx.scriptRealms.register('iframe', { create: provider.factory }) },
    }),
  }, staticModules)
  onTestFinished(() => modules.dispose())
  const settling = await start(modules)
  return {
    modules, provider, settling, main, target,
    sync: (entries: WebBootEntry[], rev: string) => {
      current = entries
      return modules.entries.sync(graph(entries, rev))
    },
  }
}

/** Plugin bundle recording each activation and teardown with the environment that executed it. */
const mounting = (mounted: string[], name = ''): Bundle => environment => () => ({
  apply(ctx: Context) {
    ctx.effect(() => {
      mounted.push(`+${name}${environment}`)
      return () => { mounted.push(`-${name}${environment}`) }
    })
  },
})

describe('Realm provider startup order', () => {
  it.each(['script', 'scriptandstyle'] as const)('activates the Realm providers before an earlier %s entry', async (isolation) => {
    const mounted: string[] = []
    const b = await page([entry('a', { isolation }), ...PROVIDERS, entry('plain')], { a: mounting(mounted), plain: mounting(mounted) })
    expect(mounted.sort()).toEqual(['+a', '+main'])
    expect(b.provider.created.map(realm => realm.id)).toEqual(['a'])
    expect(b.modules.importError('a')).toBeUndefined()
    expect(b.settling).toHaveBeenCalledTimes(2)
  })

  it('starts every entry together while no entry is script-isolated', async () => {
    const mounted: string[] = []
    const b = await page([...PROVIDERS, entry('plain')], { plain: mounting(mounted) })
    expect(mounted).toEqual(['+main'])
    expect(b.provider.created).toEqual([])
    expect(b.settling).toHaveBeenCalledTimes(1)
  })

  it('fails a script-isolated entry of a composition without the Realm registry and leaves other entries running', async () => {
    const mounted: string[] = []
    const b = await page([entry('a', { isolation: 'script' }), entry('plain')], { a: mounting(mounted), plain: mounting(mounted) })
    expect(mounted).toEqual(['+main'])
    expect(b.modules.importError('a')?.message)
      .toContain(`: script isolation needs the ${REGISTRY_ID} and ${IFRAME_ID} entries, and the Realm registry is not active (2 attempts)`)
    expect(b.provider.created).toEqual([])
  })

  it.each([
    [IFRAME_ID, 'provider "iframe" is not registered'],
    [REGISTRY_ID, 'Realm registry is not active'],
  ])('rebuilds in the resident iframe after removing %s, but cannot acquire a new one', async (removed, message) => {
    const mounted: string[] = []
    const a = entry('a', { isolation: 'script' })
    const remaining = PROVIDERS.filter(row => row.id !== removed)
    const b = await page([...PROVIDERS, a], { a: mounting(mounted) })
    await b.sync([...remaining, a], 'without-provider')
    await b.modules.entries.reload('a', '1')
    expect(mounted).toEqual(['+a', '-a', '+a'])
    expect(b.provider.created.map(realm => realm.disposed)).toEqual([0])
    await b.sync(remaining, 'removed')
    expect(b.provider.created.map(realm => realm.disposed)).toEqual([1])
    await b.sync([...remaining, a], 'new-installation')
    expect(b.modules.entries.state.getSnapshot().failures.find(failure => failure.id === 'a')?.message).toContain(message)
    expect(mounted).toEqual(['+a', '-a', '+a', '-a'])
    expect(b.main).not.toContain(url('a'))
  })

  it('keeps the replacement registry when an older installation is disposed', async () => {
    const b = await page([], { a: mounting([]) })
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(ScriptRealmRegistry)
    const removePrevious = b.modules.installRealmRegistry(ctx.scriptRealms)
    await b.sync(PROVIDERS, 'providers')
    removePrevious()
    await b.sync([...PROVIDERS, entry('a', { isolation: 'script' })], 'installed')
    expect(b.provider.created.map(realm => realm.executed)).toEqual([[url('a')]])
  })

  it('fails closed for a newly installed isolated package until its ordinary providers are available', async () => {
    const mounted: string[] = []
    const b = await page([], { a: mounting(mounted), plain: mounting(mounted) })
    const rows = [entry('a', { isolation: 'script' }), entry('plain')]
    await b.sync(rows, 'installed')
    const failures = b.modules.entries.state.getSnapshot().failures
    expect(failures.map(failure => failure.id)).toEqual(['a'])
    expect(failures[0]?.message).toContain('Realm registry is not active')
    expect(mounted).toEqual(['+main'])
    expect(b.main).not.toContain(url('a'))
    await b.sync([entry('a'), entry('plain')], 'still-no-provider')
    expect(mounted).toEqual(['+main'])
    expect(b.main).not.toContain(url('a'))
    await b.sync([...PROVIDERS, ...rows], 'providers')
    await b.modules.entries.retry()
    expect(mounted).toEqual(['+main', `+${b.provider.created[0]!.id}`])
    expect(b.modules.entries.state.getSnapshot().failures).toEqual([])
  })
})

it('keeps loaded records unchanged until replacement and gives late chunks the replacement’s flags', async () => {
  const mounted: string[] = []
  const bundles: Record<string, Bundle> = {
    a: environment => require => ({ ...mounting(mounted)(environment)(require), details: () => require.async('./client.details.js') }),
    b: mounting(mounted), 'a/client.details.js': reporting(),
  }
  const b = await page([...PROVIDERS, entry('a'), entry('b', { isolation: 'scriptandstyle' })], bundles)
  const first = b.modules.loadCache.get('a')
  const scripted = b.modules.loadCache.get('b')
  await b.sync([...PROVIDERS, entry('a', { isolation: 'style' }), entry('b', { isolation: 'script' })], 'flipped')
  expect(b.modules.loadCache.get('a')).toBe(first)
  expect(b.modules.loadCache.get('b')).toBe(scripted)
  await b.modules.entries.reload('a', '1')
  expect(b.modules.loadCache.get('a')).not.toBe(first)
  const reloaded = await b.modules.import('a') as { details(): Promise<unknown> }
  await expect(reloaded.details()).resolves.toEqual({ environment: 'main' })
  const chunk = b.modules.loadCache.get('a/client.details.js')!
  expect(chunk.ownerId).toBe('a')
  expect(first?.isolation).toEqual({ script: false, style: false })
  expect(chunk.isolation).toEqual({ script: false, style: true })
  expect(b.modules.loadCache.get('a')?.isolation).toEqual(chunk.isolation)
  expect(scripted?.isolation).toEqual({ script: true, style: true })
})

describe('page-local placement and code replacement', () => {
  it.each([false, true])('loads scripts and styles with the current row (initially isolated: %s)', async (isolated) => {
    const mounted: string[] = []
    const b = await page([...PROVIDERS], { a: mounting(mounted) })
    const rows = (isolate: boolean) => [...PROVIDERS, entry('a', isolate ? { isolation: 'scriptandstyle' } : {})]
    const adding = b.sync(rows(isolated), 'added')
    const flipping = b.sync(rows(!isolated), 'changed')
    await Promise.all([adding, flipping])
    expect(mounted).toEqual([isolated ? '+main' : '+a'])
    expect(b.modules.loadCache.get('a')?.isolation).toEqual({ script: !isolated, style: !isolated })
  })

  it('keeps a factory delivered by a sibling’s Main batch in Main for lazy chunks and rebuilds', async () => {
    const entries = [entry('first'), entry('sibling')]
    const { modules, main } = system(entries, {
      first: mounting([]),
      sibling: environment => require => ({ apply() {}, environment, details: () => require.async('./client.details.js') }),
      'sibling/client.details.js': reporting(),
    })
    onTestFinished(() => modules.dispose())
    await modules.prefetch('first')
    expect(main).toEqual([BATCH_URL])
    expect(modules.loadCache.has('sibling')).toBe(false)
    await start(modules)
    await modules.entries.sync(graph([entry('first'), entry('sibling', { isolation: 'script' })]))
    const sibling = await modules.import('sibling') as { environment: string; details(): Promise<unknown> }
    expect(sibling.environment).toBe('main')
    await expect(sibling.details()).resolves.toEqual({ environment: 'main' })
    await modules.entries.reload('sibling', '1')
    const rebuilt = await modules.import('sibling') as typeof sibling
    expect(rebuilt.environment).toBe('main')
    await expect(rebuilt.details()).resolves.toEqual({ environment: 'main' })
    expect(main).toEqual([BATCH_URL, chunkUrl('sibling', 'client.details.js'), url('sibling', '1'), chunkUrl('sibling', 'client.details.js', '1')])
  })

  it('ignores the mode of an installation withdrawn before any script request', async () => {
    const mounted: string[] = []
    const b = await page([...PROVIDERS], { a: mounting(mounted) })
    const adding = b.sync([...PROVIDERS, entry('a', { isolation: 'script' })], 'added')
    await Promise.all([adding, b.sync(PROVIDERS, 'withdrawn')])
    expect(mounted).toEqual([])
    expect(b.provider.created).toEqual([])
    await b.sync([...PROVIDERS, entry('a')], 'installed')
    expect(mounted).toEqual(['+main'])
  })

  it('keeps the same physical iframe and globals across successful and failed code rebuilds until eviction', async () => {
    const mounted: string[] = []
    let offline = false
    let loadLate!: () => Promise<unknown>
    const entries = [...PROVIDERS, entry('a', { isolation: 'script' }), entry('consumer', { external: ['a'] })]
    const bundles: Record<string, Bundle> = {
      [REGISTRY_ID]: () => () => ({ default: ScriptRealmRegistry }),
      [IFRAME_ID]: () => () => iframeProvider,
      a: (environment) => {
        if (offline) throw new Error('download failed')
        return (require) => {
          loadLate = () => require.async('./client.late.js')
          return mounting(mounted)(environment)(require)
        }
      },
      consumer: () => (require) => { require('a'); return { apply() {} } },
      'a/client.late.js': Object.assign(reporting(), { meta: () => ({ stylesheets: { 'late.css': { text: () => '.late { color: blue }' } } }) }),
    }
    const { modules } = system(entries, bundles)
    // jsdom does not fetch external scripts. The provider still owns the actual iframe, document and Window.
    const windows: Window[] = []
    vi.spyOn(IFrameScriptRealm.prototype, 'execute').mockImplementation(async function (this: IFrameScriptRealm, script) {
      await Promise.resolve()
      windows.push(this.window)
      deliver(Reflect.get(this.window, '__ModuleLoader__') as ClientModuleLoaderTarget, script.url, this.id, entries, bundles)
    })
    onTestFinished(() => modules.dispose())
    await start(modules)
    const frame = document.querySelector<HTMLIFrameElement>('iframe[data-realm]')!
    const resident = frame.contentWindow!
    const marker = {}
    Reflect.set(resident, 'packageState', marker)
    await modules.entries.sync(graph([...PROVIDERS, entry('a'), entry('consumer', { external: ['a'] })]))
    await modules.entries.reload('a', '1')
    expect(mounted).toEqual(['+a', '-a', '+a'])
    expect(document.querySelector('iframe[data-realm]')).toBe(frame)
    expect(frame.contentWindow).toBe(resident)
    expect(Reflect.get(resident, 'packageState')).toBe(marker)
    const active = [...mounted]
    const styles = new DocumentStyles(document.head, modules)
    onTestFinished(() => { styles.dispose() })
    styles.mount()
    const lateStyle = () => document.head.querySelector('style[data-plugin="a"][data-path="late.css"]')
    offline = true
    await expect(modules.entries.reload('a', '2')).rejects.toThrow('download failed')
    await loadLate()
    const late = modules.loadCache.get('a/client.late.js')!
    const style = lateStyle()
    expect(style?.isConnected).toBe(true)
    await expect(modules.entries.reload('a', '3')).rejects.toThrow('download failed')
    expect(mounted).toEqual(active)
    expect([...modules.activeRecords()]).toContain(late)
    expect(lateStyle()).toBe(style)
    expect(document.querySelectorAll('iframe[data-realm]')).toHaveLength(1)
    expect(windows.every(win => win === resident)).toBe(true)
    await modules.entries.sync(graph([...PROVIDERS, entry('consumer')]))
    expect(frame.isConnected).toBe(true) // the running consumer still holds its require('a') exports
    await modules.entries.sync(graph(PROVIDERS))
    expect([...modules.activeRecords()]).not.toContain(late)
    expect(lateStyle()).toBeNull()
    expect(frame.isConnected).toBe(false)
    expect(document.querySelector('iframe[data-realm]')).toBeNull()
    offline = false
    await modules.entries.sync(graph(entries))
    const reinstalled = document.querySelector<HTMLIFrameElement>('iframe[data-realm]')!
    expect(reinstalled).not.toBe(frame)
    expect(Reflect.get(reinstalled.contentWindow!, 'packageState')).toBeUndefined()
  })

  it('does not retry an in-flight dependency import into an orphan iframe after both packages are removed', async () => {
    const mounted: string[] = []
    let importA!: () => Promise<unknown>
    const entries = [...PROVIDERS, entry('a', { isolation: 'script' }), entry('b', { external: ['a'] })]
    const bundles = {
      [REGISTRY_ID]: () => () => ({ default: ScriptRealmRegistry }),
      [IFRAME_ID]: () => () => iframeProvider,
      a: mounting(mounted),
      b: (environment: string): Factory => (require) => {
        importA = () => require.async('a')
        return mounting(mounted)(environment)(require)
      },
    }
    const { modules } = system(entries, bundles)
    onTestFinished(() => modules.dispose())
    const offline = new Error('download failed')
    const attempts = vi.spyOn(IFrameScriptRealm.prototype, 'execute')
      .mockImplementationOnce(function (this: IFrameScriptRealm, script) {
        deliver(Reflect.get(this.window, '__ModuleLoader__') as ClientModuleLoaderTarget, script.url, this.id, entries, bundles)
        return Promise.resolve()
      }).mockRejectedValueOnce(offline).mockRejectedValueOnce(offline)
    await start(modules)
    await expect(modules.entries.reload('a', '1')).rejects.toThrow('download failed')
    const pending = importA().catch((error: unknown) => error)
    // jsdom holds the real script element until the iframe provider cancels it during removal.
    await vi.waitFor(() => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[data-realm="a"]')
      expect(frame?.contentDocument?.querySelector('script')).toBeTruthy()
    })
    attempts.mockRejectedValue(offline)
    await modules.entries.sync(graph(PROVIDERS))
    expect(await pending).toBeInstanceOf(Error)
    expect(attempts.mock.calls.map(([script]) => script.url)).toEqual([url('a'), url('a', '1'), url('a', '1'), url('a', '1')])
    expect(modules.importError('a')).toBeUndefined()
    expect(mounted.sort()).toEqual(['+a', '+main', '-a', '-main'])
    expect([...modules.activeRecords()].filter(record => ['a', 'b'].includes(record.ownerId))).toEqual([])
    expect(document.querySelectorAll('iframe[data-realm]')).toHaveLength(0)
  })
})
