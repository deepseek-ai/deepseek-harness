/**
 * @vitest-environment jsdom
 *
 * Guard facade account: the whitelist a dynamic plugin's `apply` sees, the
 * automatic shadowing priority on the slots seat, the theme seat's pinned
 * override source and fiber-owned disposer, and the Context denial that keeps a
 * dynamic package from reaching a foreign context. Registrations ride the
 * CALLING fiber, so disposing it must remove them (HMR safety).
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { FC } from 'react'
import type {
  CordisDynamicPackageId,
  CordisDynamicPluginId,
  CordisDynamicPluginRunId,
  DynamicCordisPackage,
} from '@deepseek-ai/dsh-api-remotes/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { dynamicCordisContext } from '../src/client/guard.ts'
import type { DynamicCordisSlotLedgerRow } from '../src/client/guard.ts'

const C: FC<object> = () => null

/** The exact running package carried by a Client dispatch. */
function pkg(): DynamicCordisPackage {
  return {
    pluginId: 'dyn-1' as CordisDynamicPluginId,
    packageId: 'pkg-1' as CordisDynamicPackageId,
    pluginRunId: 'run-1' as CordisDynamicPluginRunId,
    name: 'demo',
  }
}

/** Erased facade view: a dynamic package reads services off plain properties. */
type Facade = Record<string, unknown> & { get(name: string): unknown }

interface Bench {
  ctx: Context
  slots: SlotRegistry
  facade: Facade
  ledger: DynamicCordisSlotLedgerRow[]
  /** Components the facade claimed for the package, in registration order. */
  claimed: unknown[]
  dispose: () => Promise<void>
  overrideTokens: ReturnType<typeof vi.fn>
  themeLayerDispose: ReturnType<typeof vi.fn>
}

/**
 * Mount a dynamic-plugin fiber declaring `inject`, and capture the facade its
 * apply receives (the real product path: the facade wraps the fiber's own ctx).
 */
async function boot(inject: string[], extras: Record<string, unknown> = {}): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry)
  const themeLayerDispose = vi.fn()
  const overrideTokens = vi.fn(() => themeLayerDispose)
  ctx.reflect.provide('theme', {
    overrideTokens,
    getTheme: () => ({ preference: 'light' }),
    reload: () => Promise.resolve('reloaded'),
    revision: 3,
    escape: () => new Context(),
    escapeLater: () => Promise.resolve(new Context()),
  })
  for (const [name, value] of Object.entries(extras)) ctx.reflect.provide(name, value)
  const ledger: DynamicCordisSlotLedgerRow[] = []
  const claimed: unknown[] = []
  let nextPriority = 0
  let facade: Facade | undefined
  const fiber = ctx.plugin({
    name: 'dyn/dyn-1',
    inject,
    apply: (own: Context) => {
      facade = dynamicCordisContext(own, {
        pkg: pkg(),
        ledger,
        claim: (component) => { claimed.push(component) },
        allocatePriority: () => --nextPriority,
        reportFailure: () => {},
      }) as unknown as Facade
    },
  })
  await fiber
  if (facade === undefined) throw new Error('facade was not captured')
  return {
    ctx,
    slots: ctx.slots,
    facade,
    ledger,
    claimed,
    dispose: async () => { await fiber.dispose() },
    overrideTokens,
    themeLayerDispose,
  }
}

describe('facade surface', () => {
  it('forwards whitelisted lifecycle verbs to the real ctx', async () => {
    const bench = await boot([])
    const seen: string[] = []
    const on = bench.facade.on as (event: string, listener: (key: string) => void) => void
    on('slots/changed', key => seen.push(key))
    bench.ctx.emit('slots/changed', 'root')
    expect(seen).toEqual(['root'])
  })

  it('teaches the object form when an existing service was not declared', async () => {
    const bench = await boot([])
    expect(() => bench.facade.slots).toThrow(/service "slots" is not declared by your plugin/)
    expect(() => bench.facade.slots).toThrow(/a plain `function` has no declaration site/)
  })

  it('withholds framework internals with a teaching list', async () => {
    const bench = await boot([])
    expect(() => bench.facade.registry).toThrow(/dynamic ctx does not expose "registry"/)
    expect(() => bench.facade.registry).toThrow(/any service your returned plugin declared in inject/)
  })

  it('answers `get` and `has` over the same whitelist, and refuses writes', async () => {
    const bench = await boot(['slots'])
    expect(typeof bench.facade.get('slots')).toBe('object')
    expect('get' in bench.facade).toBe(true)
    expect('on' in bench.facade).toBe(true)
    expect('slots' in bench.facade).toBe(true)
    expect('registry' in bench.facade).toBe(false)
    expect(Symbol.iterator in bench.facade).toBe(false)
    expect((bench.facade as Record<symbol, unknown>)[Symbol.iterator]).toBeUndefined()
    expect(() => { bench.facade.slots = 1 }).toThrow(/dynamic ctx is read-only/)
  })

  it('denies a service value or return that is a cordis Context', async () => {
    const bench = await boot(['leaky'], {
      leaky: { escape: () => new Context(), later: () => Promise.resolve(new Context()), plain: 7 },
    })
    const leaky = bench.facade.leaky as { escape(): unknown; later(): Promise<unknown>; plain: number }
    expect(() => leaky.escape()).toThrow(/returned a cordis Context/)
    await expect(leaky.later()).rejects.toThrow(/returned a cordis Context/)
    expect(leaky.plain).toBe(7)
  })

  it('passes a primitive service through untouched', async () => {
    const bench = await boot(['flag'], { flag: 'on' })
    expect(bench.facade.flag).toBe('on')
  })
})

describe('slots seat', () => {
  it('assigns a descending shadowing priority per registration and ledgers it', async () => {
    const bench = await boot(['slots'])
    const slots = bench.facade.slots as { register(options: object, component: unknown): () => void }
    slots.register({ name: 'root' }, C)
    slots.register({ name: 'root' }, C)
    expect(bench.ledger).toEqual([
      { slot: 'root', priority: -1 },
      { slot: 'root', priority: -2 },
    ])
    // Newest-wins ordering is what "registering IS shadowing" means.
    const priorities = bench.slots.entries('root').map(entry => entry.options.priority)
    expect(priorities).toContain(-1)
    expect(priorities).toContain(-2)
  })

  it('keeps an explicit priority when the target elects its own order', async () => {
    const bench = await boot(['slots'])
    const slots = bench.facade.slots as { register(options: object, component: unknown): () => void }
    const spec = vi.spyOn(bench.slots, 'spec').mockReturnValue({ kind: 'chain', scope: 'root' })
    slots.register({ name: 'root', priority: 5 }, C)
    spec.mockRestore()
    expect(bench.ledger).toEqual([{ slot: 'root', priority: 5 }])
  })

  it('ledgers and claims Factory definitions without assigning Slot priority', async () => {
    const bench = await boot(['slots'])
    const slots = bench.facade.slots as {
      registerFactory(options: object, component: unknown): () => void
    }
    slots.registerFactory({ name: 'guard.factory', scope: 'root' }, C)

    expect(bench.ledger).toEqual([{ slot: 'factory:guard.factory', priority: undefined }])
    expect(bench.claimed).toEqual([C])
    expect(bench.slots.snapshot('factory:guard.factory')).toMatchObject([{
      type: 'factory', name: 'guard.factory', scope: 'root',
    }])
    await bench.dispose()
    expect(bench.slots.snapshot('factory:guard.factory')).toEqual([])
  })

  it('rejects a malformed register call before touching the registry', async () => {
    const bench = await boot(['slots'])
    const slots = bench.facade.slots as { register(options: unknown, component: unknown): () => void }
    expect(() => slots.register(null, C)).toThrow(/needs an options object with a `name`/)
    expect(() => slots.register({}, C)).toThrow(/need a string `name`/)
    expect(bench.slots.entries('root')).toHaveLength(0)
  })

  it('forwards non-register slot methods through the generic guard', async () => {
    const bench = await boot(['slots'])
    const slots = bench.facade.slots as {
      register(options: object, component: unknown): () => void
      entries(key: string): readonly unknown[]
    }
    slots.register({ name: 'root' }, C)
    expect(slots.entries('root')).toHaveLength(1)
  })

  it('denies a non-callable slots member that would hand out a context', async () => {
    const bench = await boot(['slots'])
    const slots = bench.facade.slots as { ctx: unknown }
    // The service's own ctx is the classic escape route out of the facade.
    expect(() => slots.ctx).toThrow(/service "slots" returned a cordis Context/)
  })

  it('removes its registrations when the calling fiber unloads (HMR safety)', async () => {
    const bench = await boot(['slots'])
    const slots = bench.facade.slots as { register(options: object, component: unknown): () => void }
    slots.register({ name: 'root' }, C)
    expect(bench.slots.entries('root')).toHaveLength(1)
    await bench.dispose()
    expect(bench.slots.entries('root')).toHaveLength(0)
  })
})

describe('theme seat', () => {
  it('pins the override source to the package id whatever the caller passes', async () => {
    const bench = await boot(['theme'])
    const theme = bench.facade.theme as { overrideTokens(source: unknown, tokens: unknown): () => void }
    const tokens = { '--dsw-alias-x': { light: '#fff', dark: '#000' } }
    theme.overrideTokens('pretend-to-be-someone-else', tokens)
    expect(bench.overrideTokens).toHaveBeenCalledWith('dyn-1.pkg-1', tokens)
  })

  it('teaches the two-argument shape when the token map arrives first', async () => {
    const bench = await boot(['theme'])
    const theme = bench.facade.theme as { overrideTokens(source: unknown, tokens?: unknown): () => void }
    expect(() => theme.overrideTokens({ '--x': { light: 'a', dark: 'b' } }))
      .toThrow(/takes two arguments; source is replaced with your package id/)
    expect(bench.overrideTokens).not.toHaveBeenCalled()
  })

  it('hangs the layer disposer on the fiber while still returning it', async () => {
    const bench = await boot(['theme'])
    const theme = bench.facade.theme as { overrideTokens(source: unknown, tokens: unknown): () => void }
    const handle = theme.overrideTokens('mine', {})
    expect(handle).toBe(bench.themeLayerDispose)
    expect(bench.themeLayerDispose).not.toHaveBeenCalled()
    // Model code cannot be trusted to keep the handle: unload must restore.
    await bench.dispose()
    expect(bench.themeLayerDispose).toHaveBeenCalledTimes(1)
  })

  it('forwards other theme methods, including asynchronous ones', async () => {
    const bench = await boot(['theme'])
    const theme = bench.facade.theme as {
      getTheme(): { preference: string }
      reload(): Promise<string>
      revision: number
    }
    expect(theme.getTheme().preference).toBe('light')
    await expect(theme.reload()).resolves.toBe('reloaded')
    expect(theme.revision).toBe(3)
  })

  it('denies a Context a theme method hands back, synchronously or awaited', async () => {
    const bench = await boot(['theme'])
    const theme = bench.facade.theme as { escape(): unknown; escapeLater(): Promise<unknown> }
    expect(() => theme.escape()).toThrow(/service "theme" returned a cordis Context/)
    await expect(theme.escapeLater()).rejects.toThrow(/service "theme" returned a cordis Context/)
  })
})
