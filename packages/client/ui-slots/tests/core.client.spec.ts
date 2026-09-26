import { describe, expect, it, vi } from 'vitest'
import type { SlotComponent, StoreHandle } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

// 'root' is NOT merged here: ui-renderer owns the built-in row, and
// the client aggregate program would see both merges collide.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'test.single': { kind: 'single'; scope: 'root' }
    'test.session': { kind: 'single'; scope: 'session' }
    'test.list': { kind: 'list'; scope: 'root' }
    'test.keyed': { kind: 'keyed'; scope: 'session' }
    'test.chain': { kind: 'chain'; scope: 'session'; owner: { tags: string[] } }
    'test.grandchild': { kind: 'single'; scope: 'root' }
  }
}

// Wide-accepting fixture: assignable wherever the composed constraint is an
// object type (children-declaring fixtures erase via `as never` instead —
// RendersCheck would demand a renderSlot consumer).
const Comp: SlotComponent<object> = () => null

function fakeHandle(): StoreHandle<{ n: number }, Record<string, (d: { n: number }) => void>> {
  return {
    spec: { init: () => ({ n: 0 }), actions: {} },
    create: () => { throw new Error('not under test') },
  }
}

function mountFrame(core: SlotCore) {
  return core.register({
    name: 'root',
    children: {
      'test.single': { kind: 'single', scope: 'root' },
      'test.session': { kind: 'single', scope: 'session' },
      'test.list': { kind: 'list', scope: 'root' },
      'test.keyed': { kind: 'keyed', scope: 'session' },
      'test.chain': { kind: 'chain', scope: 'session' },
    },
  // Type-level renderSlot presence is proven by the type-chain spec; erasing
  // here keeps runtime fixtures terse.
  }, Comp as never)
}

const flushMicrotasks = () => new Promise<void>((resolve) => { queueMicrotask(resolve) })

describe('a-priori root and declaration gate', () => {
  it('seeds root as single/root at construction', () => {
    const core = new SlotCore()
    expect(core.specDynamic('root')).toEqual({ kind: 'single', scope: 'root' })
  })

  it('throws on registering into an undeclared slot', () => {
    const core = new SlotCore()
    expect(() => core.register({ name: 'test.single' }, Comp)).toThrow('not declared')
  })

  it('root is single: a second frame registration throws', () => {
    const core = new SlotCore()
    mountFrame(core)
    expect(() => core.register({ name: 'root' }, Comp)).toThrow('already has a registration')
  })

  it('children declaration makes child slots registerable, with specs recorded', () => {
    const core = new SlotCore()
    mountFrame(core)
    expect(core.specDynamic('test.session')).toEqual({ kind: 'single', scope: 'session' })
    expect(() => core.register({ name: 'test.single' }, Comp)).not.toThrow()
  })

  it('duplicate child declaration throws naming the first declarer', () => {
    const core = new SlotCore()
    mountFrame(core)
    core.register({ name: 'test.single', children: { 'test.grandchild': { kind: 'single', scope: 'root' } } }, Comp as never)
    expect(() => core.register(
      { name: 'test.session', children: { 'test.grandchild': { kind: 'single', scope: 'root' } }, registrant: 'imposter' },
      Comp as never,
    )).toThrow(/already declared.*test\.single/)
  })
})

describe('lifecycle cascade (one axis)', () => {
  it('publishes Factory child mutations only after every sibling declaration is installed', () => {
    const core = new SlotCore()
    const observed: unknown[] = []
    core.onMutate((key) => {
      if (key === 'test.single') observed.push(core.specDynamic('test.session'))
    })
    const registerFactory = core.registerFactory as (
      options: object,
      component: unknown,
    ) => () => void

    registerFactory({
      name: 'test.atomic-factory',
      scope: 'root',
      children: {
        'test.single': { kind: 'single', scope: 'root' },
        'test.session': { kind: 'single', scope: 'session' },
      },
    }, Comp)

    expect(observed).toEqual([{ kind: 'single', scope: 'session' }])
  })

  it('disposing a declaring entry collapses child slots and their contributions recursively', () => {
    const core = new SlotCore()
    const disposeFrame = mountFrame(core)
    const disposeChild = core.register(
      { name: 'test.single', children: { 'test.grandchild': { kind: 'single', scope: 'root' } } }, Comp as never)
    core.register({ name: 'test.grandchild' }, Comp)
    expect(core.entries('test.grandchild')).toHaveLength(1)

    disposeFrame()
    expect(core.specDynamic('test.single')).toBeUndefined()
    expect(core.specDynamic('test.grandchild')).toBeUndefined()
    expect(core.entries('test.single')).toHaveLength(0)
    expect(core.entries('test.grandchild')).toHaveLength(0)
    // Stale disposer of a cascaded-away entry is a no-op.
    expect(() => { disposeChild() }).not.toThrow()
    // Slots return to undeclared: contributing again throws until redeclared.
    expect(() => core.register({ name: 'test.single' }, Comp)).toThrow('not declared')
  })

  it('registration disposers are idempotent', () => {
    const core = new SlotCore()
    const dispose = mountFrame(core)
    dispose()
    dispose()
    expect(core.entries('root')).toHaveLength(0)
    // Redeclare works after collapse.
    mountFrame(core)
    expect(core.specDynamic('test.single')).toBeDefined()
  })

  it('isLive tracks ledger membership across dispose', () => {
    const core = new SlotCore()
    mountFrame(core)
    const dispose = core.register({ name: 'test.single' }, Comp)
    const entry = core.entries('test.single')[0]!
    expect(core.isLive(entry)).toBe(true)
    dispose()
    expect(core.isLive(entry)).toBe(false)
  })
})

describe('kind semantics', () => {
  it('keyed: duplicate key throws, missing key throws', () => {
    const core = new SlotCore()
    mountFrame(core)
    core.register({ name: 'test.keyed', key: 'a' }, Comp)
    expect(() => core.register({ name: 'test.keyed', key: 'a' }, Comp)).toThrow('key "a"')
    // Statically rejected (KindOptions); runtime guard stays for dynamic callers.
    // @ts-expect-error keyed registration requires options.key
    expect(() => core.register({ name: 'test.keyed' }, Comp)).toThrow('requires options.key')
    expect(() => core.register({ name: 'test.keyed', key: 'b' }, Comp)).not.toThrow()
  })

  it('list: duplicate id throws, missing id throws, entries sort by order stably', () => {
    const core = new SlotCore()
    mountFrame(core)
    core.register({ name: 'test.list', id: 'c', order: 10 }, Comp)
    core.register({ name: 'test.list', id: 'a' }, Comp)
    core.register({ name: 'test.list', id: 'b' }, Comp)
    expect(() => core.register({ name: 'test.list', id: 'a' }, Comp)).toThrow('id "a"')
    // @ts-expect-error list registration requires options.id
    expect(() => core.register({ name: 'test.list' }, Comp)).toThrow('requires options.id')
    expect(core.entries('test.list').map(e => e.options.id)).toEqual(['a', 'b', 'c'])
  })

  it('chain: missing select throws; select and priority land on the stored entry', () => {
    const core = new SlotCore()
    mountFrame(core)
    // Statically rejected (KindOptions); runtime guard stays for dynamic callers.
    // @ts-expect-error chain registration requires options.select
    expect(() => core.register({ name: 'test.chain' }, Comp)).toThrow('requires options.select')
    const select = ({ tags }: { tags: string[] }) => tags[0] ?? null
    core.register({ name: 'test.chain', select, priority: 5 }, Comp as never)
    const entry = core.entries('test.chain')[0]!
    expect(entry.select).toBe(select)
    expect(entry.options.priority).toBe(5)
  })

  it('chain: entries sort by priority ascending, ties keep registration order', () => {
    const core = new SlotCore()
    mountFrame(core)
    const sel = () => null
    core.register({ name: 'test.chain', select: sel, priority: 10, registrant: 'late' }, Comp as never)
    core.register({ name: 'test.chain', select: sel, registrant: 'default-a' }, Comp as never)
    core.register({ name: 'test.chain', select: sel, registrant: 'default-b' }, Comp as never)
    core.register({ name: 'test.chain', select: sel, priority: -1, registrant: 'first' }, Comp as never)
    expect(core.entries('test.chain').map(e => e.registrant))
      .toEqual(['first', 'default-a', 'default-b', 'late'])
  })

  it('single: second registration throws, disposer frees the seat', () => {
    const core = new SlotCore()
    mountFrame(core)
    const dispose = core.register({ name: 'test.single' }, Comp)
    expect(() => core.register({ name: 'test.single' }, Comp)).toThrow('already has a registration')
    dispose()
    expect(core.entries('test.single')).toHaveLength(0)
    expect(() => core.register({ name: 'test.single' }, Comp)).not.toThrow()
  })
})

describe('store scope pinning', () => {
  it('one shared handle under two scopes throws at load', () => {
    const core = new SlotCore()
    mountFrame(core)
    const handle = fakeHandle()
    core.register({ name: 'test.session', store: handle }, Comp as never)
    expect(() => core.register({ name: 'test.single', store: handle }, Comp as never))
      .toThrow('one handle, one scope')
  })

  it('same handle under same scope is fine; full unmount releases the pin', () => {
    const core = new SlotCore()
    mountFrame(core)
    const handle = fakeHandle()
    const d1 = core.register({ name: 'test.list', id: 'x', store: handle }, Comp as never)
    const d2 = core.register({ name: 'test.list', id: 'y', store: handle }, Comp as never)
    d1()
    // Still mounted once — scope stays pinned.
    expect(() => core.register({ name: 'test.session', store: handle }, Comp as never))
      .toThrow('one handle, one scope')
    d2()
    // All mounts gone: the handle may pin a new scope.
    expect(() => core.register({ name: 'test.session', store: handle }, Comp as never)).not.toThrow()
  })

  it('factories are exempt from pinning (no shared identity)', () => {
    const core = new SlotCore()
    mountFrame(core)
    const factory = () => fakeHandle()
    core.register({ name: 'test.session', store: factory }, Comp as never)
    expect(() => core.register({ name: 'test.single', store: factory }, Comp as never)).not.toThrow()
  })

  it('cascade releases store pins of collapsed child entries', () => {
    const core = new SlotCore()
    const disposeFrame = mountFrame(core)
    const handle = fakeHandle()
    core.register({ name: 'test.session', store: handle }, Comp as never)
    disposeFrame()
    mountFrame(core)
    expect(() => core.register({ name: 'test.single', store: handle }, Comp as never)).not.toThrow()
  })
})

describe('subscription API', () => {
  it('tracks declaration epochs separately from ordinary entry mutations', () => {
    const core = new SlotCore()
    expect(core.declarationEpoch('root')).toBe(1)
    expect(core.declarationEpoch('test.list')).toBe(0)
    const disposeFrame = mountFrame(core)
    const declared = core.declarationEpoch('test.list')
    expect(declared).toBe(1)
    const disposeEntry = core.register({ name: 'test.list', id: 'a' }, Comp)
    disposeEntry()
    expect(core.declarationEpoch('test.list')).toBe(declared)
    disposeFrame()
    expect(core.declarationEpoch('test.list')).toBe(declared + 1)
    mountFrame(core)
    expect(core.declarationEpoch('test.list')).toBe(declared + 2)
  })

  it('entries() returns a stable cached reference between mutations', () => {
    const core = new SlotCore()
    mountFrame(core)
    core.register({ name: 'test.list', id: 'a' }, Comp)
    const first = core.entries('test.list')
    expect(core.entries('test.list')).toBe(first)
    core.register({ name: 'test.list', id: 'b' }, Comp)
    expect(core.entries('test.list')).not.toBe(first)
  })

  it('bumps version synchronously but batches notifications per microtask', async () => {
    const core = new SlotCore()
    mountFrame(core)
    const fn = vi.fn()
    core.subscribe('test.list', fn)
    const before = core.getVersion('test.list')
    core.register({ name: 'test.list', id: 'a' }, Comp)
    core.register({ name: 'test.list', id: 'b' }, Comp)
    expect(core.getVersion('test.list')).toBe(before + 2)
    expect(fn).not.toHaveBeenCalled()
    await flushMicrotasks()
    expect(fn).toHaveBeenCalledTimes(1)
    core.register({ name: 'test.list', id: 'c' }, Comp)
    await flushMicrotasks()
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('declaration itself notifies child-key subscribers (subscribe-ahead allowed)', async () => {
    const core = new SlotCore()
    const fn = vi.fn()
    core.subscribe('test.single', fn)
    mountFrame(core)
    await flushMicrotasks()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('notifies declaration subscribers synchronously, excluding entries, until unsubscribe', () => {
    const core = new SlotCore()
    const fn = vi.fn()
    const unsubscribe = core.subscribeDeclaration('test.list', fn)
    const disposeFrame = mountFrame(core)
    expect(fn).toHaveBeenCalledTimes(1)
    core.register({ name: 'test.list', id: 'ordinary' }, Comp)
    expect(fn).toHaveBeenCalledTimes(1)
    disposeFrame()
    expect(fn).toHaveBeenCalledTimes(2)
    unsubscribe()
    mountFrame(core)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('commits sibling declarations before notifying declaration subscribers', () => {
    const core = new SlotCore()
    let duplicateDeclaration: unknown
    const unsubscribe = core.subscribeDeclaration('test.single', () => {
      core.register({ name: 'test.list', id: 'from-listener' }, Comp)
      try {
        core.register({
          name: 'test.single',
          children: { 'test.list': { kind: 'list', scope: 'root' } },
        }, Comp as never)
      } catch (error) {
        duplicateDeclaration = error
      }
    })

    const disposeFrame = mountFrame(core)
    expect(core.entries('test.list')).toHaveLength(1)
    expect(String(duplicateDeclaration)).toContain('already declared')
    unsubscribe()
    disposeFrame()
    expect(core.specDynamic('test.list')).toBeUndefined()
  })

  it('notifies only subscribers of the touched key; unsubscribe stops delivery', async () => {
    const core = new SlotCore()
    mountFrame(core)
    await flushMicrotasks()
    const single = vi.fn()
    const list = vi.fn()
    core.subscribe('test.single', single)
    const unsubscribe = core.subscribe('test.list', list)
    core.register({ name: 'test.single' }, Comp)
    await flushMicrotasks()
    expect(single).toHaveBeenCalledTimes(1)
    expect(list).not.toHaveBeenCalled()
    unsubscribe()
    core.register({ name: 'test.list', id: 'a' }, Comp)
    await flushMicrotasks()
    expect(list).not.toHaveBeenCalled()
  })

  it('a mutation from inside a flush re-schedules instead of being lost', async () => {
    const core = new SlotCore()
    mountFrame(core)
    await flushMicrotasks()
    const seen: number[] = []
    let reentered = false
    core.subscribe('test.list', () => {
      seen.push(core.getVersion('test.list'))
      if (!reentered) {
        reentered = true
        core.register({ name: 'test.list', id: 'reentrant' }, Comp)
      }
    })
    core.register({ name: 'test.list', id: 'a' }, Comp)
    await flushMicrotasks()
    await flushMicrotasks()
    expect(seen).toHaveLength(2)
    expect(core.entries('test.list')).toHaveLength(2)
  })

  it('getVersion is 0 for untouched keys and monotonic across redeclaration', () => {
    const core = new SlotCore()
    expect(core.getVersion('test.single')).toBe(0)
    const dispose = mountFrame(core)
    dispose()
    const after = core.getVersion('test.single')
    mountFrame(core)
    expect(core.getVersion('test.single')).toBeGreaterThan(after)
  })

  it('onMutate fires synchronously per mutation with the touched key', () => {
    const core = new SlotCore()
    const keys: string[] = []
    const off = core.onMutate(key => keys.push(key))
    mountFrame(core)
    // Contribution first, then each declared child key.
    expect(keys).toEqual(['root', 'test.single', 'test.session', 'test.list', 'test.keyed', 'test.chain'])
    keys.length = 0
    core.register({ name: 'test.list', id: 'a' }, Comp)
    expect(keys).toEqual(['test.list'])
    off()
    core.register({ name: 'test.list', id: 'b' }, Comp)
    expect(keys).toHaveLength(1)
  })
})
