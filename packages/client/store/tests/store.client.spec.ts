import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore, defineStore, shallowEqual } from '../src/client/index.ts'

interface State {
  a: { n: number }
  b: { list: string[] }
}

const init = (): State => ({ a: { n: 1 }, b: { list: ['x'] } })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('createSnapshotStore', () => {
  it('applies update through a draft and preserves untouched branch references', () => {
    const store = createSnapshotStore(init())
    const before = store.getSnapshot()
    store.update((d) => { d.a.n = 2 })
    const after = store.getSnapshot()
    expect(after).not.toBe(before)
    expect(after.a.n).toBe(2)
    expect(after.b).toBe(before.b)
  })

  it('notifies synchronously per update by default', () => {
    const store = createSnapshotStore(init())
    const seen: number[] = []
    store.subscribe(() => { seen.push(store.getSnapshot().a.n) })
    store.update((d) => { d.a.n = 2 })
    store.update((d) => { d.a.n = 3 })
    expect(seen).toEqual([2, 3])
  })

  it('coalesces a frame of updates into one notification in raf mode', () => {
    const frame: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frame.push(cb)
      return frame.length
    })
    const store = createSnapshotStore(init(), { flush: 'raf' })
    const spy = vi.fn()
    store.subscribe(spy)
    store.update((d) => { d.a.n = 2 })
    store.update((d) => { d.a.n = 3 })
    store.update((d) => { d.b.list.push('y') })
    expect(spy).not.toHaveBeenCalled()
    expect(frame).toHaveLength(1)
    frame.shift()!(0)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().a.n).toBe(3)
    // Next frame batches independently.
    store.update((d) => { d.a.n = 4 })
    expect(frame).toHaveLength(1)
    frame.shift()!(0)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('falls back to microtask batching in raf mode without requestAnimationFrame', async () => {
    const store = createSnapshotStore(init(), { flush: 'raf' })
    const spy = vi.fn()
    store.subscribe(spy)
    store.update((d) => { d.a.n = 2 })
    store.update((d) => { d.a.n = 3 })
    expect(spy).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes raf-mode listeners', () => {
    const frame: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frame.push(cb)
      return frame.length
    })
    const store = createSnapshotStore(init(), { flush: 'raf' })
    const spy = vi.fn()
    const off = store.subscribe(spy)
    store.update((d) => { d.a.n = 2 })
    off()
    frame.shift()!(0)
    expect(spy).not.toHaveBeenCalled()
  })

  it('replaces state wholesale via set and freezes it outside production', () => {
    const store = createSnapshotStore(init())
    const next = init()
    store.set(next)
    expect(store.getSnapshot()).toBe(next)
    expect(() => { (store.getSnapshot().a).n = 9 }).toThrow()
  })

  it('freezes the owned envelope without traversing opaque object handles', () => {
    class OpaqueHandle {
      readonly value = { n: 1 }
    }
    const handle = new OpaqueHandle()
    const store = createSnapshotStore({ handle, values: new Set(['x']) })

    store.set({ handle, values: new Set(['y']) })

    const snapshot = store.getSnapshot()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.handle)).toBe(false)
    expect(() => { snapshot.values.add('z') }).toThrow()
  })

  it('freezes update produce output outside production (immer dev freeze)', () => {
    const store = createSnapshotStore(init())
    store.update((d) => { d.a.n = 2 })
    expect(() => { (store.getSnapshot().a).n = 9 }).toThrow()
  })

  it('does not deep-freeze wholesale state in production', () => {
    vi.stubEnv('NODE_ENV', 'production')
    const store = createSnapshotStore(init())
    const next = init()
    store.set(next)

    next.a.n = 9
    expect(store.getSnapshot().a.n).toBe(9)
  })

  it('rehydrates primitive state whole, not spread into index keys', () => {
    const backing = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => { backing.set(k, v) },
      removeItem: (k: string) => { backing.delete(k) },
    })
    const store = createSnapshotStore<string>('', { persist: { name: 'spec-draft' } })
    store.set('hello')
    const revived = createSnapshotStore<string>('', { persist: { name: 'spec-draft' } })
    expect(revived.getSnapshot()).toBe('hello')
  })

  it('persists to localStorage under the given name and rehydrates', () => {
    const backing = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => { backing.set(k, v) },
      removeItem: (k: string) => { backing.delete(k) },
    })
    const store = createSnapshotStore(init(), { persist: { name: 'spec-store' } })
    store.update((d) => { d.a.n = 42 })
    expect(backing.has('spec-store')).toBe(true)
    const revived = createSnapshotStore(init(), { persist: { name: 'spec-store' } })
    expect(revived.getSnapshot().a.n).toBe(42)
  })

  it('reports rehydration failures without preventing store creation', () => {
    const failure = new Error('storage read failed')
    vi.stubGlobal('localStorage', {
      getItem: () => { throw failure },
      setItem: () => {},
      removeItem: () => {},
    })
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})

    const store = createSnapshotStore(init(), { persist: { name: 'spec-broken-read' } })

    expect(store.getSnapshot()).toEqual(init())
    expect(report).toHaveBeenCalledWith(
      "snapshot store 'spec-broken-read' rehydration failed:",
      failure,
    )
  })

  it('reports persistence failures without rejecting the write', () => {
    const failure = new Error('storage write failed')
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw failure },
      removeItem: () => {},
    })
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = createSnapshotStore(init(), { persist: { name: 'spec-broken-write' } })

    expect(() => { store.update((draft) => { draft.a.n = 7 }) }).not.toThrow()
    expect(store.getSnapshot().a.n).toBe(7)
    expect(report).toHaveBeenCalledWith(
      "snapshot store 'spec-broken-write' persistence failed:",
      failure,
    )
  })
})

describe('defineStore', () => {
  const declare = () => defineStore({
    init: () => ({ selection: null as string | null, draft: '' }),
    actions: {
      select: (d, target: string) => { d.selection = target },
      setDraft: (d, text: string) => { d.draft = text },
      clearDraft: (d) => { d.draft = '' },
    },
  })

  it('create() yields a live instance: fresh init state, selector-visible action writes', () => {
    const inst = declare().create()
    expect(inst.getSnapshot()).toEqual({ selection: null, draft: '' })
    const listener = vi.fn()
    const unsubscribe = inst.subscribe(listener)
    inst.actions.setDraft('hello')
    inst.actions.select('m1')
    expect(inst.store.getSnapshot()).toEqual({ selection: 'm1', draft: 'hello' })
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    inst.actions.clearDraft()
    expect(inst.store.getSnapshot().draft).toBe('')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('bakes draft-stripped actions that write through update (draft mutation, not replacement)', () => {
    const inst = declare().create()
    const before = inst.store.getSnapshot()
    inst.actions.setDraft('x')
    const after = inst.store.getSnapshot()
    expect(after).not.toBe(before)
    expect(after.selection).toBe(before.selection)   // untouched branch preserved (immer path)
  })

  it('creates independent instances per create() call (the handle is a spec, not a singleton)', () => {
    const handle = declare()
    const a = handle.create()
    const b = handle.create()
    a.actions.setDraft('only-a')
    expect(b.store.getSnapshot().draft).toBe('')
  })

  it('suffixes the persist key with the scope key: per-session persistence plus clearPersisted cleanup', () => {
    const backing = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => { backing.set(k, v) },
      removeItem: (k: string) => { backing.delete(k) },
    })
    const handle = defineStore({
      init: () => ({ draft: '' }),
      persist: 'spec.chat',
      actions: { setDraft: (d, text: string) => { d.draft = text } },
    })
    handle.create('s1').actions.setDraft('one')
    handle.create('s2').actions.setDraft('two')
    handle.create().actions.setDraft('root')
    expect(JSON.parse(backing.get('spec.chat.s1')!)).toEqual({ draft: 'one' })
    expect(JSON.parse(backing.get('spec.chat.s2')!)).toEqual({ draft: 'two' })
    expect(JSON.parse(backing.get('spec.chat')!)).toEqual({ draft: 'root' })
    // Rehydration honors the same suffixed key.
    expect(handle.create('s1').store.getSnapshot().draft).toBe('one')
    // Scope-death cleanup removes exactly the suffixed key.
    handle.create('s1').clearPersisted()
    expect(backing.has('spec.chat.s1')).toBe(false)
    expect(backing.has('spec.chat.s2')).toBe(true)
    expect(backing.has('spec.chat')).toBe(true)
  })

  it('clearPersisted is a no-op without a persist declaration or without storage', () => {
    const inst = declare().create('s1')   // no persist key declared
    expect(() => { inst.clearPersisted() }).not.toThrow()
    const persisting = defineStore({
      init: () => ({ n: 0 }),
      persist: 'spec.nostorage',
      actions: { inc: (d) => { d.n += 1 } },
    }).create()
    // jsdom-less lane: localStorage may exist here, so simulate its absence.
    vi.stubGlobal('localStorage', undefined)
    expect(() => { persisting.clearPersisted() }).not.toThrow()
  })

  it('swallows storage failures in clearPersisted (same non-fatal contract as persistence)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => { throw new Error('quota / private mode') },
    })
    const inst = defineStore({
      init: () => ({ n: 0 }),
      persist: 'spec.throwing',
      actions: { inc: (d) => { d.n += 1 } },
    }).create()
    expect(() => { inst.clearPersisted() }).not.toThrow()
  })
})

describe('shallowEqual', () => {
  it('matches one-level-equal objects and rejects deeper drift', () => {
    const leaf = { deep: 1 }
    expect(shallowEqual({ x: 1, y: leaf }, { x: 1, y: leaf })).toBe(true)
    expect(shallowEqual({ x: 1, y: { deep: 1 } }, { x: 1, y: { deep: 1 } })).toBe(false)
    expect(shallowEqual([1, 2], [1, 2])).toBe(true)
    expect(shallowEqual([1, 2], [2, 1])).toBe(false)
    expect(shallowEqual({ x: 1 }, { x: 1, y: 2 })).toBe(false)
    expect(shallowEqual({ x: undefined }, { y: undefined })).toBe(false)
  })

  it('compares scalars by Object.is and never equates an object with a scalar', () => {
    expect(shallowEqual(Number.NaN, Number.NaN)).toBe(true)
    expect(shallowEqual(0, -0)).toBe(false)
    expect(shallowEqual('a', 'a')).toBe(true)
    expect(shallowEqual({}, null)).toBe(false)
    expect(shallowEqual(null, {})).toBe(false)
    expect(shallowEqual(1, {})).toBe(false)
  })

  it('compares Map entries and Set members one level deep', () => {
    const leaf = { deep: 1 }
    expect(shallowEqual(new Map([['a', leaf]]), new Map([['a', leaf]]))).toBe(true)
    expect(shallowEqual(new Map([['a', 1]]), new Map([['a', 2]]))).toBe(false)
    expect(shallowEqual(new Map([['a', leaf]]), new Map([['a', { deep: 1 }]]))).toBe(false)
    expect(shallowEqual(new Map([['a', 1]]), new Map([['a', 1], ['b', 2]]))).toBe(false)
    expect(shallowEqual(new Map([['a', undefined]]), new Map([['b', undefined]]))).toBe(false)
    expect(shallowEqual(new Set([1, leaf]), new Set([leaf, 1]))).toBe(true)
    expect(shallowEqual(new Set([1]), new Set([2]))).toBe(false)
    expect(shallowEqual(new Set([1]), new Set([1, 2]))).toBe(false)
    expect(shallowEqual(new Map([['a', 1]]), { a: 1 })).toBe(false)
  })

  it('recognizes Maps and Sets another realm built', () => {
    // An isolated plugin's iframe returns collections whose prototypes belong to that realm.
    const map = (entries: string): unknown => runInNewContext(`new Map(${entries})`)
    const set = (members: string): unknown => runInNewContext(`new Set(${members})`)
    expect(shallowEqual(map('[[1, 1]]'), map('[[1, 2]]'))).toBe(false)
    expect(shallowEqual(map('[[1, 1]]'), map('[[2, 1]]'))).toBe(false)
    expect(shallowEqual(map('[[1, "a"]]'), new Map([[1, 'a']]))).toBe(true)
    expect(shallowEqual(set('[1]'), set('[2]'))).toBe(false)
    expect(shallowEqual(set('[1, 2]'), new Set([2, 1]))).toBe(true)
  })
})
