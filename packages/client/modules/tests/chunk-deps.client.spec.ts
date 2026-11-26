/**
 * Package-local chunk dependencies: a registration's `deps` must arrive before its factory runs, a
 * `require.async` hint only widens the parallel download, and a synchronous chunk request resolves registered
 * chunks only.
 */
import { describe, expect, it } from 'vitest'
import {
  createClientModuleSystem,
  type ClientBundleRegistration, type ClientModuleLoader, type ClientModuleLoaderTarget,
} from '../src/client/index.ts'

const OWNER = 'pkg'
const BATCH_URL = `plugins/??${OWNER}/client.js&rev=app`
const entryUrl = (rev = '0'): string => `plugins/??${OWNER}/client.js&rev=${rev}`
const chunkUrl = (fileName: string, rev = '0'): string => `plugins/${OWNER}/${fileName}?rev=${rev}`

/** One registration a fixture script performs for {@link OWNER}. */
type Registration = Omit<ClientBundleRegistration, 'id'>

/** Exports of an entry whose `load` requests a package-local chunk. */
interface LoaderEntry {
  load(spec: string, options?: { deps?: readonly string[] }): Promise<unknown>
}

interface Bench {
  system: ClientModuleLoader
  target: ClientModuleLoaderTarget
  fetched: string[]
  /** Release callback of each gated URL, set once its download starts. */
  gates: Map<string, () => void>
}

/**
 * Module system over scripted URLs: each script registers its listed factories for {@link OWNER}. A gated URL
 * waits for its release callback; a failing URL rejects like a `<script>` error event.
 */
function bench(
  scripts: Readonly<Record<string, readonly Registration[]>>,
  options: {
    pending?: readonly Registration[]
    seed?: readonly ClientBundleRegistration[]
    gated?: readonly string[]
    failing?: readonly string[]
    /** URLs whose script keeps loading after a registration throws, as a browser still fires `load` after a script error. */
    loadsAfterError?: readonly string[]
  } = {},
): Bench {
  const fetched: string[] = []
  const gates = new Map<string, () => void>()
  const target: ClientModuleLoaderTarget = {
    mode: 'queue',
    pendingQueue: (options.pending ?? []).map(registration => ({ id: OWNER, ...registration })),
    load(registration) { target.pendingQueue.push(registration) },
    create() { throw new Error('the bench creates its module system directly') },
  }
  const system = createClientModuleSystem(target, { id: '@deepseek-ai/dsh-client-modules', exports: {} }, {
    boot: {
      rev: 'graph',
      entries: [{ id: OWNER, url: entryUrl(), rev: '0' }],
      batches: [{ phase: 'application', url: BATCH_URL, rev: 'app', entries: [OWNER] }],
    },
    staticModules: options.seed ?? [],
    loadBundle: async (url) => {
      fetched.push(url)
      if (options.gated?.includes(url) === true) await new Promise<void>((resolve) => { gates.set(url, resolve) })
      if (options.failing?.includes(url) === true) throw new Error(`bundle script ${url} failed to load`)
      try {
        for (const registration of scripts[url] ?? []) target.load({ id: OWNER, ...registration })
      } catch (error) {
        if (options.loadsAfterError?.includes(url) !== true) throw error
      }
    },
  })
  return { system, target, fetched, gates }
}

/** Entry registration whose `load` forwards to `require.async`. */
const loaderEntry = (deps?: readonly string[]): Registration => ({
  ...(deps === undefined ? {} : { deps }),
  factory: require => ({ load: (spec: string, options?: { deps?: readonly string[] }) => require.async(spec, options) }),
})

/** Chunk registration whose exports list the exports of the chunks it requires synchronously. */
const chunk = (fileName: string, deps: readonly string[] = []): Registration => ({
  chunk: fileName,
  ...(deps.length === 0 ? {} : { deps }),
  factory: require => ({ name: fileName, deps: deps.map(dependency => require(dependency)) }),
})

describe('chunk registration dependencies', () => {
  it('runs a chunk only after the chunks its registration requires arrive, level by level without a hint', async () => {
    const b = bench({
      [BATCH_URL]: [loaderEntry()],
      [chunkUrl('client.view.js')]: [chunk('client.view.js', ['./client.shared.js'])],
      [chunkUrl('client.shared.js')]: [chunk('client.shared.js', ['./client.base.js'])],
      [chunkUrl('client.base.js')]: [chunk('client.base.js')],
    })
    const entry = await b.system.import(OWNER, '', {}) as LoaderEntry
    await expect(entry.load('./client.view.js')).resolves.toEqual({
      name: 'client.view.js',
      deps: [{ name: 'client.shared.js', deps: [{ name: 'client.base.js', deps: [] }] }],
    })
    expect(b.fetched).toEqual([
      BATCH_URL, chunkUrl('client.view.js'), chunkUrl('client.shared.js'), chunkUrl('client.base.js'),
    ])
    expect(b.system.loadCache.get(OWNER)?.edges).toEqual(new Set(['./client.view.js']))
    expect(b.system.loadCache.get(`${OWNER}/client.view.js`)?.edges).toEqual(new Set(['./client.shared.js']))
  })

  it('starts every hinted download before any of them registers', async () => {
    const files = ['client.view.js', 'client.shared.js', 'client.base.js']
    const b = bench({
      [BATCH_URL]: [loaderEntry()],
      [chunkUrl('client.view.js')]: [chunk('client.view.js', ['./client.shared.js'])],
      [chunkUrl('client.shared.js')]: [chunk('client.shared.js', ['./client.base.js'])],
      [chunkUrl('client.base.js')]: [chunk('client.base.js')],
    }, { gated: files.map(file => chunkUrl(file)) })
    const entry = await b.system.import(OWNER, '', {}) as LoaderEntry
    const loaded = entry.load('./client.view.js', { deps: ['./client.shared.js', './client.base.js'] })
    expect(b.fetched).toEqual([BATCH_URL, ...files.map(file => chunkUrl(file))])
    for (const release of b.gates.values()) release()
    await expect(loaded).resolves.toMatchObject({ name: 'client.view.js' })
    expect(b.fetched).toHaveLength(4)
  })

  it('registers the chunks of an entry script before materializing the entry, without another download', async () => {
    const b = bench({
      [BATCH_URL]: [chunk('client.runtime.js'), {
        deps: ['./client.runtime.js'],
        factory: require => ({ runtime: require('./client.runtime.js') }),
      }],
    })
    await expect(b.system.import(OWNER, '', {})).resolves.toEqual({ runtime: { name: 'client.runtime.js', deps: [] } })
    expect(b.fetched).toEqual([BATCH_URL])
  })

  it('completes the dependencies of an entry registered before its own download', async () => {
    const b = bench({ [chunkUrl('client.shared.js')]: [chunk('client.shared.js')] }, {
      pending: [{ deps: ['./client.shared.js'], factory: require => ({ shared: require('./client.shared.js') }) }],
    })
    await expect(b.system.import(OWNER, '', {})).resolves.toEqual({ shared: { name: 'client.shared.js', deps: [] } })
    expect(b.fetched).toEqual([chunkUrl('client.shared.js')])
  })

  it('materializes a dependency shared by two chunks once and never downloads a materialized chunk again', async () => {
    const b = bench({
      [BATCH_URL]: [loaderEntry()],
      [chunkUrl('client.view.js')]: [chunk('client.view.js', ['./client.left.js', './client.right.js'])],
      [chunkUrl('client.left.js')]: [chunk('client.left.js', ['./client.base.js'])],
      [chunkUrl('client.right.js')]: [chunk('client.right.js', ['./client.base.js'])],
      [chunkUrl('client.base.js')]: [chunk('client.base.js')],
      [chunkUrl('client.other.js')]: [chunk('client.other.js', ['./client.base.js'])],
    })
    const entry = await b.system.import(OWNER, '', {}) as LoaderEntry
    const view = await entry.load('./client.view.js') as { deps: { deps: unknown[] }[] }
    expect(view.deps[0]?.deps[0]).toBe(view.deps[1]?.deps[0])
    const other = await entry.load('./client.other.js', { deps: ['./client.base.js'] }) as { deps: unknown[] }
    expect(other.deps[0]).toBe(view.deps[0]?.deps[0])
    expect(b.fetched.filter(url => url === chunkUrl('client.base.js'))).toHaveLength(1)
    expect(b.fetched.at(-1)).toBe(chunkUrl('client.other.js'))
  })

  it('requests a shared or cyclic dependency once and rejects the cycle when the factories run', async () => {
    const b = bench({
      [BATCH_URL]: [loaderEntry()],
      [chunkUrl('client.view.js')]: [chunk('client.view.js', ['./client.left.js', './client.right.js'])],
      [chunkUrl('client.left.js')]: [chunk('client.left.js', ['./client.right.js'])],
      [chunkUrl('client.right.js')]: [chunk('client.right.js', ['./client.left.js'])],
    })
    const entry = await b.system.import(OWNER, '', {}) as LoaderEntry
    await expect(entry.load('./client.view.js')).rejects.toThrow(`require cycle through "${OWNER}/client.left.js"`)
    expect(b.fetched).toEqual([
      BATCH_URL, chunkUrl('client.view.js'), chunkUrl('client.left.js'), chunkUrl('client.right.js'),
    ])
  })

  it('names the dependency chain when a required chunk fails to download', async () => {
    const b = bench({
      [BATCH_URL]: [loaderEntry()],
      [chunkUrl('client.view.js')]: [chunk('client.view.js', ['./client.shared.js'])],
      [chunkUrl('client.shared.js')]: [chunk('client.shared.js', ['./client.base.js'])],
    }, { failing: [chunkUrl('client.base.js')] })
    const entry = await b.system.import(OWNER, '', {}) as LoaderEntry
    const failure = await entry.load('./client.view.js').then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe(
      `client-modules: "${OWNER}/client.view.js" not loaded because dependency "${OWNER}/client.shared.js" failed: `
      + `client-modules: "${OWNER}/client.shared.js" not loaded because dependency "${OWNER}/client.base.js" failed: `
      + `bundle script ${chunkUrl('client.base.js')} failed to load`,
    )
    expect(((failure as Error).cause as Error).message).toContain(`"${OWNER}/client.shared.js" not loaded`)
    expect(b.system.loadCache.has(`${OWNER}/client.view.js`)).toBe(false)
  })

  it('names the dependency chain when a hinted chunk fails to download', async () => {
    const b = bench({
      [BATCH_URL]: [loaderEntry()],
      [chunkUrl('client.view.js')]: [chunk('client.view.js', ['./client.shared.js'])],
      [chunkUrl('client.shared.js')]: [chunk('client.shared.js', ['./client.base.js'])],
    }, { failing: [chunkUrl('client.base.js')] })
    const entry = await b.system.import(OWNER, '', {}) as LoaderEntry
    const failure = await entry.load('./client.view.js', { deps: ['./client.shared.js', './client.base.js'] })
      .then(() => undefined, (error: unknown) => error)
    expect((failure as Error).message).toMatch(new RegExp(
      `^client-modules: "${OWNER}/client\\.view\\.js" not loaded because dependency "${OWNER}/client\\.shared\\.js" failed: `
      + `client-modules: "${OWNER}/client\\.shared\\.js" not loaded because dependency "${OWNER}/client\\.base\\.js" failed: `,
    ))
    expect(((failure as Error).cause as Error).message).toContain(`"${OWNER}/client.shared.js" not loaded`)
  })

  it('loads a chunk whose hint names a chunk that fails to download but no registration requires', async () => {
    const b = bench({
      [BATCH_URL]: [loaderEntry()],
      [chunkUrl('client.view.js')]: [chunk('client.view.js')],
    }, { failing: [chunkUrl('client.extra.js')] })
    const entry = await b.system.import(OWNER, '', {}) as LoaderEntry
    await expect(entry.load('./client.view.js', { deps: ['./client.extra.js'] })).resolves.toEqual({ name: 'client.view.js', deps: [] })
    expect(b.fetched).toEqual([BATCH_URL, chunkUrl('client.view.js'), chunkUrl('client.extra.js')])
  })

  it('restarts a chunk arrival under the new revision when its owner is invalidated mid-download', async () => {
    const stale = chunkUrl('client.shared.js')
    const b = bench({
      [BATCH_URL]: [loaderEntry()],
      [chunkUrl('client.view.js')]: [chunk('client.view.js', ['./client.shared.js'])],
      [stale]: [chunk('client.shared.js')],
      [chunkUrl('client.view.js', 'next')]: [chunk('client.view.js', ['./client.shared.js'])],
      [chunkUrl('client.shared.js', 'next')]: [{ chunk: 'client.shared.js', factory: () => ({ name: 'next' }) }],
    }, { gated: [stale] })
    const entry = await b.system.import(OWNER, '', {}) as LoaderEntry
    const loaded = entry.load('./client.view.js')
    await expect.poll(() => b.gates.has(stale)).toBe(true)
    b.system.invalidate(OWNER, 'next')
    b.gates.get(stale)?.()
    await expect(loaded).resolves.toEqual({ name: 'client.view.js', deps: [{ name: 'next' }] })
    expect(b.fetched.slice(-2)).toEqual([chunkUrl('client.view.js', 'next'), chunkUrl('client.shared.js', 'next')])
  })

  it('restarts an entry arrival from the entry script when its owner is invalidated while its chunks download', async () => {
    const stale = chunkUrl('client.shared.js')
    const entry: Registration = { deps: ['./client.shared.js'], factory: require => ({ shared: require('./client.shared.js') }) }
    const b = bench({
      [stale]: [chunk('client.shared.js')],
      [entryUrl('next')]: [entry],
      [chunkUrl('client.shared.js', 'next')]: [{ chunk: 'client.shared.js', factory: () => ({ name: 'next' }) }],
    }, { pending: [entry], gated: [stale] })
    const imported = b.system.import(OWNER, '', {})
    await expect.poll(() => b.gates.has(stale)).toBe(true)
    b.system.invalidate(OWNER, 'next')
    b.gates.get(stale)?.()
    await expect(imported).resolves.toEqual({ shared: { name: 'next' } })
    expect(b.fetched).toEqual([stale, entryUrl('next'), chunkUrl('client.shared.js', 'next')])
  })

  it('retries an invalidated hinted request only after its hinted downloads end', async () => {
    const [view, shared] = [chunkUrl('client.view.js'), chunkUrl('client.shared.js')]
    const b = bench({
      [BATCH_URL]: [loaderEntry()],
      [view]: [chunk('client.view.js', ['./client.shared.js'])],
      [shared]: [chunk('client.shared.js')],
      [chunkUrl('client.view.js', 'next')]: [chunk('client.view.js', ['./client.shared.js'])],
      [chunkUrl('client.shared.js', 'next')]: [{ chunk: 'client.shared.js', factory: () => ({ name: 'next' }) }],
    }, { gated: [view, shared], loadsAfterError: [shared] })
    const entry = await b.system.import(OWNER, '', {}) as LoaderEntry
    const loaded = entry.load('./client.view.js', { deps: ['./client.shared.js'] })
    await expect.poll(() => b.gates.has(view) && b.gates.has(shared)).toBe(true)
    b.system.invalidate(OWNER, 'next')
    b.gates.get(view)?.()
    // Bench transports settle through promise jobs only, so one macrotask lets a retry that does not wait run to its end.
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(b.fetched).not.toContain(chunkUrl('client.view.js', 'next'))
    b.gates.get(shared)?.()
    await expect(loaded).resolves.toEqual({ name: 'client.view.js', deps: [{ name: 'next' }] })
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(b.system.loadCache.get(`${OWNER}/client.shared.js`)?.exports).toEqual({ name: 'next' })
    expect(b.fetched.slice(-2)).toEqual([chunkUrl('client.view.js', 'next'), chunkUrl('client.shared.js', 'next')])
  })

  it('retries an invalidated request only after every sibling of a failed dependency ends', async () => {
    const [view, bad, shared] = [chunkUrl('client.view.js'), chunkUrl('client.bad.js'), chunkUrl('client.shared.js')]
    const b = bench({
      [BATCH_URL]: [loaderEntry()],
      [view]: [chunk('client.view.js', ['./client.hint.js'])],
      [chunkUrl('client.hint.js')]: [chunk('client.hint.js', ['./client.bad.js', './client.shared.js'])],
      [shared]: [chunk('client.shared.js')],
      [chunkUrl('client.view.js', 'next')]: [chunk('client.view.js', ['./client.hint.js'])],
      [chunkUrl('client.hint.js', 'next')]: [chunk('client.hint.js', ['./client.bad.js', './client.shared.js'])],
      [chunkUrl('client.bad.js', 'next')]: [chunk('client.bad.js')],
      [chunkUrl('client.shared.js', 'next')]: [{ chunk: 'client.shared.js', factory: () => ({ name: 'next' }) }],
    }, { gated: [view, bad, shared], failing: [bad], loadsAfterError: [shared] })
    const entry = await b.system.import(OWNER, '', {}) as LoaderEntry
    const loaded = entry.load('./client.view.js', { deps: ['./client.hint.js'] }) as Promise<{ deps: [{ deps: unknown[] }] }>
    await expect.poll(() => [view, bad, shared].every(url => b.gates.has(url))).toBe(true)
    b.system.invalidate(OWNER, 'next')
    b.gates.get(view)?.()
    b.gates.get(bad)?.()
    // Bench transports settle through promise jobs only, so one macrotask lets a retry that does not wait run to its end.
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(b.fetched).not.toContain(chunkUrl('client.view.js', 'next'))
    b.gates.get(shared)?.()
    expect((await loaded).deps[0].deps[1]).toEqual({ name: 'next' })
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(b.system.loadCache.get(`${OWNER}/client.shared.js`)?.exports).toEqual({ name: 'next' })
  })

  it('re-executes an entry script that registers several chunks after invalidation', async () => {
    const script: readonly Registration[] = [chunk('client.runtime.js'), {
      deps: ['./client.runtime.js'],
      factory: require => ({ runtime: require('./client.runtime.js') }),
    }]
    const b = bench({ [BATCH_URL]: script, [entryUrl('next')]: script })
    await b.system.import(OWNER, '', {})
    b.system.invalidate(OWNER, 'next')
    expect([...b.system.loadCache.keys()].filter(id => id.startsWith(OWNER))).toEqual([])
    await expect(b.system.import(OWNER, '', {})).resolves.toEqual({ runtime: { name: 'client.runtime.js', deps: [] } })
    expect(b.fetched).toEqual([BATCH_URL, entryUrl('next')])
  })
})

describe('chunk request validation', () => {
  it('rejects a registration or hint whose dependency names no package-local chunk', async () => {
    const b = bench({ [BATCH_URL]: [loaderEntry()] })
    expect(() => { b.target.load({ id: OWNER, chunk: 'client.view.js', deps: ['../client.base.js'], factory: () => ({}) }) })
      .toThrow(`invalid chunk dependency "../client.base.js" of "${OWNER}/client.view.js"`)
    const entry = await b.system.import(OWNER, '', {}) as LoaderEntry
    await expect(entry.load('./client.view.js', { deps: ['client.base.js'] }))
      .rejects.toThrow('invalid chunk dependency "client.base.js" of require.async("./client.view.js")')
    expect(b.fetched).toEqual([BATCH_URL])
  })

  it('ignores the options of a request for another package', async () => {
    const b = bench({ [BATCH_URL]: [loaderEntry()] }, { seed: [{ id: 'other', factory: () => ({ name: 'other' }) }] })
    const entry = await b.system.import(OWNER, '', {}) as LoaderEntry
    await expect(entry.load('other', { deps: ['not a chunk'] })).resolves.toEqual({ name: 'other' })
  })

  it('resolves a synchronous chunk request only for a registered package-local chunk', async () => {
    for (const [spec, message] of [
      ['./client.missing.js', `"${OWNER}" required chunk client.missing.js before it was registered`],
      ['./missing.js', 'invalid relative chunk request "./missing.js"'],
    ] as const) {
      const b = bench({ [BATCH_URL]: [{ factory: require => ({ value: require(spec) }) }] })
      await expect(b.system.import(OWNER, '', {})).rejects.toThrow(message)
    }
  })
})
