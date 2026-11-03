// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import {
  createClientModuleSystem, parseBootManifest,
  type ClientBundleRegistration, type ClientModuleLoader, type ClientModuleLoaderTarget, type WebBootEntry, type WebBootGraph,
} from '@deepseek-ai/dsh-client-modules/client'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { assertEntriesActive, bootClient, type EntryStateLabel } from '../src/boot-client.ts'
import { FIBER_STATE } from '../src/loader-status.ts'

const BOOTSTRAP_ID = '@deepseek-ai/dsh-client-modules'
const REQUIRED_ID = '@deepseek-ai/dsh-client-ui-chat'
const OTHER_REQUIRED_ID = '@deepseek-ai/dsh-client-ui-layout'

function graphOf(ids: readonly string[]): WebBootGraph {
  const entries: WebBootEntry[] = ids.map(id => ({ id, url: `/${id}.js`, rev: '1' }))
  return {
    rev: 'graph',
    entries,
    batches: [{ phase: 'application', url: '/application.js', rev: 'batch', entries: [...ids] }],
  }
}

/** Module system seeded with inline plugin modules; `loaded` records every transport call. */
function modulesOf(graph: WebBootGraph, staticModules: Record<string, unknown>): { modules: ClientModuleLoader; loaded: string[] } {
  const loaded: string[] = []
  const pendingQueue: ClientBundleRegistration[] = []
  const target: ClientModuleLoaderTarget = {
    mode: 'queue',
    pendingQueue,
    load: (registration) => { pendingQueue.push(registration) },
    create: options => createClientModuleSystem(target, { id: BOOTSTRAP_ID, exports: {} }, options),
  }
  const modules = target.create({
    boot: graph,
    staticModules,
    loadBundle: async (url) => { loaded.push(url) },
  })
  return { modules, loaded }
}

/** Recording progress sink. */
function stateSink(): { states: Map<string, EntryStateLabel[]>; onEntryState: (name: string, state: EntryStateLabel) => void } {
  const states = new Map<string, EntryStateLabel[]>()
  return {
    states,
    onEntryState: (name, state) => { states.set(name, [...(states.get(name) ?? []), state]) },
  }
}

describe('bootClient', () => {
  it('activates every seeded row without touching the bundle transport', async () => {
    const graph = graphOf(['provider', 'consumer'])
    const { modules, loaded } = modulesOf(graph, {
      provider: { apply: (ctx: Context) => { ctx.reflect.provide('x', { marker: 'x' }) } },
      consumer: { inject: ['x'], apply: () => {} },
    })
    const ctx = new Context()
    const sink = stateSink()

    await bootClient({ ctx, modules, manifest: modules.manifest, onEntryState: sink.onEntryState })

    expect(loaded).toEqual([])
    const consumer = sink.states.get('consumer') ?? []
    expect(consumer[0]).toBe('loading')
    expect(consumer.at(-1)).toBe('active')
    expect(sink.states.get('provider')?.at(-1)).toBe('active')
    await ctx.fiber.dispose()
  })

  it('rejects a required row waiting on a service the roster never provides', async () => {
    const graph = graphOf([REQUIRED_ID])
    const { modules } = modulesOf(graph, { [REQUIRED_ID]: { inject: ['nothing'], apply: () => {} } })
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())

    await expect(bootClient({ ctx, modules, manifest: modules.manifest })).rejects.toThrow(
      `${REQUIRED_ID} (required): pending (waiting for service: nothing)`,
    )
  })

  it('reports and logs an import failure for a required row that is neither seeded nor a graph row', async () => {
    const { modules } = modulesOf(graphOf(['seeded']), { seeded: { apply: () => {} } })
    const manifest = parseBootManifest(graphOf([REQUIRED_ID]))
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    onTestFinished(() => { error.mockRestore() })
    const sink = stateSink()

    await expect(bootClient({ ctx, modules, manifest, onEntryState: sink.onEntryState })).rejects.toThrow(
      `web boot: 1 required entry did not activate\n${REQUIRED_ID} (required): import failed (see console for the import error)`,
    )
    expect(sink.states.get(REQUIRED_ID)).toEqual(['loading', 'failed'])
    expect(error).toHaveBeenCalledOnce()
    expect(error.mock.calls[0]?.[0]).toHaveProperty('message', expect.stringContaining('client-modules: cannot resolve'))
  })

  it('resolves past an optional row that cannot be imported and warns once', async () => {
    const { modules } = modulesOf(graphOf(['seeded']), { seeded: { apply: () => {} } })
    const manifest = parseBootManifest(graphOf(['ghost']))
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => { error.mockRestore(); warn.mockRestore() })

    await bootClient({ ctx, modules, manifest })

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'web boot: warning: 1 entry did not activate\nghost: import failed (see console for the import error)',
    )
  })

  it('resolves past an optional row whose module exports no plugin and warns once', async () => {
    const { modules } = modulesOf(graphOf(['invalid']), { invalid: { default: 'invalid' } })
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => { error.mockRestore(); warn.mockRestore() })

    await bootClient({ ctx, modules, manifest: modules.manifest })

    expect(error).toHaveBeenCalledOnce()
    expect(error.mock.calls[0]?.[0]).toHaveProperty('message', expect.stringContaining('invalid plugin'))
    // The module imported, but an entry without a fiber is reported as an import failure, as the Host audit reports
    // `failed to import`; the creation error itself is in the log asserted above.
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'web boot: warning: 1 entry did not activate\ninvalid: import failed (see console for the import error)',
    )
  })

  it('rejects a required row whose module exports no plugin and names it', async () => {
    const { modules } = modulesOf(graphOf([REQUIRED_ID]), { [REQUIRED_ID]: { default: 'invalid' } })
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    onTestFinished(() => { error.mockRestore() })

    // Reported as an import failure like the Host audit's `failed to import`; the creation error goes to the log.
    await expect(bootClient({ ctx, modules, manifest: modules.manifest })).rejects.toThrow(
      `web boot: 1 required entry did not activate\n${REQUIRED_ID} (required): import failed (see console for the import error)`,
    )
  })
})

describe('assertEntriesActive', () => {
  interface FakeEntry { name: string; fiber?: { state: number; inject: Record<string, null>; await?: () => Promise<unknown> } }

  /** A settled failed fiber whose `await()` rethrows its recorded activation error, as Cordis does. */
  const failedFiber = (error: Error) => ({ state: FIBER_STATE.FAILED, inject: {}, await: () => Promise.reject(error) })

  /** Loader-shaped double: entries with scripted fiber states, services by name. */
  function auditCtx(entries: readonly FakeEntry[], services: Record<string, unknown> = {}): Context {
    return {
      loader: {
        * entries() {
          for (const entry of entries) yield { options: { name: entry.name }, fiber: entry.fiber }
        },
      },
      get: (name: string) => services[name],
    } as unknown as Context
  }

  const silent = { importError: () => undefined }

  it('passes without a warning when every entry is active', async () => {
    const warn = vi.fn<(message: string) => void>()
    await assertEntriesActive(auditCtx([{ name: REQUIRED_ID, fiber: { state: FIBER_STATE.ACTIVE, inject: {} } }]), silent, warn)
    expect(warn).not.toHaveBeenCalled()
  })

  it('ignores required names absent from the boot graph', async () => {
    const warn = vi.fn<(message: string) => void>()
    await assertEntriesActive(auditCtx([{ name: 'subset-only', fiber: { state: FIBER_STATE.ACTIVE, inject: {} } }]), silent, warn)
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns about import failures, missing services, and activation errors of optional entries', async () => {
    const ctx = auditCtx([
      { name: 'lost' },
      { name: 'waiting', fiber: { state: FIBER_STATE.PENDING, inject: { present: null, a: null, b: null } } },
      { name: 'opaque', fiber: { state: FIBER_STATE.PENDING, inject: {} } },
      { name: 'broken', fiber: failedFiber(new TypeError('apply boom')) },
    ], { present: {} })
    const warn = vi.fn<(message: string) => void>()

    await assertEntriesActive(ctx, silent, warn)

    expect(warn).toHaveBeenCalledExactlyOnceWith([
      'web boot: warning: 4 entries did not activate',
      'lost: import failed (see console for the import error)',
      'waiting: pending (waiting for services: a, b)',
      'opaque: pending (waiting for services: unknown)',
      'broken: failed: TypeError: apply boom',
    ].join('\n'))
  })

  it('rejects inactive required entries and lists every inactive entry without a separate warning', async () => {
    const ctx = auditCtx([
      { name: REQUIRED_ID },
      { name: 'optional', fiber: failedFiber(new RangeError('out of range')) },
      { name: OTHER_REQUIRED_ID, fiber: { state: FIBER_STATE.PENDING, inject: { theme: null } } },
    ])
    const warn = vi.fn<(message: string) => void>()

    await expect(assertEntriesActive(ctx, silent, warn)).rejects.toThrow([
      'web boot: 2 required entries did not activate',
      `${REQUIRED_ID} (required): import failed (see console for the import error)`,
      'optional: failed: RangeError: out of range',
      `${OTHER_REQUIRED_ID} (required): pending (waiting for service: theme)`,
    ].join('\n'))
    expect(warn).not.toHaveBeenCalled()
  })

  it('uses the singular form for one required entry', async () => {
    await expect(assertEntriesActive(auditCtx([{ name: REQUIRED_ID }]), silent))
      .rejects.toThrow('web boot: 1 required entry did not activate\n')
  })

  it('names the recorded import error of a fiberless entry when the module system is supplied', async () => {
    const recorded = new Map([['lost', new Error('client-modules: could not load "lost": plugins/??lost/client.js&rev=0: bundle script failed to load')]])
    const modules = { importError: (id: string) => recorded.get(id) }
    const warn = vi.fn<(message: string) => void>()
    await assertEntriesActive(auditCtx([{ name: 'lost' }, { name: 'quiet' }]), modules, warn)
    expect(warn).toHaveBeenCalledExactlyOnceWith([
      'web boot: warning: 2 entries did not activate',
      'lost: import failed: client-modules: could not load "lost": plugins/??lost/client.js&rev=0: bundle script failed to load',
      'quiet: import failed (see console for the import error)',
    ].join('\n'))
  })
})
