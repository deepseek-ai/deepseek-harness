// @vitest-environment jsdom
/** Script isolation: boot-wire validation, per-package Realms, and their lifetimes. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import ScriptRealmRegistry, { type ScriptRealm } from '@deepseek-ai/dsh-client-script-realm/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, createClientModuleSystem, parseBootManifest } from '../src/client/index.ts'
import type {
  ClientBundleRegistration, ClientModuleLoaderTarget, IsolatedRealmFactory, WebBootEntry, WebBootGraph,
} from '../src/client/index.ts'

const MODULES_ID = '@deepseek-ai/dsh-client-modules'
const REGISTRY_ID = '@deepseek-ai/dsh-client-script-realm'
const IFRAME_ID = '@deepseek-ai/dsh-client-script-realm-iframe'
const BATCH_URL = 'plugins/batch'

type Factory = ClientBundleRegistration['factory']
/** A scripted bundle: the factory it registers when executed in the named environment. */
type Bundle = (environment: string) => Factory

const url = (id: string, rev = '0'): string => `plugins/??${id}/client.js&rev=${rev}`
const chunkUrl = (id: string, fileName: string, rev = '0'): string => `plugins/${id}/${fileName}?rev=${rev}`
const entry = (id: string, extra: Partial<WebBootEntry> = {}): WebBootEntry => ({ id, url: url(id, extra.rev), rev: '0', ...extra })
const PROVIDERS = [entry(REGISTRY_ID), entry(IFRAME_ID)]

/** Graph whose single application batch holds every entry that keeps its scripts in the Main Realm. */
function graph(entries: readonly WebBootEntry[], rev = 'graph'): WebBootGraph {
  const batched = entries.filter(row => row.isolation !== 'script').map(row => row.id)
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
  const factory = vi.fn<IsolatedRealmFactory>(async ({ id }) => {
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
        const facade = realm.bindings.__ModuleLoader__ as ClientModuleLoaderTarget
        const { ids, chunk } = scriptIds(scriptUrl, entries())
        for (const owner of ids) {
          const bundle = bundles[chunk === undefined ? owner : `${owner}/${chunk}`]
          if (bundle !== undefined) facade.load({ id: owner, ...(chunk === undefined ? {} : { chunk }), factory: bundle(realm.id) })
        }
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
      const { ids, chunk } = scriptIds(scriptUrl, entries)
      for (const id of ids) {
        const bundle = bundles[chunk === undefined ? id : `${id}/${chunk}`]
        if (bundle !== undefined) target.load({ id, ...(chunk === undefined ? {} : { chunk }), factory: bundle('main') })
      }
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
  it('carries isolation onto module rows and loads script-isolated rows outside every batch', () => {
    const manifest = parseBootManifest(graph([
      entry('plain'), entry('scripted', { isolation: 'script' }),
    ]))
    expect(manifest.modules.map(row => [row.id, row.isolation, row.initialUrl])).toEqual([
      ['plain', undefined, BATCH_URL],
      ['scripted', 'script', url('scripted')],
    ])
    expect(manifest.modules[0]).not.toHaveProperty('isolation')
  })

  it.each(['style', 'scriptandstyle', 'shadow'])('rejects unsupported isolation mode %s on the wire', (mode) => {
    expect(() => parseBootManifest({ rev: 'g', entries: [{ ...entry('bad'), isolation: mode }], batches: [] }))
      .toThrow(`client-modules: boot manifest entry "bad" isolation must be "script", received "${mode}"`)
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

  it('answers the isolation of a package or its /client specifier from the current graph', () => {
    const { modules } = system([entry('plain'), entry('scripted', { isolation: 'script' })], {})
    expect(modules.isolationOf('scripted/client')).toBe('script')
    expect(modules.isolationOf('plain')).toBeUndefined()
    expect(modules.isolationOf('unknown')).toBeUndefined()
  })
})

describe('script-isolated execution', () => {
  it('executes each script-isolated package and its chunks in its own Realm while sharing the module table', async () => {
    const shared = { identity: 'react' }
    const entries = [...PROVIDERS, entry('plain'),
      entry('a', { isolation: 'script' }), entry('b', { isolation: 'script' })]
    let loadDetails!: () => Promise<unknown>
    const bundles: Record<string, Bundle> = {
      'plain': reporting(), 'b': reporting('react'),
      'a': environment => (require) => {
        loadDetails = () => require.async('./client.details.js')
        return { environment, shared: require('react') }
      },
      'a/client.details.js': reporting(),
    }
    const { modules, main, target } = system(entries, bundles, [{ id: 'react', factory: () => shared }])
    const provider = realms(bundles, () => entries)
    modules.useIsolatedRealms(provider.factory)

    expect(await modules.import('plain')).toEqual({ environment: 'main' })
    const a = await modules.import('a') as { environment: string; shared: unknown }
    const b = await modules.import('b/client') as { environment: string; shared: unknown }
    expect(await loadDetails()).toEqual({ environment: a.environment })

    expect(main).toEqual([BATCH_URL])
    expect(provider.created.map(realm => [realm.id, realm.executed])).toEqual([
      ['a#1', [url('a'), chunkUrl('a', 'client.details.js')]],
      ['b#2', [url('b')]],
    ])
    expect(a.environment).toBe('a#1')
    expect(b.environment).toBe('b#2')
    expect(a.shared).toBe(shared)
    expect(b.shared).toBe(shared)
    for (const realm of provider.created) expect(realm.bindings).toEqual({ __ModuleLoader__: target })
    const [options] = provider.factory.mock.calls[0]!
    expect(options.signal.aborted).toBe(false)
  })

  it('fails a script-isolated load while no Realm provider is installed, and loads once one is', async () => {
    const entries = [...PROVIDERS, entry('a', { isolation: 'script' })]
    const bundles = { a: reporting() }
    const { modules } = system(entries, bundles)
    await expect(modules.import('a')).rejects.toThrow('"a" isolates its scripts, but no Script Realm provider is installed')
    const provider = realms(bundles, () => entries)
    modules.useIsolatedRealms(provider.factory)
    const loaded = await modules.import('a')
    expect(provider.factory).toHaveBeenCalledOnce()
    expect(loaded).toEqual({ environment: provider.created[0]!.id })
  })

  it('rejects script isolation of a module the page shell delivers', async () => {
    const { modules } = system([...PROVIDERS, entry('shell', { isolation: 'script' })], {}, [{ id: 'shell', factory: () => ({}) }])
    await expect(modules.import('shell')).rejects.toThrow('"shell" is loaded by the page shell and cannot isolate its scripts')
  })

  it('starts a new Realm after creation or exposure fails, and disposes the partially created one', async () => {
    const entries = [...PROVIDERS, entry('a', { isolation: 'script' })]
    const bundles = { a: reporting() }
    const { modules } = system(entries, bundles)
    const failures = [new Error('iframe unavailable')]
    const exposures = [new Error('binding rejected')]
    const provider = realms(bundles, () => entries, {
      create: async () => { const failure = failures.shift(); if (failure) throw failure },
      expose: async () => { const failure = exposures.shift(); if (failure) throw failure },
    })
    modules.useIsolatedRealms(provider.factory)
    await expect(modules.import('a')).rejects.toThrow(`${url('a')}: iframe unavailable; ${url('a')}: binding rejected`)
    await expect(modules.import('a')).resolves.toEqual({ environment: 'a#3' })
    expect(provider.created.map(realm => [realm.id, realm.disposed])).toEqual([['a#2', 1], ['a#3', 0]])
    expect(modules.importError('a')).toBeUndefined()
  })

  it('keeps the Realm after a script failure and retries the script in it', async () => {
    const entries = [...PROVIDERS, entry('a', { isolation: 'script' })]
    const bundles = { a: reporting() }
    const { modules } = system(entries, bundles)
    let failures = 2
    const provider = realms(bundles, () => entries, {
      execute: async () => { if (failures-- > 0) throw new Error('script error event') },
    })
    modules.useIsolatedRealms(provider.factory)
    await expect(modules.import('a')).rejects.toThrow(`${url('a')}: script error event; ${url('a')}: script error event`)
    await expect(modules.import('a')).resolves.toEqual({ environment: 'a#1' })
    expect(provider.created).toHaveLength(1)
  })

  it('disposes a package Realm on invalidation and executes the next generation in a new one', async () => {
    const entries = [...PROVIDERS, entry('a', { isolation: 'script' })]
    const bundles = { a: reporting() }
    const { modules } = system(entries, bundles)
    const provider = realms(bundles, () => entries)
    modules.useIsolatedRealms(provider.factory)
    await modules.import('a')
    modules.invalidate('a', '1')
    expect(provider.created[0]!.disposed).toBe(1)
    await expect(modules.import('a')).resolves.toEqual({ environment: 'a#2' })
    expect(provider.created[1]!.executed).toEqual([url('a', '1')])
  })

  it('cancels a Realm whose creation is still pending when its package is invalidated', async () => {
    const entries = [...PROVIDERS, entry('a', { isolation: 'script' })]
    const bundles = { a: reporting() }
    const { modules } = system(entries, bundles)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let creations = 0
    const provider = realms(bundles, () => entries, { create: () => creations++ === 0 ? gate : Promise.resolve() })
    modules.useIsolatedRealms(provider.factory)
    const importing = modules.import('a')
    await vi.waitFor(() => { expect(provider.factory).toHaveBeenCalledOnce() })
    modules.invalidate('a')
    expect(provider.factory.mock.calls[0]![0].signal.aborted).toBe(true)
    release()
    await expect(importing).resolves.toEqual({ environment: 'a#2' })
    expect(provider.created.map(realm => [realm.id, realm.disposed])).toEqual([['a#1', 1], ['a#2', 0]])
  })

  it('waits for a cancelled creation to release its Realm before system disposal finishes', async () => {
    const entries = [...PROVIDERS, entry('a', { isolation: 'script' })]
    const { modules } = system(entries, {})
    const creating = Promise.withResolvers<undefined>()
    const created = Promise.withResolvers<undefined>()
    const disposing = Promise.withResolvers<undefined>()
    const disposed = Promise.withResolvers<undefined>()
    const provider = realms({}, () => entries, {
      create: () => { creating.resolve(undefined); return created.promise },
      dispose: () => { disposing.resolve(undefined); return disposed.promise },
    })
    modules.useIsolatedRealms(provider.factory)
    const importing = modules.import('a')
    await creating.promise
    modules.invalidate('a')
    let finished = false
    const closing = modules.dispose().then(() => { finished = true })
    created.resolve(undefined)
    await disposing.promise
    await expect(importing).rejects.toThrow('isolated Realms are disposed')
    expect(finished).toBe(false)
    disposed.resolve(undefined)
    await closing
    expect(provider.created[0]!.disposed).toBe(1)
  })

  it('disposes every Realm with the module system, rejects later scripts, and reports disposal failures', async () => {
    const entries = [...PROVIDERS, entry('a', { isolation: 'script' }), entry('b', { isolation: 'script' }), entry('c', { isolation: 'script' })]
    const bundles = { a: reporting(), b: reporting(), c: reporting() }
    const { modules } = system(entries, bundles)
    const failure = new Error('frame removal failed')
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    let disposals = 0
    const provider = realms(bundles, () => entries, { dispose: async () => { if (disposals++ === 0) throw failure } })
    modules.useIsolatedRealms(provider.factory)
    await modules.import('a')
    await modules.import('b')
    const waiting = modules.import('c').catch((error: unknown) => error)
    await expect(modules.dispose()).rejects.toMatchObject({ errors: [failure] })
    expect(reported).toHaveBeenCalledWith('client-modules: could not dispose isolated Realm a#1', failure)
    expect(provider.created.map(realm => realm.disposed)).toEqual([1, 1, 1])
    expect(String(await waiting)).toContain('isolated Realm')
    modules.invalidate('a')
    await expect(modules.import('a')).rejects.toThrow('isolated Realms are disposed')
  })
})

/** Page Loader whose Realm registry and `iframe` provider are real entries; the provider creates recorded fake Realms. */
async function page(initial: WebBootEntry[], bundles: Record<string, Bundle>) {
  let current = initial
  const provider = realms(bundles, () => current)
  const { modules } = system(initial, {
    ...bundles,
    [REGISTRY_ID]: () => () => ({ default: ScriptRealmRegistry }),
    [IFRAME_ID]: () => () => ({
      inject: ['scriptRealms'],
      apply(ctx: Context) { ctx.scriptRealms.register('iframe', { create: provider.factory }) },
    }),
  })
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  ctx.loader.internal = modules as never
  const settling = vi.spyOn(ctx.loader, 'await')
  await modules.entries.start(ctx.loader, modules.manifest)
  return {
    modules, provider, settling,
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
  it('activates the Realm provider entries before it creates a script-isolated entry listed ahead of them', async () => {
    const mounted: string[] = []
    const b = await page([entry('a', { isolation: 'script' }), ...PROVIDERS, entry('plain')], { a: mounting(mounted), plain: mounting(mounted) })
    expect(mounted.sort()).toEqual(['+a#1', '+main'])
    expect(b.provider.created.map(realm => realm.id)).toEqual(['a#1'])
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
      .toContain(`client-modules: script isolation needs the ${REGISTRY_ID} and ${IFRAME_ID} entries, and the Realm registry is not active`)
    expect(b.provider.created).toEqual([])
  })

  it('applies the same order when a later graph adds the providers together with script-isolated entries', async () => {
    const mounted: string[] = []
    const bundles = { consumer: mounting(mounted, 'consumer:'), a: mounting(mounted, 'a:'), c: mounting(mounted, 'c:'), plain: mounting(mounted, 'plain:') }
    const b = await page([entry('plain')], bundles)
    await b.sync([entry('consumer', { inject: ['a'] }), entry('a', { isolation: 'script' }), entry('plain'), entry('c', { isolation: 'script' }), ...PROVIDERS], 'isolated')
    expect(mounted).toEqual(['+plain:main', '+consumer:main', '+a:a#1', '+c:c#2'])
    expect(b.modules.entries.state.getSnapshot().failures).toEqual([])
  })
})

describe('HMR replacement of a script-isolated entry', () => {
  it.each([false, true])('discards an unmounted factory after its requested Realm changes (initial isolation: %s)', async (isolated) => {
    const mounted: string[] = []
    const b = await page([...PROVIDERS], { a: environment => (require) => {
      if ((environment !== 'main') === isolated) throw new Error('first materialization failed')
      return mounting(mounted)(environment)(require)
    } })
    const rows = (script: boolean) => [...PROVIDERS, entry('a', script ? { isolation: 'script' } : {})]
    await b.sync(rows(isolated), 'initial')
    expect(b.modules.entries.state.getSnapshot().failures).toEqual([{ id: 'a', message: 'Error: first materialization failed' }])
    await b.sync(rows(!isolated), 'flip')
    expect(b.modules.entries.state.getSnapshot().failures).toEqual([])
    expect(mounted).toEqual([isolated ? '+main' : '+a#1'])
    expect(b.provider.created.map(realm => realm.disposed)).toEqual([isolated ? 1 : 0])
  })

  it('remounts the package in a new Realm when only its isolation changes and disposes the old Realm after teardown', async () => {
    const mounted: string[] = []
    const providers = PROVIDERS
    const b = await page([...providers, entry('a')], { a: mounting(mounted) })
    expect(mounted).toEqual(['+main'])

    await b.sync([...providers, entry('a', { isolation: 'script' })], 'isolated')
    expect(mounted).toEqual(['+main', '-main', '+a#1'])
    expect(b.modules.entries.state.getSnapshot().failures).toEqual([])

    const disposedBeforeTeardown: number[] = []
    const realm = b.provider.created[0]!
    const teardown = realm.dispose.bind(realm)
    realm.dispose = async () => {
      disposedBeforeTeardown.push(mounted.filter(step => step === '-a#1').length)
      await teardown()
    }
    await b.sync([...providers, entry('a', { isolation: 'script', rev: '1' })], 'rebuilt')
    expect(mounted).toEqual(['+main', '-main', '+a#1', '-a#1', '+a#2'])
    expect(disposedBeforeTeardown).toEqual([1])

    await b.sync([...providers, entry('a', { rev: '1' })], 'restored')
    expect(mounted).toEqual(['+main', '-main', '+a#1', '-a#1', '+a#2', '-a#2', '+main'])
    expect(b.provider.created.map(item => item.disposed)).toEqual([1, 1])
  })

  it('disposes a Realm retained for a runtime under replacement when the system is disposed', async () => {
    const gates: (() => void)[] = []
    let blockTeardown = true
    const blocking: Bundle = environment => () => ({
      apply(ctx: Context) {
        ctx.effect(() => () => blockTeardown ? new Promise<void>((resolve) => { gates.push(resolve) }) : undefined, environment)
      },
    })
    const b = await page([...PROVIDERS, entry('a', { isolation: 'script' })], { a: blocking })
    const replacing = b.sync([...PROVIDERS, entry('a', { isolation: 'script', rev: '1' })], 'one')
    await vi.waitFor(() => { expect(gates).toHaveLength(1) })
    expect(b.provider.created.map(realm => realm.disposed)).toEqual([0, 0])
    await b.modules.dispose()
    expect(b.provider.created.map(realm => realm.disposed)).toEqual([1, 1])
    blockTeardown = false
    gates.shift()!()
    await replacing
  })
})
