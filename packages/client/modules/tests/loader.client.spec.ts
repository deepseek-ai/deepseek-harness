// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apply, createClientModuleSystem, parseBootManifest,
  type BootModuleRow, type ClientBundleRegistration, type ClientModuleCreateOptions,
  type ClientModuleLoader, type ClientModuleLoaderTarget, type DshWindow,
} from '../src/client/index.ts'

const MODULES_ID = '@deepseek-ai/dsh-client-modules'

const comboUrl = (ids: readonly string[], rev: string): string =>
  `/plugins/??${ids.map(id => `${id}/client.js`).join(',')}&rev=${rev}`
const BOOTSTRAP_URL = comboUrl([MODULES_ID], 'bootstrap')
const APPLICATION_URL = comboUrl(['a', 'b'], 'application')
const win = globalThis as DshWindow
const bootstrapExports = { apply, createClientModuleSystem }

type Factory = ClientBundleRegistration['factory']

afterEach(() => {
  vi.unstubAllGlobals()
  delete win.__ModuleLoader__
  for (const el of document.querySelectorAll('style, script')) el.remove()
})

const row = (id: string, fields: Partial<BootModuleRow> = {}): BootModuleRow =>
  ({
    id,
    url: comboUrl([id], '0'),
    initialUrl: id === MODULES_ID ? BOOTSTRAP_URL : APPLICATION_URL,
    rev: '0',
    inject: [],
    external: [],
    ...fields,
  })

interface Bench {
  loader: ClientModuleLoader
  target: ClientModuleLoaderTarget
  fetched: string[]
  gates: Map<string, () => void>
}

/** Build the page-global facade shape consumed by the module system. */
function registrationTarget(pending: ClientBundleRegistration[] = []): ClientModuleLoaderTarget {
  const pendingQueue = [...pending]
  const target: ClientModuleLoaderTarget = {
    mode: 'queue',
    pendingQueue,
    load: (registration) => { pendingQueue.push(registration) },
    create: options => createClientModuleSystem(target, {
      id: MODULES_ID,
      exports: bootstrapExports,
    }, options),
  }
  return target
}

/**
 * Loader over scripted bundles: load records the row URL, optionally waits on
 * a release callback, then registers the scripted factory through the window
 * sink (`null` scripts a bundle that never calls load).
 */
function bench(
  entries: BootModuleRow[],
  bundles: Record<string, Factory | null> = {},
  opts: {
    seed?: Record<string, unknown>
    gated?: string[]
    pending?: ClientBundleRegistration[]
    defaultTransport?: boolean
  } = {},
): Bench {
  const fetched: string[] = []
  const gates = new Map<string, () => void>()
  const target = registrationTarget(opts.pending)
  win.__ModuleLoader__ = target
  const loadBundle = async (url: string): Promise<void> => {
    fetched.push(url)
    if (opts.gated?.includes(url) === true) {
      await new Promise<void>((resolve) => { gates.set(url, resolve) })
    }
    const batchIds = url === BOOTSTRAP_URL
      ? entries.filter(entry => entry.initialUrl === BOOTSTRAP_URL).map(entry => entry.id)
      : url === APPLICATION_URL
        ? entries.filter(entry => entry.initialUrl === APPLICATION_URL).map(entry => entry.id)
        : undefined
    const parsed = new URL(url, 'http://dsh.invalid')
    const combo = parsed.search.startsWith('??') ? parsed.search.slice(2).split('&', 1)[0] : undefined
    const singleId = combo?.split(',').length === 1 && combo.endsWith('/client.js')
      ? combo.slice(0, -'/client.js'.length)
      : undefined
    for (const id of batchIds ?? (singleId === undefined ? [] : [singleId])) {
      const factory = bundles[id]
      if (factory != null) win.__ModuleLoader__?.load({ id, factory })
    }
  }
  const bootstrapEntries = entries.filter(entry => entry.initialUrl === BOOTSTRAP_URL).map(entry => entry.id)
  const applicationEntries = entries.filter(entry => entry.initialUrl === APPLICATION_URL).map(entry => entry.id)
  const batches = [
    ...(bootstrapEntries.length === 0 ? [] : [{
      phase: 'bootstrap' as const, url: BOOTSTRAP_URL, rev: 'bootstrap', entries: bootstrapEntries,
    }]),
    ...(applicationEntries.length === 0 ? [] : [{
      phase: 'application' as const, url: APPLICATION_URL, rev: 'application', entries: applicationEntries,
    }]),
  ]
  const loader = target.create({
    boot: {
      rev: 'graph',
      entries: entries.map(({ initialUrl: _initialUrl, inject, external, ...entry }) => ({
        ...entry,
        ...(inject.length === 0 ? {} : { inject }),
        ...(external.length === 0 ? {} : { external }),
      })),
      batches,
    },
    staticModules: opts.seed ?? {},
    ...(opts.defaultTransport === true ? {} : { loadBundle }),
  })
  return { loader, target, fetched, gates }
}

describe('Cordis plugin face', () => {
  it('rejects a Loader whose internal is absent or not a client module system', () => {
    for (const internal of [undefined, { version: 'worker' }]) {
      const ctx = new Context()
      ctx.provide('loader', { internal } as never)
      expect(() => { apply(ctx) }).toThrow('the Loader has no client module system')
    }
  })
})

describe('lazy CJS arrival', () => {
  it('drains registrations queued by parser-blocking preload scripts into the same live facade', async () => {
    const b = bench([row('runtime')], {}, {
      pending: [{ id: 'runtime', factory: () => ({ marker: 'preloaded' }) }],
    })
    const exports = await b.loader.import('runtime', '', {})
    expect((exports as { marker: string }).marker).toBe('preloaded')
    expect(b.target.pendingQueue).toEqual([])
    expect(b.fetched).toEqual([])
    expect(win.__ModuleLoader__).toBe(b.target)
    expect(b.target.mode).toBe('live')
  })

  it('prefetch loads and registers but does not run the factory', async () => {
    const ran: string[] = []
    const b = bench([row('a')], { a: () => { ran.push('a'); return {} } })
    await b.loader.prefetch('a')
    expect(b.fetched).toEqual([APPLICATION_URL])
    expect(ran).toEqual([])
    expect(b.loader.loadCache.has('a')).toBe(false)
  })

  it('import materializes once and memoizes the exports', async () => {
    const ran: string[] = []
    const b = bench([row('a')], { a: () => { ran.push('a'); return { marker: 'a' } } })
    const first = await b.loader.import('a', '', {})
    const second = await b.loader.import('a', '', {})
    expect(first).toBe(second)
    expect((first as { marker: string }).marker).toBe('a')
    expect(ran).toEqual(['a'])
    expect(b.loader.loadCache.get('a')?.id).toBe('a')
  })

  it('import without prefetch loads, registers, and materializes in one call', async () => {
    const b = bench([row('a')], { a: () => ({ marker: 'direct' }) })
    const exports = await b.loader.import('a', '', {})
    expect((exports as { marker: string }).marker).toBe('direct')
    expect(b.fetched).toHaveLength(1)
  })

  it('registers declared dynamic requests before materializing their consumer', async () => {
    const b = bench([
      row('consumer', { external: ['provider/client', 'react'] }),
      row('provider'),
    ], {
      consumer: req => ({ provider: req('provider/client'), react: req('react') }),
      provider: () => ({ marker: 'provider' }),
    }, { seed: { react: { marker: 'react' } } })
    const exports = await b.loader.import('consumer', '', {}) as {
      provider: { marker: string }
      react: { marker: string }
    }
    expect(b.fetched).toEqual([APPLICATION_URL])
    expect(exports.provider.marker).toBe('provider')
    expect(exports.react.marker).toBe('react')
  })

  it('registers injected package factories before materializing a consumer', async () => {
    const b = bench([
      row('consumer', { inject: ['provider'] }),
      row('provider', { inject: ['consumer'] }),
    ], {
      consumer: req => ({ provider: req('provider/client') }),
      provider: () => ({ marker: 'provider' }),
    })
    const exports = await b.loader.import('consumer', '', {}) as { provider: { marker: string } }
    expect(b.fetched).toEqual([APPLICATION_URL])
    expect(exports.provider.marker).toBe('provider')
  })

  it('concurrent callers share one in-flight arrival and materialize once', async () => {
    const ran: string[] = []
    const url = APPLICATION_URL
    const b = bench([row('a')], { a: () => { ran.push('a'); return { marker: 'a' } } }, { gated: [url] })
    const first = b.loader.import('a', '', {})
    const second = b.loader.import('a', '', {})
    const third = b.loader.prefetch('a')
    b.gates.get(url)?.()
    const [s1, s2] = await Promise.all([first, second, third])
    expect(s1).toBe(s2)
    expect(b.fetched).toEqual([url])
    expect(ran).toEqual(['a'])
  })

  it('prefetch after registration is a no-op without invalidate', async () => {
    const b = bench([row('a')], { a: () => ({}) })
    await b.loader.prefetch('a')
    await b.loader.prefetch('a')
    expect(b.fetched).toHaveLength(1)
  })
})

describe('require resolution', () => {
  it('a factory requiring a registered-but-unmaterialized module materializes it recursively', async () => {
    const order: string[] = []
    const b = bench([row('a'), row('b')], {
      a: (req) => {
        order.push('a')
        const dep = req('b/client') as { helper: string }
        return { got: dep.helper }
      },
      b: () => { order.push('b'); return { helper: 'from-b' } },
    })
    await b.loader.prefetch('a')
    await b.loader.prefetch('b')
    const exports = await b.loader.import('a', '', {})
    expect((exports as { got: string }).got).toBe('from-b')
    expect(order).toEqual(['a', 'b'])
    expect(b.loader.loadCache.get('a')?.edges.has('b/client')).toBe(true)
    expect(b.loader.loadCache.has('b')).toBe(true)
  })

  it('require prefers the platform seed word over the module table', async () => {
    const react = { marker: 'react' }
    const b = bench([row('a')], {
      a: req => ({ dep: req('react') }),
    }, { seed: { react } })
    const exports = await b.loader.import('a', '', {})
    expect((exports as { dep: unknown }).dep).toBe(react)
    expect(await b.loader.import('react', '', {})).toBe(react)
    expect(b.loader.loadCache.has('react')).toBe(false)
  })

  it('require answers an already-materialized module from the cache', async () => {
    let built = 0
    const b = bench([row('a'), row('c')], {
      a: req => ({ dep: req('c') }),
      c: () => { built += 1; return { marker: 'c' } },
    })
    const c = await b.loader.import('c', '', {})
    const a = await b.loader.import('a', '', {})
    expect((a as { dep: unknown }).dep).toBe(c)
    expect(built).toBe(1)
  })

  it('a require that misses the module table is loud', async () => {
    const b = bench([row('a')], { a: req => ({ dep: req('ghost') }) })
    await expect(b.loader.import('a', '', {})).rejects.toThrow('require("ghost") missed the module table')
  })

  it('a require cycle is fatal', async () => {
    const b = bench([row('a'), row('b')], {
      a: req => ({ dep: req('b') }),
      b: req => ({ dep: req('a') }),
    })
    await b.loader.prefetch('b')
    await expect(b.loader.import('a', '', {})).rejects.toThrow('require cycle through "a"')
  })
})

describe('bootstrap module', () => {
  it('caches the materialized modules exports under the package id and /client alias', async () => {
    const b = bench([
      row('consumer', { external: [`${MODULES_ID}/client`] }),
      row(MODULES_ID),
    ], {
      consumer: req => ({ dep: req(`${MODULES_ID}/client`) }),
    })
    await b.loader.prefetch(MODULES_ID)
    const exports = await b.loader.import('consumer', '', {}) as { dep: unknown }
    expect(exports.dep).toBe(bootstrapExports)
    expect(await b.loader.import(`${MODULES_ID}/client`, '', {})).toBe(bootstrapExports)
    expect(b.fetched).toEqual([APPLICATION_URL])
  })

  it('publishes the module system attached to its own Loader', () => {
    const a = bench([])
    const b = bench([])
    const ctxA = new Context()
    const ctxB = new Context()
    ctxA.reflect.provide('loader', { internal: a.loader })
    ctxB.reflect.provide('loader', { internal: b.loader })

    apply(ctxA)
    apply(ctxB)

    expect(ctxA.modules).toBe(a.loader)
    expect(ctxB.modules).toBe(b.loader)
  })

  it('rejects a second queued registration for the bootstrap id', () => {
    expect(() => bench([], {}, {
      pending: [{ id: `${MODULES_ID}/client`, factory: () => ({}) }],
    })).toThrow(`duplicate factory registration for "${MODULES_ID}/client"`)
  })
})

describe('failure modes', () => {
  it('duplicate factory registration is loud', () => {
    bench([])
    win.__ModuleLoader__?.load({ id: 'x', factory: () => ({}) })
    expect(() => win.__ModuleLoader__?.load({ id: 'x', factory: () => ({}) }))
      .toThrow('duplicate factory registration for "x"')
  })

  it('a bundle that never registers its id is loud', async () => {
    const b = bench([row('a')], { a: null })
    await expect(b.loader.import('a', '', {})).rejects.toThrow('without registering "a"')
  })

  it('an unknown import specifier is loud', async () => {
    const b = bench([])
    await expect(b.loader.import('nope', '', {})).rejects.toThrow('cannot resolve "nope"')
  })

  it('an unknown prefetch id is loud', async () => {
    const b = bench([])
    await expect(b.loader.prefetch('nope')).rejects.toThrow('prefetch("nope") — not a graph entry')
  })

  it('a duplicate graph entry is loud at construction', () => {
    expect(() => bench([row('a'), row('a')])).toThrow('duplicate graph entry "a"')
  })

  it('a module arrival cycle is loud even if a malformed host graph reaches the browser', async () => {
    const b = bench([
      row('a', { external: ['b'] }),
      row('b', { external: ['a'] }),
    ])
    await expect(b.loader.prefetch('a')).rejects.toThrow('module arrival cycle a -> b -> a')
  })

  it('double boot is loud', () => {
    const b = bench([])
    const options: ClientModuleCreateOptions = {
      boot: { rev: 'graph', entries: [], batches: [] },
      staticModules: {},
    }
    expect(() => b.target.create(options)).toThrow('create called after module-system boot')
  })
})

describe('boot manifest wire', () => {
  it('normalizes absent shared-module fields and carries the declared ones', () => {
    const manifest = parseBootManifest({
      rev: 'graph',
      entries: [
        { id: 'a', url: '/plugins/a/client.js', rev: '1', inject: ['b'] },
        { id: 'b', url: '/plugins/b/client.js', rev: '2', external: ['react'] },
      ],
      batches: [{ phase: 'application', url: '/batch.js', rev: 'batch', entries: ['a', 'b'] }],
    })
    expect(manifest.modules).toEqual([
      { id: 'a', url: '/plugins/a/client.js', initialUrl: '/batch.js', rev: '1', inject: ['b'], external: [] },
      { id: 'b', url: '/plugins/b/client.js', initialUrl: '/batch.js', rev: '2', inject: [], external: ['react'] },
    ])
  })

  it('rejects a non-array external', () => {
    expect(() => parseBootManifest({
      rev: 'graph',
      entries: [{ id: 'a', url: '/a', rev: '1', external: 'react' }],
      batches: [{ phase: 'application', url: '/batch.js', rev: 'batch', entries: ['a'] }],
    })).toThrow('client-modules: boot manifest entry "a" external must be a string array')
  })

  it('requires the batch table', () => {
    expect(() => parseBootManifest({ rev: 'graph', entries: [] }))
      .toThrow('client-modules: boot manifest batches must be an array')
  })

  it('rejects malformed batch phases', () => {
    const entry = { id: 'a', url: '/a.js', rev: '1' }
    expect(() => parseBootManifest({ rev: 'graph', entries: [entry], batches: [null] }))
      .toThrow('client-modules: boot manifest batch is not an object')
    expect(() => parseBootManifest({
      rev: 'graph', entries: [entry], batches: [{ phase: 'idle', url: '/b.js', rev: 'b', entries: ['a'] }],
    })).toThrow('boot manifest batch phase must be "bootstrap" or "application"')
  })

  it('rejects duplicate batch URLs', () => {
    expect(() => parseBootManifest({
      rev: 'graph',
      entries: [
        { id: 'a', url: '/a.js', rev: '1' },
        { id: 'b', url: '/b.js', rev: '2' },
      ],
      batches: [
        { phase: 'application', url: '/combo.js', rev: '1', entries: ['a'] },
        { phase: 'application', url: '/combo.js', rev: '2', entries: ['b'] },
      ],
    })).toThrow('boot manifest carries duplicate batch URL "/combo.js"')
  })

  it('allows several batches in one scheduling phase', () => {
    const manifest = parseBootManifest({
      rev: 'graph',
      entries: [
        { id: 'a', url: '/a.js', rev: '1' },
        { id: 'b', url: '/b.js', rev: '2' },
      ],
      batches: [
        { phase: 'application', url: '/b.js', rev: '1', entries: ['a'] },
        { phase: 'application', url: '/c.js', rev: '2', entries: ['b'] },
      ],
    })
    expect(manifest.modules.map(row => row.initialUrl)).toEqual(['/b.js', '/c.js'])
  })

  it('requires complete batch fields and non-empty entries', () => {
    const entry = { id: 'a', url: '/a.js', rev: '1' }
    expect(() => parseBootManifest({
      rev: 'graph', entries: [entry], batches: [{ phase: 'application', entries: ['a'] }],
    })).toThrow('boot manifest application batch must carry string url/rev')
    expect(() => parseBootManifest({
      rev: 'graph', entries: [entry], batches: [{ phase: 'application', url: '/b.js', rev: 'b', entries: [] }],
    })).toThrow('boot manifest application batch entries must be a non-empty string array')
  })

  it('requires a one-to-one batch assignment over graph entries', () => {
    const entries = [
      { id: 'a', url: '/a.js', rev: '1' },
      { id: 'b', url: '/b.js', rev: '2' },
    ]
    expect(() => parseBootManifest({
      rev: 'graph',
      entries,
      batches: [{ phase: 'application', url: '/batch.js', rev: 'b', entries: ['ghost'] }],
    })).toThrow('boot manifest application batch names unknown entry "ghost"')
    expect(() => parseBootManifest({
      rev: 'graph',
      entries,
      batches: [
        { phase: 'bootstrap', url: '/boot.js', rev: 'boot', entries: ['a'] },
        { phase: 'application', url: '/batch.js', rev: 'app', entries: ['a', 'b'] },
      ],
    })).toThrow('boot manifest entry "a" belongs to more than one batch')
    expect(() => parseBootManifest({
      rev: 'graph',
      entries,
      batches: [{ phase: 'application', url: '/batch.js', rev: 'b', entries: ['a'] }],
    })).toThrow('boot manifest entry "b" belongs to no initial-load batch')
  })
})

describe('HMR reset', () => {
  it('invalidate drops the factory and record so the module reloads and re-registers', async () => {
    let generation = 0
    const b = bench([row('a')], { a: () => ({ generation: ++generation }) })
    const first = await b.loader.import('a', '', {})
    b.loader.invalidate('a', '1')
    expect(b.loader.loadCache.has('a')).toBe(false)
    await b.loader.prefetch('a')
    const second = await b.loader.import('a', '', {})
    expect(b.fetched).toEqual([APPLICATION_URL, comboUrl(['a'], '1')])
    expect((first as { generation: number }).generation).toBe(1)
    expect((second as { generation: number }).generation).toBe(2)
  })

  it('preserves an absolute combo endpoint when applying the rebuilt revision', async () => {
    const b = bench([
      row('a', { url: 'https://plugins.example.test/plugins/??a/client.js&rev=0' }),
    ], { a: () => ({}) })
    await b.loader.import('a', '', {})
    b.loader.invalidate('a', 'next')
    await b.loader.prefetch('a')
    expect(b.fetched.at(-1)).toBe('https://plugins.example.test/plugins/??a/client.js&rev=next')
  })

  it('preserves a protocol-relative combo endpoint when applying the rebuilt revision', async () => {
    const b = bench([
      row('a', { url: '//plugins.example.test/plugins/??a/client.js&rev=0' }),
    ], { a: () => ({}) })
    await b.loader.import('a', '', {})
    b.loader.invalidate('a', 'next')
    await b.loader.prefetch('a')
    expect(b.fetched.at(-1)).toBe('//plugins.example.test/plugins/??a/client.js&rev=next')
  })

  it('uses the current plugin revision when a graph-row invalidation omits an override', async () => {
    const b = bench([row('a')], { a: () => ({}) })
    await b.loader.import('a', '', {})
    b.loader.invalidate('a')
    await b.loader.prefetch('a')
    expect(b.fetched).toEqual([APPLICATION_URL, comboUrl(['a'], '0')])
  })
})

describe('style claiming', () => {
  it('claims untagged style tags for the materializing plugin and inventories owned css ids', async () => {
    const foreign = document.createElement('style')
    foreign.setAttribute('data-plugin', 'other')
    document.head.appendChild(foreign)
    const b = bench([row('a')], {
      a: () => {
        document.head.appendChild(document.createElement('style'))
        const tagged = document.createElement('style')
        tagged.setAttribute('data-plugin', 'a')
        tagged.setAttribute('data-plugin-css', 'sheet-1')
        document.head.appendChild(tagged)
        return {}
      },
    })
    await b.loader.import('a', '', {})
    expect(b.loader.loadCache.get('a')?.styles).toEqual(['a', 'sheet-1'])
    expect(document.querySelectorAll('style[data-plugin="a"]')).toHaveLength(2)
    expect(foreign.getAttribute('data-plugin')).toBe('other')
  })

  it('materialization without a document skips the style inventory', async () => {
    const b = bench([row('a')], { a: () => ({}) })
    vi.stubGlobal('document', undefined)
    try {
      await b.loader.import('a', '', {})
    } finally {
      vi.unstubAllGlobals()
    }
    expect(b.loader.loadCache.get('a')?.styles).toEqual([])
  })
})

describe('default transport seam', () => {
  it('loads through an external classic script and removes the settled node', async () => {
    const append = vi.spyOn(document.head, 'append').mockImplementation((...nodes) => {
      const script = nodes[0]
      if (!(script instanceof HTMLScriptElement)) throw new Error('expected script node')
      expect(script.async).toBe(true)
      expect(script.getAttribute('src')).toBe(APPLICATION_URL)
      queueMicrotask(() => {
        win.__ModuleLoader__?.load({ id: 'dee', factory: () => ({ marker: 'via-script' }) })
        script.dispatchEvent(new Event('load'))
      })
    })
    const b = bench([row('dee')], {}, { defaultTransport: true })
    const exports = await b.loader.import('dee', '', {})
    expect((exports as { marker: string }).marker).toBe('via-script')
    expect(append).toHaveBeenCalledOnce()
    expect([...document.querySelectorAll('script')]).toEqual([])
  })

  it('a script load failure is loud and removes the node', async () => {
    vi.spyOn(document.head, 'append').mockImplementation((...nodes) => {
      const script = nodes[0]
      if (!(script instanceof HTMLScriptElement)) throw new Error('expected script node')
      queueMicrotask(() => { script.dispatchEvent(new Event('error')) })
    })
    const b = bench([row('dee')], {}, { defaultTransport: true })
    await expect(b.loader.prefetch('dee')).rejects.toThrow(
      `bundle script ${APPLICATION_URL} failed to load`,
    )
    expect([...document.querySelectorAll('script')]).toEqual([])
  })
})
