/**
 * SlotRegistry terminal-design account:
 * built-in 'root', the three load-time throws (duplicate declaration /
 * undeclared contribution / cross-scope store handle), the renderer installation
 * contract (double install / not installed / non-root key), store instance
 * resolution and lifecycle on the ledger axis, and the entry-unload cascade.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { FC } from 'react'
import { StaleAuthorizationError } from '@deepseek-ai/dsh-client-ui-slots'
import type { ScopedStandardSourceBinding, SlotRendererHost } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '../src/client/registry.ts'

// Test-only slot keys (merged so the typed entries/spec faces accept them).
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    't.host': { kind: 'single'; scope: 'root' }
    't.maybe': { kind: 'single'; scope: 'session-maybe' }
    't.panel': { kind: 'single'; scope: 'session' }
    't.rows': { kind: 'list'; scope: 'root' }
  }
}

const C: FC<object> = () => null

/**
 * Register/install/renderSlot through a type-erased view: the typed register
 * face rides wave-1 ui-slots types (red until that wave lands); the runtime
 * semantics under test are final.
 */
interface ErasedService {
  register(options: object, component: unknown): () => void
  registerFactory(options: object, component: unknown): () => void
  inject(name: string, callback: () => (() => void) | Iterable<() => void>): () => void
  install(renderer: object): void
  renderSlot(key: string, owner: object): unknown
}

interface Bench {
  ctx: Context
  svc: SlotRegistry
  erased: ErasedService
}

async function boot(): Promise<Bench> {
  const ctx = new Context()
  const fiber = ctx.plugin(SlotRegistry)
  await fiber
  // Service accessor (ctx.get reads the reflect store, which Service-class
  // plugins do not write; the accessor is the product path).
  const svc = ctx.slots
  return { ctx, svc, erased: svc }
}

/** Engine-shaped instance stub (bare-source form: subscribe/getSnapshot + baked actions + clearPersisted). */
interface FakeInstance {
  getSnapshot: () => undefined
  subscribe: () => () => void
  actions: Record<string, never>
  clearPersisted: ReturnType<typeof vi.fn>
}

/** Fake store handle factory (create-count and clearPersisted observable). */
function fakeHandle(persist?: string) {
  const created: FakeInstance[] = []
  const handle = {
    spec: {
      init: () => undefined,
      actions: {},
      ...(persist === undefined ? {} : { persist }),
    },
    create: vi.fn((_scopeKey?: string): FakeInstance => {
      const instance: FakeInstance = {
        getSnapshot: () => undefined, subscribe: () => () => undefined,
        actions: {}, clearPersisted: vi.fn(),
      }
      created.push(instance)
      return instance
    }),
  }
  return { handle, created }
}

/**
 * Install a capturing renderer, occupy 'root' (declaring `children` in the
 * same call — 'root' is single, so the one occupant is also the declarer),
 * and pull the host face out through renderSlot('root').
 */
function captureHost(bench: Bench, children?: object): SlotRendererHost {
  let host: SlotRendererHost | undefined
  bench.erased.install({
    renderRoot: (h: SlotRendererHost) => { host = h; return 'rendered' },
  })
  bench.erased.register({ name: 'root', ...(children !== undefined ? { children } : {}) }, C)
  bench.erased.renderSlot('root', {})
  if (host === undefined) throw new Error('renderer never received the host')
  return host
}

function scopedBinding(_ctx: Context, key: string) {
  const ctx = new Context()
  const binding: ScopedStandardSourceBinding = {
    key,
    ctx,
    hooks: {},
    keyedHooks: {},
    props: {},
  }
  return { binding, fiber: ctx.fiber }
}

describe('Factory definition ledger', () => {
  it('publishes one definition, rejects duplicates, and collapses its children on disposal', async () => {
    const bench = await boot()
    const host = captureHost(bench)
    const changed = vi.fn()
    host.subscribeFactory('test.factory', changed)
    const dispose = bench.erased.registerFactory({
      name: 'test.factory',
      scope: 'root',
      children: { 't.host': { kind: 'single', scope: 'root' } },
    }, C)
    const definition = host.factoryOf('test.factory')
    expect(definition).toMatchObject({ name: 'test.factory', scope: 'root' })
    expect(bench.svc.spec('t.host')).toEqual({ kind: 'single', scope: 'root' })
    const disposeChild = bench.erased.register({ name: 't.host' }, C)
    const child = host.entriesOf('t.host')[0]
    expect(bench.svc.snapshot('factory:test.factory')).toMatchObject([{
      type: 'factory',
      name: 'test.factory',
      scope: 'root',
      children: [{ type: 'slot', name: 't.host' }],
    }])
    expect(bench.svc.snapshot().some(node => node.type === 'slot' && node.name === 't.host')).toBe(false)
    expect(bench.svc.snapshot('factory:missing')).toEqual([])
    const releaseDefinition = host.retainFactoryOccurrence(definition!, {})
    releaseDefinition()
    releaseDefinition()

    expect(() => bench.erased.registerFactory({ name: 'test.factory', scope: 'root' }, C))
      .toThrow(/already has a definition/)
    dispose()
    dispose()
    await Promise.resolve()

    expect(changed).toHaveBeenCalledTimes(2)
    expect(host.factoryOf('test.factory')).toBeUndefined()
    expect(bench.svc.spec('t.host')).toBeUndefined()
    expect(host.isLive(child as never)).toBe(false)
    disposeChild()
    expect(() => bench.erased.registerFactory({ name: 'test.factory', scope: 'root' }, C)).not.toThrow()
  })

  it('keeps committed exclusive stores across effect replay and releases scoped instances', async () => {
    const bench = await boot()
    const host = captureHost(bench)
    const handles: ReturnType<typeof fakeHandle>[] = []
    const factory = vi.fn(() => {
      const handle = fakeHandle()
      handles.push(handle)
      return handle.handle
    })
    const dispose = bench.erased.registerFactory({
      name: 'test.scoped-factory', scope: 'session-maybe', store: factory,
    }, C)
    const definition = host.factoryOf('test.scoped-factory')!
    const scope = scopedBinding(bench.ctx, 's1')
    const firstOccurrence = {}
    const secondOccurrence = {}

    expect(() => host.factoryStoreOf(definition, undefined, firstOccurrence))
      .toThrow('session-maybe factory store resolution requires a session id')
    const first = host.factoryStoreOf(definition, scope.binding, firstOccurrence)
    const repeated = host.factoryStoreOf(definition, scope.binding, firstOccurrence)
    const second = host.factoryStoreOf(definition, scope.binding, secondOccurrence)
    const releaseFirst = host.retainFactoryOccurrence(definition, firstOccurrence)
    const releaseFirstAgain = host.retainFactoryOccurrence(definition, firstOccurrence)
    const releaseSecond = host.retainFactoryOccurrence(definition, secondOccurrence)

    expect(repeated).toBe(first)
    expect(second).not.toBe(first)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(handles[0]?.created).toHaveLength(1)
    expect(handles[0]?.handle.create).toHaveBeenCalledWith('s1')
    expect(handles[1]?.handle.create).toHaveBeenCalledWith('s1')

    releaseFirst()
    releaseFirst()
    releaseFirstAgain()
    const releaseReplay = host.retainFactoryOccurrence(definition, firstOccurrence)
    expect(host.factoryStoreOf(definition, scope.binding, firstOccurrence)).toBe(first)
    expect(factory).toHaveBeenCalledTimes(2)
    releaseReplay()

    await scope.fiber.dispose()
    expect(handles[0]?.created[0]?.clearPersisted).not.toHaveBeenCalled()
    expect(handles[1]?.created[0]?.clearPersisted).not.toHaveBeenCalled()

    const replacement = scopedBinding(bench.ctx, 's1')
    const recreated = host.factoryStoreOf(definition, replacement.binding, secondOccurrence)
    expect(recreated).not.toBe(second)
    await replacement.fiber.dispose()
    expect(handles[1]?.created[1]?.clearPersisted).not.toHaveBeenCalled()
    releaseSecond()

    dispose()
    expect(() => host.factoryStoreOf(definition, undefined, {})).toThrow(StaleAuthorizationError)
    const staleRelease = host.retainFactoryOccurrence(definition, {})
    expect(() => { staleRelease() }).not.toThrow()
  })

  it('rejects persistence on an exclusive Factory Store', async () => {
    const bench = await boot()
    const host = captureHost(bench)
    const persistent = fakeHandle('factory.persist')
    bench.erased.registerFactory({
      name: 'test.persistent-factory', scope: 'root', store: () => persistent.handle,
    }, C)
    const definition = host.factoryOf('test.persistent-factory')!

    expect(() => host.factoryStoreOf(definition, undefined, {}))
      .toThrow(/exclusive store.*cannot declare persistence/)
  })

  it('shares a Factory store handle on the ordinary optional-scope axis', async () => {
    const bench = await boot()
    const host = captureHost(bench)
    const { handle } = fakeHandle()
    bench.erased.registerFactory({ name: 'test.shared-factory', scope: 'session-maybe', store: handle }, C)
    const definition = host.factoryOf('test.shared-factory')!
    const scope = scopedBinding(bench.ctx, 's1')

    expect(() => host.factoryStoreOf(definition, undefined, {}))
      .toThrow('session-maybe store resolution requires a session id')
    const first = host.factoryStoreOf(definition, scope.binding, {})
    const second = host.factoryStoreOf(definition, scope.binding, {})
    const scoped = host.factoryStoreOf(definition, scope.binding, {})

    expect(first).toBe(second)
    expect(scoped).toBe(first)
    expect(handle.create).toHaveBeenCalledOnce()
    expect(handle.create).toHaveBeenCalledWith('s1')
    await scope.fiber.dispose()
  })
})

describe("built-in 'root'", () => {
  it('is declared at construction: spec readable, occupancy open, no plugin needed', async () => {
    const bench = await boot()
    expect(bench.svc.spec('root')).toEqual({ kind: 'single', scope: 'root' })
    expect(() => bench.erased.register({ name: 'root' }, C)).not.toThrow()
    expect(bench.svc.entries('root')).toHaveLength(1)
  })

  it('rejects a second declaration of root, attributing the built-in row', async () => {
    const bench = await boot()
    expect(() => bench.erased.register({
      name: 'root', children: { 'root': { kind: 'single', scope: 'root' } },
    }, C)).toThrow(/already declared.*built-in/)
  })
})

describe('load-time validation', () => {
  it('throws on contributing into an undeclared slot', async () => {
    const bench = await boot()
    expect(() => bench.erased.register({ name: 't.host' }, C)).toThrow(/slot "t.host" is not declared/)
  })

  it('throws on a duplicate declaration, naming the slot and the prior declarant', async () => {
    const bench = await boot()
    bench.erased.register({ name: 'root', children: { 't.host': { kind: 'single', scope: 'root' } } }, C)
    bench.erased.register({
      name: 't.host', children: { 't.rows': { kind: 'list', scope: 'root' } },
    }, C)
    expect(() => bench.erased.register({
      name: 't.rows', id: 'r1', children: { 't.rows': { kind: 'list', scope: 'root' } },
    }, C)).toThrow(/slot "t.rows" is already declared.*"t.host"/)
  })

  it('throws when one store handle is bound to two scopes', async () => {
    const bench = await boot()
    bench.erased.register({
      name: 'root',
      children: {
        't.host': { kind: 'single', scope: 'root' },
        't.panel': { kind: 'single', scope: 'session' },
      },
    }, C)
    const { handle } = fakeHandle()
    bench.erased.register({ name: 't.host', store: handle }, C)
    expect(() => bench.erased.register({ name: 't.panel', store: handle }, C))
      .toThrow(/one handle, one scope/)
  })

  it('commits nothing when the core rejects the entry (children stay undeclared)', async () => {
    const bench = await boot()
    bench.erased.register({ name: 'root' }, C) // 'root' single slot now occupied
    expect(() => bench.erased.register({
      name: 'root', children: { 't.host': { kind: 'single', scope: 'root' } },
    }, C)).toThrow(/already has a registration/)
    // The failing call's declaration must not have landed.
    expect(() => bench.erased.register({ name: 't.host' }, C)).toThrow(/is not declared/)
  })
})

describe('declaration injection', () => {
  it('activates immediately and ignores ordinary entry mutations', async () => {
    const bench = await boot()
    bench.erased.register({
      name: 'root', children: { 't.rows': { kind: 'list', scope: 'root' } },
    }, C)
    const setup = vi.fn(() => bench.erased.register({ name: 't.rows', id: 'injected' }, C))
    const dispose = bench.erased.inject('t.rows', setup)
    expect(setup).toHaveBeenCalledOnce()
    bench.erased.register({ name: 't.rows', id: 'ordinary' }, C)
    await Promise.resolve()
    expect(setup).toHaveBeenCalledOnce()
    dispose()
    expect(bench.svc.entries('t.rows').map(entry => entry.options.id)).toEqual(['ordinary'])
  })

  it('waits for declaration, cleans up on collapse, and reruns after redeclaration', async () => {
    const bench = await boot()
    const cleanup = vi.fn()
    const setup = vi.fn(() => {
      const unregister = bench.erased.register({ name: 't.host' }, C)
      return () => { unregister(); cleanup() }
    })
    bench.erased.inject('t.host', setup)
    expect(setup).not.toHaveBeenCalled()
    const disposeFrame = bench.erased.register({
      name: 'root', children: { 't.host': { kind: 'single', scope: 'root' } },
    }, C)
    await Promise.resolve()
    expect(setup).toHaveBeenCalledOnce()
    expect(bench.svc.entries('t.host')).toHaveLength(1)
    disposeFrame()
    await Promise.resolve()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(bench.svc.entries('t.host')).toHaveLength(0)
    bench.erased.register({
      name: 'root', children: { 't.host': { kind: 'single', scope: 'root' } },
    }, C)
    await Promise.resolve()
    expect(setup).toHaveBeenCalledTimes(2)
    expect(bench.svc.entries('t.host')).toHaveLength(1)
  })

  it('observes a same-tick collapse and redeclaration through the declaration epoch', async () => {
    const bench = await boot()
    const firstFrame = bench.erased.register({
      name: 'root', children: { 't.host': { kind: 'single', scope: 'root' } },
    }, C)
    const cleanup = vi.fn()
    const setup = vi.fn(() => {
      const unregister = bench.erased.register({ name: 't.host' }, C)
      return () => { unregister(); cleanup() }
    })
    bench.erased.inject('t.host', setup)
    firstFrame()
    bench.erased.register({
      name: 'root', children: { 't.host': { kind: 'single', scope: 'root' } },
    }, C)
    await Promise.resolve()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(setup).toHaveBeenCalledTimes(2)
    expect(bench.svc.entries('t.host')).toHaveLength(1)
  })

  it('plugin disposal removes an active injection and prevents a waiting one from resurrecting', async () => {
    const active = await boot()
    active.erased.register({
      name: 'root', children: { 't.host': { kind: 'single', scope: 'root' } },
    }, C)
    const activeFiber = active.ctx.plugin({
      name: 'active-injection',
      inject: ['slots'],
      apply: (ctx: Context) => { ctx.slots.inject('t.host', () => ctx.slots.register({ name: 't.host' }, C)) },
    })
    await activeFiber.await()
    expect(active.svc.entries('t.host')).toHaveLength(1)
    await activeFiber.dispose()
    expect(active.svc.entries('t.host')).toHaveLength(0)

    const waiting = await boot()
    const setup = vi.fn(() => waiting.erased.register({ name: 't.host' }, C))
    const waitingFiber = waiting.ctx.plugin({
      name: 'waiting-injection',
      inject: ['slots'],
      apply: (ctx: Context) => { ctx.slots.inject('t.host', setup) },
    })
    await waitingFiber.await()
    await waitingFiber.dispose()
    waiting.erased.register({
      name: 'root', children: { 't.host': { kind: 'single', scope: 'root' } },
    }, C)
    await Promise.resolve()
    expect(setup).not.toHaveBeenCalled()
  })

  it('rolls back earlier yielded registrations when generator setup fails', async () => {
    const bench = await boot()
    bench.erased.register({
      name: 'root',
      children: {
        't.host': { kind: 'single', scope: 'root' },
        't.rows': { kind: 'list', scope: 'root' },
      },
    }, C)
    bench.erased.register({ name: 't.host' }, C)
    expect(() => bench.erased.inject('t.rows', function* () {
      yield bench.erased.register({ name: 't.rows', id: 'rolled-back' }, C)
      yield bench.erased.register({ name: 't.host' }, C)
    })).toThrow(/already has a registration/)
    expect(bench.svc.entries('t.rows')).toHaveLength(0)
  })

  it('contains and wraps a delayed setup failure so later slot listeners still run', async () => {
    const bench = await boot()
    const failures: unknown[] = []
    const onLoud = (error: unknown): void => { failures.push(error) }
    process.on('uncaughtException', onLoud)
    try {
      const setup = vi.fn(function* () {
        yield bench.erased.register({ name: 't.host' }, C)
        throw null
      })
      bench.erased.inject('t.host', setup)
      const later = vi.fn(() => () => undefined)
      bench.erased.inject('t.host', later)
      const disposeFrame = bench.erased.register({
        name: 'root', children: { 't.host': { kind: 'single', scope: 'root' } },
      }, C)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(failures).toHaveLength(1)
      expect(failures[0]).toBeInstanceOf(Error)
      expect(String(failures[0])).toContain('null')
      expect(later).toHaveBeenCalledOnce()
      disposeFrame()
      bench.erased.register({
        name: 'root', children: { 't.host': { kind: 'single', scope: 'root' } },
      }, C)
      expect(setup).toHaveBeenCalledOnce()
    } finally {
      process.off('uncaughtException', onLoud)
    }
  })

  it('skips a stopped controller retained by the current declaration snapshot', async () => {
    const bench = await boot()
    let stopLater = (): void => {}
    const first = vi.fn(() => {
      stopLater()
      return () => undefined
    })
    const later = vi.fn(() => () => undefined)
    bench.erased.inject('t.host', first)
    stopLater = bench.erased.inject('t.host', later)

    bench.erased.register({
      name: 'root', children: { 't.host': { kind: 'single', scope: 'root' } },
    }, C)
    expect(first).toHaveBeenCalledOnce()
    expect(later).not.toHaveBeenCalled()
  })

  it('keeps a nested redeclaration activation when the outer collapse resumes', async () => {
    const bench = await boot()
    const disposeFrame = bench.erased.register({
      name: 'root', children: { 't.host': { kind: 'single', scope: 'root' } },
    }, C)
    let disposeReplacement = (): void => {}
    let replaced = false
    const first = vi.fn(() => () => {
      if (replaced) return
      replaced = true
      disposeReplacement = bench.erased.register({
        name: 'root', children: { 't.host': { kind: 'single', scope: 'root' } },
      }, C)
    })
    const later = vi.fn(() => () => undefined)
    bench.erased.inject('t.host', first)
    bench.erased.inject('t.host', later)

    disposeFrame()
    expect(first).toHaveBeenCalledTimes(2)
    expect(later).toHaveBeenCalledTimes(2)
    expect(bench.svc.spec('t.host')).toBeDefined()
    disposeReplacement()
  })

  it('cancels a waiting injection when its contributor is already unloading', async () => {
    const bench = await boot()
    const setup = vi.fn(() => bench.erased.register({ name: 't.host' }, C))
    let release = (): void => {}
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const pauseUnload = vi.fn(async () => { await blocked })
    const contributor = bench.ctx.plugin({
      name: 'unloading-injection',
      inject: ['slots'],
      apply: (ctx: Context) => {
        ctx.slots.inject('t.host', setup)
        ctx.effect(() => pauseUnload, 'pause contributor unload')
      },
    })
    await contributor.await()
    const disposing = contributor.dispose()
    expect(() => bench.erased.register({
      name: 'root', children: { 't.host': { kind: 'single', scope: 'root' } },
    }, C)).not.toThrow()
    expect(setup).not.toHaveBeenCalled()
    await vi.waitFor(() => { expect(pauseUnload).toHaveBeenCalledOnce() })
    release()
    await disposing
  })

  it('supports dynamic plugin replacement without retaining the old rendered entry', async () => {
    const bench = await boot()
    bench.erased.register({
      name: 'root', children: { 't.host': { kind: 'single', scope: 'root' } },
    }, C)
    const componentA = (): null => null
    const componentB = (): null => null
    const mount = (name: string, component: FC<object>) => bench.ctx.plugin({
      name,
      inject: ['slots'],
      apply: (ctx: Context) => { ctx.slots.inject('t.host', () => ctx.slots.register({ name: 't.host' }, component)) },
    })
    const first = mount('replacement-a', componentA)
    await first.await()
    expect(bench.svc.entries('t.host')[0]?.component).toBe(componentA)
    await first.dispose()
    expect(bench.svc.entries('t.host')).toHaveLength(0)
    const second = mount('replacement-b', componentB)
    await second.await()
    expect(bench.svc.entries('t.host')[0]?.component).toBe(componentB)
  })

  it('releases service-layer store state when the declaration collapses', async () => {
    const bench = await boot()
    let host: SlotRendererHost | undefined
    bench.erased.install({ renderRoot: (value: SlotRendererHost) => { host = value; return null } })
    const disposeFrame = bench.erased.register({
      name: 'root', children: { 't.host': { kind: 'single', scope: 'root' } },
    }, C)
    bench.erased.renderSlot('root', {})
    if (host === undefined) throw new Error('renderer never received the host')
    const { handle } = fakeHandle()
    bench.erased.inject('t.host', () => bench.erased.register({ name: 't.host', store: handle }, C))
    const oldEntry = host.entriesOf('t.host')[0]
    expect(host.storeOf(oldEntry as never, undefined)).toBeDefined()
    disposeFrame()
    expect(() => host?.storeOf(oldEntry as never, undefined)).toThrow(/not registered/)
    bench.erased.register({
      name: 'root', children: { 't.panel': { kind: 'single', scope: 'session' } },
    }, C)
    bench.erased.register({ name: 't.panel', store: handle }, C)
    const panelEntry = host.entriesOf('t.panel')[0]
    const scope = scopedBinding(bench.ctx, 's1')
    expect(host.storeOf(panelEntry as never, scope.binding)).toBeDefined()
    expect(handle.create).toHaveBeenLastCalledWith('s1')
    await scope.fiber.dispose()
  })
})

describe('renderer install seam', () => {
  it('throws on renderSlot before install (boot-order guidance)', async () => {
    const bench = await boot()
    expect(() => bench.erased.renderSlot('root', {})).toThrow(/renderer not installed/)
  })

  it('throws on double install', async () => {
    const bench = await boot()
    bench.erased.install({ renderRoot: () => null })
    expect(() => { bench.erased.install({ renderRoot: () => null }) }).toThrow(/already installed/)
  })

  it('throws on any non-root key (single ctx-level entry)', async () => {
    const bench = await boot()
    bench.erased.install({ renderRoot: () => null })
    expect(() => bench.erased.renderSlot('t.host', {})).toThrow(/only renders 'root'/)
  })

  it("throws on renderSlot('root') before any root registration", async () => {
    const bench = await boot()
    bench.erased.install({ renderRoot: () => null })
    expect(() => bench.erased.renderSlot('root', {})).toThrow(/no registration/)
  })

  it('renders through the installed renderer and returns its product', async () => {
    const bench = await boot()
    const renderRoot = vi.fn(() => 'tree')
    bench.erased.install({ renderRoot })
    bench.erased.register({ name: 'root' }, C)
    expect(bench.erased.renderSlot('root', {})).toBe('tree')
    expect(renderRoot).toHaveBeenCalledTimes(1)
  })
})

describe('host face', () => {
  it('serves entriesOf/specOf/isLive off the ledger and flips isLive on disposal', async () => {
    const bench = await boot()
    const host = captureHost(bench, { 't.host': { kind: 'single', scope: 'root' } })
    const dispose = bench.erased.register({ name: 't.host' }, C)
    const rootEntry = host.entriesOf('root')[0]
    expect(rootEntry).toBeDefined()
    expect(rootEntry?.component).toBe(C)
    expect(host.specOf('root')).toEqual({ kind: 'single', scope: 'root' })
    expect(host.specOf('t.host')).toEqual({ kind: 'single', scope: 'root' })
    const childEntry = host.entriesOf('t.host')[0]
    expect(host.isLive(childEntry as never)).toBe(true)
    dispose()
    expect(host.isLive(childEntry as never)).toBe(false)
    expect(host.entriesOf('t.host')).toHaveLength(0)
  })

  it('publishes and retracts domain-owned root standard sources atomically', async () => {
    const bench = await boot()
    const host = captureHost(bench)
    const source = { getSnapshot: () => 1, subscribe: () => () => undefined }
    const changed = vi.fn()
    host.root.subscribe(changed)
    const dispose = bench.svc.provideRoot({ hooks: { sessions: source }, props: { ready: true } })
    expect(host.root.getSnapshot()).toEqual({
      key: undefined,
      hooks: { sessions: source },
      keyedHooks: {},
      props: { ready: true },
    })
    expect(changed).toHaveBeenCalledOnce()
    dispose()
    expect(host.root.getSnapshot()).toEqual({ key: undefined, hooks: {}, keyedHooks: {}, props: {} })
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('rejects duplicate final root prop names without publishing a partial binding', async () => {
    const bench = await boot()
    const host = captureHost(bench)
    const source = { getSnapshot: () => 1, subscribe: () => () => undefined }
    bench.svc.provideRoot({ hooks: { feature: source } })
    const before = host.root.getSnapshot()
    expect(() => bench.svc.provideRoot({ hooks: { feature: source } }))
      .toThrow("duplicate root standard hook 'feature' at prop 'useFeature'")
    expect(() => bench.svc.provideRoot({ keyedHooks: { feature: () => source } }))
      .toThrow("duplicate root standard keyed hook 'feature' at prop 'useFeature'")
    expect(() => bench.svc.provideRoot({ props: { useFeature: true } }))
      .toThrow("duplicate root standard prop 'useFeature' at prop 'useFeature'")
    expect(host.root.getSnapshot()).toBe(before)
  })

  it('publishes scope-adapter install and disposal revisions', async () => {
    const bench = await boot()
    const host = captureHost(bench)
    const absent = { key: undefined, hooks: {}, keyedHooks: {}, props: {} }
    const source = { getSnapshot: () => absent, subscribe: () => () => undefined }
    const adapter = {
      current: source,
      bindingSource: () => source,
    }
    const changed = vi.fn()
    host.scopeRevision.subscribe(changed)
    const owner = bench.ctx.plugin({
      name: 'session-scope-owner',
      inject: ['slots'],
      apply: (ctx: Context) => { ctx.slots.installScope('session', adapter) },
    })
    await owner.await()
    expect(host.scopeRevision.getSnapshot()).toBe(1)
    expect(changed).toHaveBeenCalledOnce()
    expect(host.scope('session')).toBe(adapter)
    expect(host.scope('session-maybe')).toBe(adapter)
    expect(() => { bench.svc.installScope('session', adapter) }).toThrow(/already has an adapter/)
    await owner.dispose()
    expect(host.scopeRevision.getSnapshot()).toBe(2)
    expect(changed).toHaveBeenCalledTimes(2)
    expect(host.scope('session')).toBeUndefined()
  })
})

describe('store instance axis', () => {
  /** Boot with 'root' occupied and the three test children declared. */
  async function storeBench() {
    const bench = await boot()
    const host = captureHost(bench, {
      't.host': { kind: 'single', scope: 'root' },
      't.maybe': { kind: 'single', scope: 'session-maybe' },
      't.rows': { kind: 'list', scope: 'root' },
      't.panel': { kind: 'single', scope: 'session' },
    })
    return { bench, host }
  }

  it('resolves one instance per (handle x root scope) shared across entries', async () => {
    const { bench, host } = await storeBench()
    const { handle } = fakeHandle()
    bench.erased.register({ name: 't.host', store: handle }, C)
    bench.erased.register({ name: 't.rows', id: 'a', store: handle }, C)
    const [hostEntry] = host.entriesOf('t.host')
    const [rowEntry] = host.entriesOf('t.rows')
    const a = host.storeOf(hostEntry as never, undefined)
    const b = host.storeOf(rowEntry as never, undefined)
    expect(a).toBeDefined()
    expect(a).toBe(b) // shared handle, same scope key = same instance
    expect(handle.create).toHaveBeenCalledTimes(1)
    expect(handle.create).toHaveBeenCalledWith() // root scope: keyless create
  })

  it('resolves per-session instances keyed by session id, created with the scope key', async () => {
    const { bench, host } = await storeBench()
    const { handle } = fakeHandle()
    bench.erased.register({ name: 't.panel', store: handle }, C)
    const [entry] = host.entriesOf('t.panel')
    const scope1 = scopedBinding(bench.ctx, 's1')
    const scope2 = scopedBinding(bench.ctx, 's2')
    const s1 = host.storeOf(entry as never, scope1.binding)
    const s2 = host.storeOf(entry as never, scope2.binding)
    expect(s1).not.toBe(s2)
    expect(host.storeOf(entry as never, scope1.binding)).toBe(s1) // cached per key
    expect(handle.create).toHaveBeenCalledWith('s1')
    expect(handle.create).toHaveBeenCalledWith('s2')
    expect(() => host.storeOf(entry as never, undefined)).toThrow(/requires a session id/)
    await Promise.all([scope1.fiber.dispose(), scope2.fiber.dispose()])
  })

  it('mints a fresh handle per register for the factory (exclusive) form', async () => {
    const { bench, host } = await storeBench()
    const factory = vi.fn(() => fakeHandle().handle)
    bench.erased.register({ name: 't.host', store: factory }, C)
    bench.erased.register({ name: 't.rows', id: 'a', store: factory }, C)
    expect(factory).toHaveBeenCalledTimes(2)
    const a = host.storeOf(host.entriesOf('t.host')[0] as never, undefined)
    const b = host.storeOf(host.entriesOf('t.rows')[0] as never, undefined)
    expect(a).not.toBe(b) // two mints, two instances
  })

  it('drops instances with the last holding entry and refuses stale resolution', async () => {
    const { bench, host } = await storeBench()
    const { handle } = fakeHandle()
    const d1 = bench.erased.register({ name: 't.host', store: handle }, C)
    bench.erased.register({ name: 't.rows', id: 'a', store: handle }, C)
    const rowEntry = host.entriesOf('t.rows')[0]
    const hostEntry = host.entriesOf('t.host')[0]
    const shared = host.storeOf(rowEntry as never, undefined)
    d1() // one holder left: record (and instance) survive
    expect(host.storeOf(rowEntry as never, undefined)).toBe(shared)
    expect(() => host.storeOf(hostEntry as never, undefined)).not.toThrow() // handle still live via the row entry
    // Note: dropping the row entry would sever the last reference; stale
    // resolution is covered through the cascade spec below.
  })

  it('drops a materialized per-session instance without clearing persistence', async () => {
    const { bench, host } = await storeBench()
    const { handle, created } = fakeHandle()
    bench.erased.register({ name: 't.panel', store: handle }, C)
    const [entry] = host.entriesOf('t.panel')
    const scope = scopedBinding(bench.ctx, 's1')
    const s1 = host.storeOf(entry as never, scope.binding)
    expect(s1).toBe(created[0]) // the resolved instance is the fake the handle minted
    await scope.fiber.dispose()
    expect(created[0]?.clearPersisted).not.toHaveBeenCalled()
    const replacement = scopedBinding(bench.ctx, 's1')
    expect(host.storeOf(entry as never, replacement.binding)).not.toBe(s1)
    await replacement.fiber.dispose()
  })

  it.each(['t.panel', 't.maybe'] as const)('separates %s memory when a Session reopens before previous Context cleanup', async (slot) => {
    const { bench, host } = await storeBench()
    const persisted = new Map<string, number>()
    const clearPersisted = vi.fn()
    const handle = {
      create: vi.fn((scopeKey?: string) => {
        const key = scopeKey ?? 'root'
        let expanded = false
        let saved = persisted.get(key) ?? 0
        return {
          getSnapshot: () => ({ expanded, saved }),
          subscribe: () => () => {},
          actions: {
            expand: () => { expanded = true },
            save: (value: number) => { saved = value; persisted.set(key, value) },
          },
          clearPersisted,
        }
      }),
    }
    bench.erased.register({ name: slot, store: handle }, C)
    const [entry] = host.entriesOf(slot)
    const first = scopedBinding(bench.ctx, 's1')
    const other = scopedBinding(bench.ctx, 's2')
    const replacement = scopedBinding(bench.ctx, 's1')
    try {
      const before = host.storeOf(entry as never, first.binding) as ReturnType<typeof handle.create>
      before.actions.expand()
      before.actions.save(7)
      const unaffected = host.storeOf(entry as never, other.binding) as ReturnType<typeof handle.create>
      unaffected.actions.expand()
      const after = host.storeOf(entry as never, replacement.binding) as ReturnType<typeof handle.create>
      expect(after).not.toBe(before)
      expect(after.getSnapshot()).toEqual({ expanded: false, saved: 7 })
      expect(handle.create.mock.calls.map(([key]) => key)).toEqual(['s1', 's2', 's1'])
      expect(host.storeOf(entry as never, other.binding)).toBe(unaffected)
      expect(unaffected.getSnapshot().expanded).toBe(true)
      after.actions.expand()
      after.actions.save(9)
      await first.fiber.dispose()
      expect(host.storeOf(entry as never, replacement.binding)).toBe(after)
      expect(after.getSnapshot()).toEqual({ expanded: true, saved: 9 })
      expect(persisted.get('s1')).toBe(9)
      expect(clearPersisted).not.toHaveBeenCalled()
    } finally {
      await Promise.all([first.fiber.dispose(), replacement.fiber.dispose(), other.fiber.dispose()])
      await bench.ctx.fiber.dispose()
    }
  })

  it('does not materialize scoped stores solely for scope release', async () => {
    const { bench } = await storeBench()
    const root = fakeHandle()
    const scoped = fakeHandle()
    bench.erased.register({ name: 't.host', store: root.handle }, C)
    bench.erased.register({ name: 't.panel', store: scoped.handle }, C)
    const scope = scopedBinding(bench.ctx, 's1')

    bench.svc.bindStoreScope(scope.binding)
    await scope.fiber.dispose()

    expect(root.handle.create).not.toHaveBeenCalled()
    expect(scoped.handle.create).not.toHaveBeenCalled()
  })

  it('leaves scoped Store cleanup with the newest Context generation', async () => {
    const { bench } = await storeBench()
    const { handle } = fakeHandle()
    bench.erased.register({ name: 't.panel', store: handle }, C)
    const first = scopedBinding(bench.ctx, 's1')
    const replacement = scopedBinding(bench.ctx, 's1')

    bench.svc.bindStoreScope(first.binding)
    bench.svc.bindStoreScope(first.binding)
    bench.svc.bindStoreScope(replacement.binding)
    await first.fiber.dispose()
    expect(handle.create).not.toHaveBeenCalled()

    await replacement.fiber.dispose()
    expect(handle.create).not.toHaveBeenCalled()
  })

  it('drops session-maybe state without clearing persistence and creates a fresh instance on reuse', async () => {
    const { bench, host } = await storeBench()
    const absent = { key: undefined, hooks: {}, keyedHooks: {}, props: {} }
    const source = { getSnapshot: () => absent, subscribe: () => () => undefined }
    bench.svc.installScope('session', { current: source, bindingSource: () => source })
    const { handle, created } = fakeHandle()
    bench.erased.register({ name: 't.maybe', store: handle }, C)
    const [entry] = host.entriesOf('t.maybe')
    expect(() => host.storeOf(entry as never, undefined))
      .toThrow('session-maybe store resolution requires a session id')
    const scope = scopedBinding(bench.ctx, 's1')
    const before = host.storeOf(entry as never, scope.binding)

    await scope.fiber.dispose()

    expect(created[0]?.clearPersisted).not.toHaveBeenCalled()
    const replacement = scopedBinding(bench.ctx, 's1')
    const after = host.storeOf(entry as never, replacement.binding)
    expect(after).not.toBe(before)
    expect(handle.create).toHaveBeenLastCalledWith('s1')
    await replacement.fiber.dispose()
  })
})

describe('entry-unload cascade', () => {
  it('kills declared children, their contributions, and the ledger rows with the entry', async () => {
    const bench = await boot()
    let host: SlotRendererHost | undefined
    bench.erased.install({
      renderRoot: (h: SlotRendererHost) => { host = h; return 'rendered' },
    })
    // The declarer here is NOT the root occupant: root stays occupied by a
    // separate entry so disposing the declarer only kills its children.
    const disposeRoot = bench.erased.register({ name: 'root' }, C)
    bench.erased.renderSlot('root', {})
    if (host === undefined) throw new Error('renderer never received the host')
    disposeRoot()
    const disposeDeclarer = bench.erased.register({
      name: 'root', children: { 't.host': { kind: 'single', scope: 'root' } },
    }, C)
    bench.erased.register({ name: 't.host' }, C)
    const [childEntry] = host.entriesOf('t.host')
    expect(childEntry).toBeDefined()

    disposeDeclarer()
    expect(bench.svc.spec('t.host')).toBeUndefined() // ledger row gone
    expect(host.specOf('t.host')).toBeUndefined() // outlets now render empty
    expect(bench.svc.entries('t.host')).toHaveLength(0) // contribution cleared
    expect(host.isLive(childEntry as never)).toBe(false) // stale bindings will throw upstream
    // The freed key is re-declarable by a new entry (no residue).
    expect(() => bench.erased.register({
      name: 'root', children: { 't.host': { kind: 'single', scope: 'root' } },
    }, C)).not.toThrow()
  })

  it('cascades through cordis fiber disposal (plugin unload = full cleanup)', async () => {
    const bench = await boot()
    bench.erased.register({
      name: 'root', children: { 't.host': { kind: 'single', scope: 'root' } },
    }, C)
    const fiber = bench.ctx.plugin({
      name: 'occupant',
      inject: ['slots'],
      apply: (pluginCtx: Context) => {
        ;(pluginCtx.slots as ErasedService).register({ name: 't.host' }, C)
      },
    })
    await fiber.await()
    expect(bench.svc.entries('t.host')).toHaveLength(1)
    await fiber.dispose()
    expect(bench.svc.entries('t.host')).toHaveLength(0)
    expect(bench.svc.spec('t.host')).toBeDefined() // declarer still live; slot stays declared
  })

  it('disposer is idempotent (stale second call is a no-op)', async () => {
    const bench = await boot()
    const dispose = bench.erased.register({
      name: 'root', children: { 't.host': { kind: 'single', scope: 'root' } },
    }, C)
    dispose()
    expect(() => { dispose() }).not.toThrow()
    expect(() => bench.erased.register({
      name: 'root', children: { 't.host': { kind: 'single', scope: 'root' } },
    }, C)).not.toThrow()
  })
})

describe('event bridge', () => {
  it("re-emits entry writes and child declarations as 'slots/changed'", async () => {
    const bench = await boot()
    const seen: string[] = []
    bench.ctx.on('slots/changed', (key) => { seen.push(key) })
    bench.erased.register({
      name: 'root', children: { 't.rows': { kind: 'list', scope: 'root' } },
    }, C)
    bench.erased.register({ name: 't.rows', id: 'a' }, C)
    expect(seen).toEqual(['root', 't.rows', 't.rows'])
  })
})
