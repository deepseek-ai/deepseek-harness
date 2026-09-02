// @vitest-environment jsdom
/**
 * createSlotRenderer machinery account over a behavioral fake host: root
 * outlet + per-kind child outlets, standard-kit synthesis (renderSlot
 * binding, session pair, global useSessions, store pair), inject execution
 * point (inside component bodies, contained per entry) and parameter
 * derivation, and cache granularity (entry x scope key). Ledger semantics
 * (declaration conflicts, store instance accounting) belong to the renderer
 * SlotRegistry suite, not here.
 */
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { useEffect, useState, type ReactNode } from 'react'
import { Context } from '@deepseek-ai/cordis'
import {
  SlotOwnershipError, StaleAuthorizationError,
  type ActionsDecl, type SessionProviderComponent, type SlotEntryDef,
  type SlotSpec, type StoreHandle, type StoredEntry,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {
  RenderOpts, ScopedStandardSourceBinding, SlotRendererHost, SlotScopeAdapter,
  StandardSourceBinding, StoreInstanceLike,
} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createSlotRenderer } from '../src/client/scoped-slots.tsx'

type AnyProps = Record<string, unknown>
type RenderSlotFn = (key: string, owner: object, opts?: RenderOpts) => ReactNode
type RenderSlotChainFn = (
  key: string,
  owner: object,
  opts?: { fallback?: ReactNode; fallbackOnly?: boolean; overlay?: boolean },
) => ReactNode
type DeclaredSpec = SlotSpec<SlotEntryDef>
/** Entry literal helper: fake entries default the mandatory options bag. */
const entryOf = (partial: Omit<StoredEntry, 'options'> & { options?: StoredEntry['options'] }): StoredEntry =>
  ({ options: {}, ...partial })

/**
 * Minimal store handle satisfying the StoreDecl contract shape (spec +
 * create(scopeKey?) + instance with clearPersisted): the machinery consumes
 * only the StoreInstanceLike face (bare snapshot source + baked actions),
 * but entry.store is typed to the full contract — the real defineStore lives
 * in client-store, which UI-renderer tests must not import (dependency direction).
 */
function miniStore<T extends object>(
  init: () => T,
  mutators: Record<string, (state: T, ...params: never[]) => T>,
): StoreHandle<T, ActionsDecl<T>> {
  return {
    spec: { init, actions: {} },
    create: () => {
      let state = init()
      const listeners = new Set<() => void>()
      const actions: Record<string, (...params: never[]) => void> = {}
      for (const key of Object.keys(mutators)) {
        actions[key] = (...params: never[]) => {
          state = mutators[key]!(state, ...params)
          for (const fn of [...listeners]) fn()
        }
      }
      return {
        getSnapshot: () => state,
        subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
        actions,
        clearPersisted: () => {},
      } as StoreInstanceLike as ReturnType<StoreHandle<T, ActionsDecl<T>>['create']>
    },
  }
}

function observable<T>(initial: T) {
  let value = initial
  const subs = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn) } },
    set: (next: T) => { value = next; for (const fn of [...subs]) fn() },
  }
}

/**
 * Behavioral SlotRendererHost fake: registration mutates entries, bumps the
 * key version, and notifies synchronously (batching semantics belong to the
 * registry host, not this package's outlets). Store instances resolve through
 * the entry's real handle, cached per (entry x scope key) like the real
 * ledger; session bindings are identity-stable per id.
 */
function makeHost() {
  const scopeCtx = new Context()
  const entries = new Map<string, StoredEntry[]>()
  const specs = new Map<string, DeclaredSpec>()
  const versions = new Map<string, number>()
  const subs = new Map<string, Set<() => void>>()
  const live = new Set<StoredEntry>()
  const abdicated = new Set<StoredEntry>()
  const storeCache = new Map<StoredEntry, Map<string, StoreInstanceLike>>()
  const list = observable<{ ids: string[] }>({ ids: [] })
  const workspaces = observable<{ ids: string[] }>({ ids: [] })
  const absentBinding: StandardSourceBinding = {
    key: undefined,
    hooks: { session: undefined },
    keyedHooks: {},
    props: { sessionId: undefined },
  }
  const currentBinding = observable<StandardSourceBinding>(absentBinding)
  let currentId: string | undefined
  const bindings = new Map<string, ScopedStandardSourceBinding>()
  const sessionSources = new Map<string, ReturnType<typeof observable<unknown>>>()
  const root = observable<StandardSourceBinding>({
    key: undefined,
    hooks: { sessions: list, workspaces },
    keyedHooks: {},
    props: {},
  })
  const sessionAdapter: SlotScopeAdapter = {
    current: currentBinding,
    resolve: key => bindings.get(key),
    renderArea: (binding, { empty, children }) => binding.key === undefined
      ? <>{empty?.() ?? null}</>
      : <>{children}</>,
  }
  const scopeRevision = observable(0)
  let activeScopeAdapter = sessionAdapter

  const bump = (key: string) => {
    versions.set(key, (versions.get(key) ?? 0) + 1)
    for (const fn of [...(subs.get(key) ?? [])]) fn()
  }
  const host: SlotRendererHost = {
    subscribe: (key, fn) => {
      const set = subs.get(key) ?? new Set()
      set.add(fn)
      subs.set(key, set)
      return () => { set.delete(fn) }
    },
    getVersion: key => versions.get(key) ?? 0,
    entriesOf: key => entries.get(key) ?? [],
    entriesOfSlot: (key) => {
      const all = entries.get(key) ?? []
      const kind = specs.get(key)?.kind
      if (kind === 'chain') return all
      // Mirror the ledger projection: first live (non-abdicated) entry per
      // cell (single — one cell; keyed — per key; list — per id).
      const heads: StoredEntry[] = []
      const seen = new Set<string | undefined>()
      for (const entry of all) {
        if (abdicated.has(entry)) continue
        const cell = kind === 'keyed' ? entry.options.key : kind === 'list' ? entry.options.id : undefined
        if (seen.has(cell)) continue
        seen.add(cell)
        heads.push(entry)
      }
      return heads
    },
    reportEntryError: (key, entry, _error, info) => {
      if (!info.abdicate || abdicated.has(entry)) return
      abdicated.add(entry)
      bump(key)
    },
    specOf: key => specs.get(key),
    isLive: entry => live.has(entry),
    storeOf: (entry, scopeBinding) => {
      if (entry.store === undefined) return undefined
      let perScope = storeCache.get(entry)
      if (!perScope) {
        perScope = new Map()
        storeCache.set(entry, perScope)
      }
      const cacheKey = scopeBinding?.key ?? ''
      let instance = perScope.get(cacheKey)
      if (!instance) {
        // Fake entries always carry engine handles (never factories), and the
        // engine create() takes the scope key (persist suffixing).
        const handle = entry.store as { create(scopeKey?: string): StoreInstanceLike }
        instance = handle.create(scopeBinding?.key)
        perScope.set(cacheKey, instance)
      }
      return instance
    },
    root,
    scopeRevision,
    scope: () => activeScopeAdapter,
  }
  return {
    host,
    list,
    workspaces,
    // Driver surface: set(id) publishes the resolved binding (or the absent
    // projection) through the scope adapter.
    current: {
      set: (id: string | undefined) => {
        currentId = id
        currentBinding.set((id === undefined ? undefined : bindings.get(id)) ?? absentBinding)
      },
    },
    declare: (key: string, spec: DeclaredSpec) => { specs.set(key, spec); bump(key) },
    add: (key: string, partial: Omit<StoredEntry, 'options'> & { options?: StoredEntry['options'] }) => {
      const entry = entryOf(partial)
      const next = [...(entries.get(key) ?? []), entry]
      // Mirror the ledger contract: entries arrive priority-sorted (stable,
      // ascending; list refines equal priorities by order) — outlets iterate
      // entries() order as-is.
      next.sort(specs.get(key)?.kind === 'list'
        ? (a, b) => ((a.options.priority ?? 0) - (b.options.priority ?? 0)) || ((a.options.order ?? 0) - (b.options.order ?? 0))
        : (a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))
      entries.set(key, next)
      live.add(entry)
      bump(key)
      return () => {
        entries.set(key, (entries.get(key) ?? []).filter(e => e !== entry))
        live.delete(entry)
        bump(key)
      }
    },
    addSession: (id: string, initial: unknown = { sid: id }): ScopedStandardSourceBinding => {
      // Bare source per binding (identity-stable): the machinery binds useSession from it.
      const session = observable<unknown>(initial)
      const binding: ScopedStandardSourceBinding = {
        key: id,
        ctx: scopeCtx,
        hooks: { session },
        keyedHooks: {},
        props: { sessionId: id },
      }
      sessionSources.set(id, session)
      bindings.set(id, binding)
      if (currentId === id) currentBinding.set(binding)
      return binding
    },
    setSession: (id: string, snapshot: unknown) => {
      const source = sessionSources.get(id)
      if (source === undefined) throw new Error(`unknown test session: ${id}`)
      source.set(snapshot)
    },
    replaceScope: (adapter: SlotScopeAdapter) => {
      activeScopeAdapter = adapter
      scopeRevision.set(scopeRevision.getSnapshot() + 1)
    },
  }
}

type Fake = ReturnType<typeof makeHost>

/** Mount a root entry whose component renders `body` with its kit renderSlot. */
function mountRoot(
  h: Fake,
  children: Record<string, DeclaredSpec>,
  body: (renderSlot: RenderSlotFn, SessionProvider: SessionProviderComponent) => ReactNode,
) {
  const dispose = h.add('root', {
    component: (props: {
      renderSlot: RenderSlotFn
      SessionProvider: SessionProviderComponent
    }) => <>{body(props.renderSlot, props.SessionProvider)}</>,
    children,
  })
  const renderer = createSlotRenderer()
  const view = render(<>{renderer.renderRoot(h.host, {})}</>)
  return { view, dispose }
}

const SINGLE_ROOT: DeclaredSpec = { kind: 'single', scope: 'root' }
const SINGLE_SESSION: DeclaredSpec = { kind: 'single', scope: 'session' }
const CHAIN_ROOT: DeclaredSpec = { kind: 'chain', scope: 'root' }
const CHAIN_SESSION: DeclaredSpec = { kind: 'chain', scope: 'session' }

/** Chain entry literal: top-level select, priority in the options bag (the StoredEntry chain shape). */
const chainEntryOf = (partial: {
  component: unknown
  select: (owner: object) => unknown
  priority?: number
}): Omit<StoredEntry, 'options'> & { options?: StoredEntry['options'] } => ({
  component: partial.component,
  select: partial.select,
  ...(partial.priority !== undefined ? { options: { priority: partial.priority } } : {}),
})

/** Mount a root entry whose component renders `body` with its kit renderSlotChain. */
function mountChainRoot(h: Fake, children: Record<string, DeclaredSpec>, body: (renderSlotChain: RenderSlotChainFn) => ReactNode) {
  const dispose = h.add('root', {
    component: (props: { renderSlotChain: RenderSlotChainFn }) => <>{body(props.renderSlotChain)}</>,
    children,
  })
  const renderer = createSlotRenderer()
  const view = render(<>{renderer.renderRoot(h.host, {})}</>)
  return { view, dispose }
}

describe('root outlet', () => {
  it('renders the root registration and fails loud when root is unregistered (boot order)', () => {
    const h = makeHost()
    h.add('root', { component: () => <b>shell</b> })
    const renderer = createSlotRenderer()
    const view = render(<>{renderer.renderRoot(h.host, {})}</>)
    expect(view.container.textContent).toBe('shell')

    const empty = makeHost()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<>{createSlotRenderer().renderRoot(empty.host, {})}</>))
      .toThrow(/boot order/)
    spy.mockRestore()
  })

  it('passes renderRoot owner props into the root component', () => {
    const h = makeHost()
    h.add('root', { component: ({ tag }: { tag?: string }) => <b>{tag}</b> })
    const view = render(<>{createSlotRenderer().renderRoot(h.host, { tag: 'OWNER' })}</>)
    expect(view.container.textContent).toBe('OWNER')
  })
})

describe('child outlets and the renderSlot binding', () => {
  it('renders declared single slots live: fallback when empty, register, dispose back', () => {
    const h = makeHost()
    h.declare('k.single', SINGLE_ROOT)
    const { view } = mountRoot(h, { 'k.single': SINGLE_ROOT },
      renderSlot => renderSlot('k.single', {}, { fallback: <i>none</i> }))
    expect(view.container.textContent).toBe('none')
    let dispose = () => {}
    act(() => { dispose = h.add('k.single', { component: () => <b>SB</b> }) })
    expect(view.container.textContent).toBe('SB')
    act(() => { dispose() })
    expect(view.container.textContent).toBe('none')
  })

  it('renders an undeclared key as empty (declaring entry unloaded = natural blank, not a crash)', () => {
    const h = makeHost()
    const { view } = mountRoot(h, { 'k.single': SINGLE_ROOT },
      renderSlot => <main>{renderSlot('k.single', {}, { fallback: <i>fb</i> })}</main>)
    // Declared by children (authorization) but absent from the ledger (specOf
    // undefined): the outlet renders nothing, not even the fallback path's spec dispatch.
    expect(view.container.querySelector('main')!.textContent).toBe('')
  })

  it('orders list entries, honors only-filter, dispatches keyed entries by entryKey', () => {
    const h = makeHost()
    h.declare('k.list', { kind: 'list', scope: 'root' })
    h.declare('k.keyed', { kind: 'keyed', scope: 'root' })
    h.add('k.list', { component: () => <span>b</span>, options: { id: 'b', order: 2 } })
    h.add('k.list', { component: () => <span>a</span>, options: { id: 'a', order: 1 } })
    h.add('k.keyed', { component: () => <span>goal</span>, options: { key: 'goal' } })
    const children = { 'k.list': { kind: 'list', scope: 'root' } as DeclaredSpec, 'k.keyed': { kind: 'keyed', scope: 'root' } as DeclaredSpec }
    const { view } = mountRoot(h, children, renderSlot => <>
      <main>{renderSlot('k.list', {})}</main>
      <aside>{renderSlot('k.list', {}, { only: 'b' })}</aside>
      <nav>{renderSlot('k.keyed', {}, { entryKey: 'goal' })}</nav>
      <footer>{renderSlot('k.keyed', {}, { entryKey: 'nope', fallback: <i>fb</i> })}</footer>
    </>)
    expect(view.container.querySelector('main')!.textContent).toBe('ab')
    expect(view.container.querySelector('aside')!.textContent).toBe('b')
    expect(view.container.querySelector('nav')!.textContent).toBe('goal')
    expect(view.container.querySelector('footer')!.textContent).toBe('fb')
  })

  it('keeps the binding identity-stable across re-renders and throws SlotOwnershipError off-declaration', () => {
    const h = makeHost()
    h.declare('k.single', SINGLE_ROOT)
    const seen: RenderSlotFn[] = []
    mountRoot(h, { 'k.single': SINGLE_ROOT }, (renderSlot) => {
      seen.push(renderSlot)
      return renderSlot('k.single', {})
    })
    // Bump the 'root' key to force a root-entry re-render (the single-kind
    // outlet only reads entries[0], so the extra entry is inert).
    act(() => { h.add('root', { component: () => null }) })
    expect(seen.length).toBeGreaterThan(1)
    expect(seen.at(-1)).toBe(seen[0])
    expect(() => seen[0]!('k.undeclared', {})).toThrow(SlotOwnershipError)
  })

  it('isolates a crashing entry without collapsing siblings', () => {
    const h = makeHost()
    h.declare('k.list', { kind: 'list', scope: 'root' })
    h.add('k.list', { component: () => { throw new Error('entry boom') }, options: { id: 'bad', order: 1 } })
    h.add('k.list', { component: () => <span>alive</span>, options: { id: 'ok', order: 2 } })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { view } = mountRoot(h, { 'k.list': { kind: 'list', scope: 'root' } },
      renderSlot => renderSlot('k.list', {}))
    spy.mockRestore()
    expect(view.container.textContent).toBe('alive')
    expect(view.container.querySelector('[data-slot-error]')).not.toBeNull()
  })
})

describe('chain outlets and the renderSlotChain binding', () => {
  it('elects the first non-null selector in order, injects matched, and skips decliners without mounting them', () => {
    const h = makeHost()
    h.declare('k.chain', CHAIN_ROOT)
    const declinerBody = vi.fn(() => <span>never</span>)
    h.add('k.chain', chainEntryOf({
      component: declinerBody,
      select: () => null,
    }))
    h.add('k.chain', chainEntryOf({
      component: ({ matched }: { matched?: { label: string } }) => <b>{matched?.label}</b>,
      select: owner => ({ label: `hit:${(owner as { tag: string }).tag}` }),
    }))
    const { view } = mountChainRoot(h, { 'k.chain': CHAIN_ROOT },
      renderSlotChain => renderSlotChain('k.chain', { tag: 'T' }))
    // The declining entry never mounts: the routing decision is select-layer only.
    expect(view.container.textContent).toBe('hit:T')
    expect(declinerBody).not.toHaveBeenCalled()
  })

  it('contains a throwing selector to its entry: reported, treated as declined, chain and fallback intact', () => {
    const h = makeHost()
    h.declare('k.chain', CHAIN_ROOT)
    h.add('k.chain', chainEntryOf({
      component: () => <span>never</span>,
      select: () => { throw new Error('selector boom') },
    }))
    h.add('k.chain', chainEntryOf({
      component: ({ matched }: { matched?: string }) => <b>{matched}</b>,
      select: owner => (owner as { pick?: string }).pick ?? null,
    }))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { view } = mountChainRoot(h, { 'k.chain': CHAIN_ROOT }, renderSlotChain => <>
      <main>{renderSlotChain('k.chain', { pick: 'OK' })}</main>
      <aside>{renderSlotChain('k.chain', {}, { fallback: <i>fb</i> })}</aside>
    </>)
    // The breach never escapes to the owner region: later entries still get
    // tried, and an all-throw/all-null pass still lands on the fallback.
    expect(view.container.querySelector('main')!.textContent).toBe('OK')
    expect(view.container.querySelector('aside')!.textContent).toBe('fb')
    expect(spy.mock.calls.some(([msg]) => String(msg).includes('chain selector crashed'))).toBe(true)
    spy.mockRestore()
  })

  it('remounts the boundary on re-election: a failed entry does not black out its replacement', () => {
    const h = makeHost()
    h.declare('k.chain', CHAIN_ROOT)
    h.add('k.chain', chainEntryOf({
      component: () => { throw new Error('entry A boom') },
      select: owner => (owner as { pick?: string }).pick === 'A' ? {} : null,
    }))
    h.add('k.chain', chainEntryOf({
      component: () => <b>B-ok</b>,
      select: owner => (owner as { pick?: string }).pick === 'B' ? {} : null,
    }))
    let pick = 'A'
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { view } = mountChainRoot(h, { 'k.chain': CHAIN_ROOT },
      renderSlotChain => renderSlotChain('k.chain', { pick }))
    spy.mockRestore()
    expect(view.container.querySelector('[data-slot-error]')).not.toBeNull()
    // Re-elect entry B: the entry-keyed boundary remounts fresh instead of
    // holding A's failed state over the healthy replacement.
    pick = 'B'
    act(() => { h.add('root', { component: () => null }) })   // root bump re-renders the dispatch site
    expect(view.container.textContent).toBe('B-ok')
    expect(view.container.querySelector('[data-slot-error]')).toBeNull()
  })

  it('falls to the owner fallback when every selector declines, and re-routes live', () => {
    const h = makeHost()
    h.declare('k.chain', CHAIN_ROOT)
    h.add('k.chain', chainEntryOf({
      component: ({ matched }: { matched?: string }) => <b>{matched}</b>,
      select: owner => (owner as { pick?: string }).pick ?? null,
    }))
    const { view } = mountChainRoot(h, { 'k.chain': CHAIN_ROOT }, renderSlotChain => <>
      <main>{renderSlotChain('k.chain', {}, { fallback: <i>bar</i> })}</main>
      <aside>{renderSlotChain('k.chain', { pick: 'P' }, { fallback: <i>bar</i> })}</aside>
    </>)
    // Same chain, two dispatch sites: all-null owner props fall back, matching ones elect.
    expect(view.container.querySelector('main')!.textContent).toBe('bar')
    expect(view.container.querySelector('aside')!.textContent).toBe('P')
  })

  it('renders the fallback for an empty chain and elects live once an entry registers', () => {
    const h = makeHost()
    h.declare('k.chain', CHAIN_ROOT)
    const { view } = mountChainRoot(h, { 'k.chain': CHAIN_ROOT },
      renderSlotChain => renderSlotChain('k.chain', {}, { fallback: <i>none</i> }))
    expect(view.container.textContent).toBe('none')
    let dispose = () => {}
    act(() => {
      dispose = h.add('k.chain', chainEntryOf({
        component: () => <b>IN</b>,
        select: () => ({}),
      }))
    })
    expect(view.container.textContent).toBe('IN')
    act(() => { dispose() })
    expect(view.container.textContent).toBe('none')
  })

  it('orders the chain by ascending priority with registration sequence breaking ties', () => {
    const h = makeHost()
    h.declare('k.chain', CHAIN_ROOT)
    // Registered first but priority 2: must yield to the later priority-1 entry.
    h.add('k.chain', chainEntryOf({
      component: () => <b>late</b>,
      select: () => ({}),
      priority: 2,
    }))
    h.add('k.chain', chainEntryOf({
      component: () => <b>early</b>,
      select: () => ({}),
      priority: 1,
    }))
    // Tie pair at priority 1: registration order decides (early wins over tie).
    h.add('k.chain', chainEntryOf({
      component: () => <b>tie</b>,
      select: () => ({}),
      priority: 1,
    }))
    const { view } = mountChainRoot(h, { 'k.chain': CHAIN_ROOT },
      renderSlotChain => renderSlotChain('k.chain', {}))
    expect(view.container.textContent).toBe('early')
  })

  it('keeps the renderSlotChain binding identity-stable across re-renders', () => {
    const h = makeHost()
    h.declare('k.chain', CHAIN_ROOT)
    const seen: RenderSlotChainFn[] = []
    mountChainRoot(h, { 'k.chain': CHAIN_ROOT }, (renderSlotChain) => {
      seen.push(renderSlotChain)
      return renderSlotChain('k.chain', {}, { fallback: <i>fb</i> })
    })
    act(() => { h.add('root', { component: () => null }) })   // root bump re-renders the entry
    expect(seen.length).toBeGreaterThan(1)
    expect(seen.at(-1)).toBe(seen[0])
  })

  it('backstops off-declaration keys, kind mismatches both ways, and disposed registrations', () => {
    const h = makeHost()
    h.declare('k.chain', CHAIN_ROOT)
    h.declare('k.single', SINGLE_ROOT)
    let chainFn: RenderSlotChainFn | undefined
    let slotFn: RenderSlotFn | undefined
    const dispose = h.add('root', {
      component: (props: { renderSlot: RenderSlotFn; renderSlotChain: RenderSlotChainFn }) => {
        slotFn = props.renderSlot
        chainFn = props.renderSlotChain
        return null
      },
      children: { 'k.chain': CHAIN_ROOT, 'k.single': SINGLE_ROOT },
    })
    const view = render(<>{createSlotRenderer().renderRoot(h.host, {})}</>)
    expect(() => chainFn!('k.undeclared', {})).toThrow(SlotOwnershipError)
    expect(() => chainFn!('k.single', {})).toThrow(SlotOwnershipError)   // non-chain key via chain face
    expect(() => slotFn!('k.chain', {})).toThrow(SlotOwnershipError)     // chain key via plain face
    view.unmount()
    dispose()
    expect(() => chainFn!('k.chain', {})).toThrow(StaleAuthorizationError)
  })

  it('withholds the renderSlotChain seat from entries declaring no chain child', () => {
    const h = makeHost()
    h.declare('k.single', SINGLE_ROOT)
    const seen: AnyProps[] = []
    h.add('root', {
      component: (props: AnyProps) => { seen.push(props); return null },
      children: { 'k.single': SINGLE_ROOT },
    })
    render(<>{createSlotRenderer().renderRoot(h.host, {})}</>)
    expect(seen.at(-1)!['renderSlotChain']).toBeUndefined()
  })
})

describe('overlay chains (ChainRenderOpts.overlay)', () => {
  /** Fallback probe: counts mounts and holds uncontrolled DOM state (the
   *  composer-draft stand-in an unmount would wipe). */
  function fallbackProbe(onMount: () => void) {
    return function Probe() {
      useEffect(onMount, [])
      return <input aria-label="probe" defaultValue="" />
    }
  }

  it('keeps the fallback mounted and state-holding through a takeover, hidden then restored', () => {
    const h = makeHost()
    h.declare('k.chain', CHAIN_ROOT)
    h.add('k.chain', chainEntryOf({
      component: () => <b>TAKEOVER</b>,
      select: owner => (owner as { take?: boolean }).take ? {} : null,
    }))
    const mounted = vi.fn()
    const Probe = fallbackProbe(mounted)
    let take = false
    const { view } = mountChainRoot(h, { 'k.chain': CHAIN_ROOT },
      renderSlotChain => renderSlotChain('k.chain', { take }, { fallback: <Probe />, overlay: true }))
    const wrapper = () => view.container.querySelector<HTMLElement>('[data-chain-overlay-fallback="k.chain"]')!
    const input = () => view.container.querySelector<HTMLInputElement>('input[aria-label="probe"]')!

    // Resident phase: fallback visible through the layout-neutral wrapper.
    expect(wrapper().style.display).toBe('contents')
    fireEvent.change(input(), { target: { value: 'draft-in-flight' } })

    // Election: entry overlays, fallback hides in place — same DOM node, no remount.
    take = true
    act(() => { h.add('root', { component: () => null }) })   // root bump re-renders the dispatch site
    expect(view.container.textContent).toContain('TAKEOVER')
    expect(wrapper().style.display).toBe('none')
    expect(input().value).toBe('draft-in-flight')

    // Takeover ends: fallback shows again with its state intact, still the original mount.
    take = false
    act(() => { h.add('root', { component: () => null }) })
    expect(view.container.textContent).not.toContain('TAKEOVER')
    expect(wrapper().style.display).toBe('contents')
    expect(input().value).toBe('draft-in-flight')
    expect(mounted).toHaveBeenCalledTimes(1)
  })

  it('keeps an explicit fallback-only strict chain mounted until its Session scope exists', () => {
    const h = makeHost()
    h.declare('k.chain', CHAIN_SESSION)
    h.addSession('s1')
    const select = vi.fn(() => null)
    h.add('k.chain', chainEntryOf({ component: () => <b>never</b>, select }))
    let fallbackOnly = true
    const { view } = mountChainRoot(h, { 'k.chain': CHAIN_SESSION },
      renderSlotChain => renderSlotChain(
        'k.chain',
        {},
        { fallback: <input aria-label="resident" />, fallbackOnly, overlay: true },
      ))
    const input = view.getByRole('textbox', { name: 'resident' })
    expect(select).not.toHaveBeenCalled()

    fallbackOnly = false
    act(() => {
      h.current.set('s1')
      h.add('root', { component: () => null })
    })
    expect(view.getByRole('textbox', { name: 'resident' })).toBe(input)
    expect(select).toHaveBeenCalledOnce()
  })

  it('leaves non-overlay chains on the unmount path: a takeover discards fallback state', () => {
    const h = makeHost()
    h.declare('k.chain', CHAIN_ROOT)
    h.add('k.chain', chainEntryOf({
      component: () => <b>TAKEOVER</b>,
      select: owner => (owner as { take?: boolean }).take ? {} : null,
    }))
    const mounted = vi.fn()
    const Probe = fallbackProbe(mounted)
    let take = false
    const { view } = mountChainRoot(h, { 'k.chain': CHAIN_ROOT },
      renderSlotChain => renderSlotChain('k.chain', { take }, { fallback: <Probe /> }))
    fireEvent.change(view.container.querySelector('input[aria-label="probe"]')!, { target: { value: 'gone' } })
    expect(view.container.querySelector('[data-chain-overlay-fallback]')).toBeNull()

    take = true
    act(() => { h.add('root', { component: () => null }) })
    expect(view.container.querySelector('input[aria-label="probe"]')).toBeNull()   // unmounted

    take = false
    act(() => { h.add('root', { component: () => null }) })
    const remounted = view.container.querySelector<HTMLInputElement>('input[aria-label="probe"]')!
    expect(remounted.value).toBe('')                    // fresh mount, state discarded
    expect(mounted).toHaveBeenCalledTimes(2)
  })

  it('keeps election semantics under overlay: priority order, selector-crash decline, live dispose back to fallback', () => {
    const h = makeHost()
    h.declare('k.chain', CHAIN_ROOT)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.add('k.chain', chainEntryOf({
      component: () => <span>never</span>,
      select: () => { throw new Error('selector boom') },
      priority: 1,
    }))
    const dispose = h.add('k.chain', chainEntryOf({
      component: () => <b>ELECTED</b>,
      select: () => ({}),
      priority: 2,
    }))
    const { view } = mountChainRoot(h, { 'k.chain': CHAIN_ROOT },
      renderSlotChain => renderSlotChain('k.chain', {}, { fallback: <i>resident</i>, overlay: true }))
    expect(view.container.textContent).toContain('ELECTED')
    expect(spy.mock.calls.some(([msg]) => String(msg).includes('chain selector crashed'))).toBe(true)
    spy.mockRestore()
    act(() => { dispose() })
    const wrapper = view.container.querySelector<HTMLElement>('[data-chain-overlay-fallback="k.chain"]')!
    expect(wrapper.style.display).toBe('contents')
    expect(view.container.textContent).toBe('resident')
  })
})

describe('standard-kit synthesis', () => {
  it('delivers a live useSessions hook to every slot component', () => {
    const h = makeHost()
    h.declare('k.single', SINGLE_ROOT)
    h.add('k.single', {
      component: ({ useSessions }: { useSessions: <S>(sel: (s: { ids: string[] }) => S) => S }) =>
        <b>{useSessions(s => s.ids.length)}</b>,
    })
    const { view } = mountRoot(h, { 'k.single': SINGLE_ROOT }, renderSlot => renderSlot('k.single', {}))
    expect(view.container.textContent).toBe('0')
    act(() => { h.list.set({ ids: ['a', 'b'] }) })
    expect(view.container.textContent).toBe('2')
  })

  it('delivers a live useWorkspaces hook to every slot component', () => {
    const h = makeHost()
    h.declare('k.single', SINGLE_ROOT)
    h.add('k.single', {
      component: ({ useWorkspaces }: { useWorkspaces: <S>(sel: (s: { ids: string[] }) => S) => S }) =>
        <b>{useWorkspaces(s => s.ids.length)}</b>,
    })
    const { view } = mountRoot(h, { 'k.single': SINGLE_ROOT }, renderSlot => renderSlot('k.single', {}))
    expect(view.container.textContent).toBe('0')
    act(() => { h.workspaces.set({ ids: ['w1'] }) })
    expect(view.container.textContent).toBe('1')
  })

  it('delivers the session pair (bound useSession + sessionId) under SessionProvider', () => {
    const h = makeHost()
    h.declare('k.session', SINGLE_SESSION)
    h.addSession('s1')
    const seen: AnyProps[] = []
    h.add('k.session', {
      component: (props: { useSession?: <S>(sel: (s: { sid: string }) => S) => S; sessionId?: string }) => {
        seen.push({ ...props, read: props.useSession!(s => s.sid) })
        return null
      },
    })
    mountRoot(h, { 'k.session': SINGLE_SESSION }, (renderSlot, SessionProvider) => (
      <SessionProvider empty={() => <i>empty</i>}>
        {renderSlot('k.session', {})}
      </SessionProvider>
    ))
    act(() => { h.current.set('s1') })
    const props = seen.at(-1)!
    // The hook is BOUND by the machinery from the cell's bare source: it
    // reads the source's snapshot and stays identity-stable across renders
    // (per-source cache), which the switch-back cache tests cover.
    expect(props['read']).toBe('s1')
    expect(props['sessionId']).toBe('s1')
  })

  it('binds only function-valued inject hooks to the standard kit and render occurrence context', () => {
    const h = makeHost()
    const turnDataFactory = vi.fn((standard: AnyProps, turn: unknown) => (key: string) => {
      const useSession = standard['useSession'] as (selector: (snapshot: unknown) => unknown) => unknown
      return useSession((snapshot) => {
        const value = snapshot as { turns: Record<number, Record<string, unknown>> }
        return value.turns[turn as number]?.[key]
      })
    })
    const sessionSpec: DeclaredSpec = {
      kind: 'single', scope: 'session', inject: { hooks: { turnData: turnDataFactory } },
    }
    h.declare('k.session', sessionSpec)
    h.addSession('s1', {
      turns: { 1: { tail: 'one' }, 2: { tail: 'two' } },
      unrelated: 0,
    })
    const hooks = new Map<string, Array<(key: string) => unknown>>()
    let renders = 0
    h.add('k.session', {
      component: ({ label, useTurnData }: { label: string; useTurnData: (key: string) => unknown }) => {
        renders += 1
        const seen = hooks.get(label) ?? []
        seen.push(useTurnData)
        hooks.set(label, seen)
        return <b data-turn={label}>{String(useTurnData('tail'))}</b>
      },
    })
    const { view } = mountRoot(h, { 'k.session': sessionSpec }, (renderSlot, SessionProvider) => (
      <SessionProvider><>
        {renderSlot('k.session', { label: 'one' }, { hookContext: 1 })}
        {renderSlot('k.session', { label: 'two' }, { hookContext: 2 })}
      </>
      </SessionProvider>
    ))
    act(() => { h.current.set('s1') })
    expect(view.container.textContent).toBe('onetwo')
    expect(renders).toBe(2)

    // A session publication whose selected contextual value is identical is
    // filtered by the framework-bound selector.
    act(() => {
      h.setSession('s1', {
        turns: { 1: { tail: 'one' }, 2: { tail: 'two' } },
        unrelated: 1,
      })
    })
    expect(renders).toBe(2)

    // Updating the selected contextual value re-renders through the returned
    // custom Hook; the factory itself and its Hook identity stay stable.
    act(() => {
      h.setSession('s1', {
        turns: { 1: { tail: 'updated' }, 2: { tail: 'two' } },
        unrelated: 1,
      })
    })
    expect(view.container.textContent).toBe('updatedtwo')
    expect(renders).toBe(3)
    expect(hooks.get('one')![1]).toBe(hooks.get('one')![0])
    expect(hooks.get('two')).toHaveLength(1)
    expect(hooks.get('one')![0]).not.toBe(hooks.get('two')![0])
    expect(turnDataFactory).toHaveBeenCalledTimes(2)
  })

  it('hands the SessionProvider seat to entries declaring a session-scope child', () => {
    const h = makeHost()
    h.declare('k.session', SINGLE_SESSION)
    h.declare('k.single', SINGLE_ROOT)
    h.addSession('s1')
    h.add('k.session', { component: ({ sessionId }: { sessionId?: string }) => <b>{sessionId}</b> })
    const rootSeen: AnyProps[] = []
    // Root entry uses its INJECTED provider seat (no value import of SessionProvider).
    h.add('root', {
      component: (props: AnyProps) => {
        rootSeen.push(props)
        const Provider = props['SessionProvider'] as SessionProviderComponent
        const renderSlot = props['renderSlot'] as RenderSlotFn
        return (
          <Provider empty={() => <i>empty</i>}>
            {renderSlot('k.session', {})}
          </Provider>
        )
      },
      children: { 'k.session': SINGLE_SESSION },
    })
    const view = render(<>{createSlotRenderer().renderRoot(h.host, {})}</>)
    expect(view.container.textContent).toBe('empty')
    act(() => { h.current.set('s1') })
    expect(view.container.textContent).toBe('s1')

    // Entries whose children are all root-scope get no provider seat.
    const h2 = makeHost()
    h2.declare('k.single', SINGLE_ROOT)
    const seen2: AnyProps[] = []
    h2.add('root', {
      component: (props: AnyProps) => { seen2.push(props); return null },
      children: { 'k.single': SINGLE_ROOT },
    })
    render(<>{createSlotRenderer().renderRoot(h2.host, {})}</>)
    expect(seen2.at(-1)!['SessionProvider']).toBeUndefined()
  })

  it('fails loud for a strict session slot while no session is current', () => {
    const h = makeHost()
    h.declare('k.session', SINGLE_SESSION)
    h.add('k.session', { component: () => <b>x</b> })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => mountRoot(h, { 'k.session': SINGLE_SESSION },
      renderSlot => renderSlot('k.session', {})))
      .toThrow("strict session slot 'k.session' rendered without a scope binding")
    spy.mockRestore()
  })

  it('delivers the store pair for store-declaring entries and writes through baked actions', () => {
    const h = makeHost()
    h.declare('k.single', SINGLE_ROOT)
    const handle = miniStore(() => ({ n: 0 }), { inc: s => ({ n: s.n + 1 }) })
    let bump = () => {}
    h.add('k.single', {
      component: ({ useStore, actions }: {
        useStore: <S>(sel: (s: { n: number }) => S) => S
        actions: { inc: () => void }
      }) => {
        bump = actions.inc
        return <b>{useStore(s => s.n)}</b>
      },
      store: handle,
    })
    const { view } = mountRoot(h, { 'k.single': SINGLE_ROOT }, renderSlot => renderSlot('k.single', {}))
    expect(view.container.textContent).toBe('0')
    act(() => { bump() })
    expect(view.container.textContent).toBe('1')
  })

  it('resolves session-slot stores per scope key: values survive a switch-away and back', () => {
    const h = makeHost()
    h.declare('k.session', SINGLE_SESSION)
    h.addSession('s1')
    h.addSession('s2')
    const handle = miniStore(() => ({ draft: '' }), { setDraft: (_s, text: string) => ({ draft: text }) })
    let setDraft: (text: string) => void = () => {}
    h.add('k.session', {
      component: ({ useStore, actions }: {
        useStore: <S>(sel: (s: { draft: string }) => S) => S
        actions: { setDraft: (text: string) => void }
      }) => {
        setDraft = actions.setDraft
        return <b>{useStore(s => s.draft) || '(blank)'}</b>
      },
      store: handle,
    })
    const { view } = mountRoot(h, { 'k.session': SINGLE_SESSION }, (renderSlot, SessionProvider) => (
      <SessionProvider>{renderSlot('k.session', {})}</SessionProvider>
    ))
    act(() => { h.current.set('s1') })
    act(() => { setDraft('draft-one') })
    expect(view.container.textContent).toBe('draft-one')
    act(() => { h.current.set('s2') })
    expect(view.container.textContent).toBe('(blank)')   // distinct instance per session
    act(() => { h.current.set('s1') })
    expect(view.container.textContent).toBe('draft-one') // same scope key = same instance
  })
})

describe('inject: execution point, parameter derivation, cache granularity', () => {
  it('root inject runs once per entry with no arguments (no store declared)', () => {
    const h = makeHost()
    h.declare('k.single', SINGLE_ROOT)
    const inject = vi.fn(() => ({ tag: 'FROM-INJECT' }))
    h.add('k.single', { component: ({ tag }: { tag?: string }) => <b>{tag}</b>, inject })
    const { view } = mountRoot(h, { 'k.single': SINGLE_ROOT }, renderSlot => renderSlot('k.single', {}))
    expect(view.container.textContent).toBe('FROM-INJECT')
    act(() => { h.add('k.single', { component: () => null }) })   // sibling bump re-renders the outlet
    expect(inject).toHaveBeenCalledTimes(1)
    expect(inject).toHaveBeenCalledWith()
  })

  it('binds the inject hooks compartment into use<Name> selector hooks (sources never reach the component)', () => {
    const h = makeHost()
    h.declare('k.single', SINGLE_ROOT)
    const badge = observable('cold')
    const seen: Record<string, unknown>[] = []
    h.add('k.single', {
      component: (props: { useBadge?: <S>(sel: (s: string) => S) => S; hooks?: unknown; plain?: string }) => {
        seen.push({ hooks: props.hooks, plain: props.plain, read: props.useBadge!(s => s) })
        return null
      },
      inject: () => ({ plain: 'kept', hooks: { badge } }),
    })
    mountRoot(h, { 'k.single': SINGLE_ROOT }, renderSlot => renderSlot('k.single', {}))
    // The raw compartment is consumed by the binding; the plain member passes through.
    expect(seen.at(-1)).toEqual({ hooks: undefined, plain: 'kept', read: 'cold' })
    act(() => { badge.set('hot') })
    expect(seen.at(-1)!['read']).toBe('hot')
  })

  it('binds the inject keyedHooks compartment without exposing source resolvers', () => {
    const h = makeHost()
    h.declare('k.single', SINGLE_ROOT)
    const badges = new Map([
      ['first', observable('cold')],
      ['second', observable('idle')],
    ])
    const seen: Record<string, unknown>[] = []
    h.add('k.single', {
      component: (props: {
        useBadge?: (key: string) => string | undefined
        keyedHooks?: unknown
        plain?: string
      }) => {
        seen.push({
          keyedHooks: props.keyedHooks,
          plain: props.plain,
          read: props.useBadge!('first'),
        })
        return null
      },
      inject: () => ({
        plain: 'kept',
        keyedHooks: { badge: (key: string) => badges.get(key) },
      }),
    })
    mountRoot(h, { 'k.single': SINGLE_ROOT }, renderSlot => renderSlot('k.single', {}))

    expect(seen.at(-1)).toEqual({ keyedHooks: undefined, plain: 'kept', read: 'cold' })
    act(() => { badges.get('second')!.set('ignored') })
    expect(seen).toHaveLength(1)
    act(() => { badges.get('first')!.set('hot') })
    expect(seen.at(-1)!['read']).toBe('hot')
  })

  it('session inject receives sessionId and caches per (entry x session): switch-back reuses', () => {
    const h = makeHost()
    h.declare('k.session', SINGLE_SESSION)
    h.addSession('s1')
    h.addSession('s2')
    const inject = vi.fn((sessionId: string) => ({ sid: sessionId }))
    h.add('k.session', {
      component: ({ sid }: { sid?: string }) => <b>{sid}</b>,
      inject: inject,
    })
    const { view } = mountRoot(h, { 'k.session': SINGLE_SESSION }, (renderSlot, SessionProvider) => (
      <SessionProvider>{renderSlot('k.session', {})}</SessionProvider>
    ))
    act(() => { h.current.set('s1') })
    expect(view.container.textContent).toBe('s1')
    expect(inject).toHaveBeenCalledTimes(1)
    expect(inject).toHaveBeenLastCalledWith('s1')
    act(() => { h.current.set('s2') })
    expect(view.container.textContent).toBe('s2')
    expect(inject).toHaveBeenCalledTimes(2)
    act(() => { h.current.set('s1') })   // back: (entry x cell) cache hit
    expect(view.container.textContent).toBe('s1')
    expect(inject).toHaveBeenCalledTimes(2)
  })

  it('store-declaring entries get baked actions appended to the inject parameters', () => {
    const h = makeHost()
    h.declare('k.single', SINGLE_ROOT)
    h.declare('k.session', SINGLE_SESSION)
    h.addSession('s1')
    const handle = miniStore(() => ({ n: 0 }), { inc: s => ({ n: s.n + 1 }) })
    const rootInject = vi.fn((actions: { inc: () => void }) => ({ viaRoot: actions }))
    const sessionInject = vi.fn((sessionId: string, actions: { inc: () => void }) => ({ sid: sessionId, viaSession: actions }))
    const seenRoot: AnyProps[] = []
    const seenSession: AnyProps[] = []
    h.add('k.single', {
      component: (props: object) => { seenRoot.push(props as AnyProps); return null },
      inject: rootInject,
      store: handle,
    })
    h.add('k.session', {
      component: (props: object) => { seenSession.push(props as AnyProps); return null },
      inject: sessionInject,
      store: handle,
    })
    mountRoot(h, { 'k.single': SINGLE_ROOT, 'k.session': SINGLE_SESSION }, (renderSlot, SessionProvider) => <>
      {renderSlot('k.single', {})}
      <SessionProvider>{renderSlot('k.session', {})}</SessionProvider>
    </>)
    act(() => { h.current.set('s1') })
    // The inject-received actions are the same baked callbacks the component
    // gets as props.actions (one instance per entry x scope key).
    expect(rootInject).toHaveBeenCalledTimes(1)
    expect(seenRoot.at(-1)!['viaRoot']).toBe(seenRoot.at(-1)!['actions'])
    expect(sessionInject).toHaveBeenCalledTimes(1)
    expect(sessionInject.mock.calls[0]![0]).toBe('s1')
    expect(seenSession.at(-1)!['viaSession']).toBe(seenSession.at(-1)!['actions'])
  })

  it('contains a throwing inject factory to its own entry (runs inside the component body)', () => {
    const h = makeHost()
    h.declare('k.list', { kind: 'list', scope: 'root' })
    h.add('k.list', {
      component: () => <span>never</span>,
      options: { id: 'bad', order: 1 },
      inject: () => { throw new Error('inject boom') },
    })
    h.add('k.list', { component: () => <span>alive</span>, options: { id: 'ok', order: 2 } })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { view } = mountRoot(h, { 'k.list': { kind: 'list', scope: 'root' } },
      renderSlot => <main>{renderSlot('k.list', {})}</main>)
    spy.mockRestore()
    // The failing entry blacks out alone; the sibling and the tree above survive.
    expect(view.container.querySelector('main')).not.toBeNull()
    expect(view.container.textContent).toBe('alive')
    expect(view.container.querySelector('[data-slot-error]')).not.toBeNull()
  })

  it('merges kit, inject, and owner props with owner winning', () => {
    const h = makeHost()
    h.declare('k.single', SINGLE_ROOT)
    const seen: AnyProps[] = []
    h.add('k.single', {
      component: (props: object) => { seen.push(props as AnyProps); return null },
      inject: () => ({ fromInject: 'inject', shared: 'inject' }),
    })
    mountRoot(h, { 'k.single': SINGLE_ROOT },
      renderSlot => renderSlot('k.single', { owner: 'owner', shared: 'owner' }))
    const props = seen.at(-1)!
    expect(typeof props['useSessions']).toBe('function')   // kit always present
    expect(typeof props['useWorkspaces']).toBe('function')
    expect(props['fromInject']).toBe('inject')
    expect(props['owner']).toBe('owner')
    expect(props['shared']).toBe('owner')   // owner overrides inject
  })
})

describe('session-maybe adoption identity', () => {
  const SINGLE_MAYBE: DeclaredSpec = { kind: 'single', scope: 'session-maybe' }

  /** Mount a maybe entry that records its mount count and local state. */
  function mountMaybeCounter(h: Fake) {
    let mounts = 0
    const seen: { sessionId: string | undefined; mount: number }[] = []
    h.declare('k.maybe', SINGLE_MAYBE)
    h.add('k.maybe', {
      component: ({ sessionId }: { sessionId?: string }) => {
        // Local mount marker: useState initializer runs once per incarnation.
        const [mount] = useState(() => ++mounts)
        seen.push({ sessionId, mount })
        return <b>{`${sessionId ?? 'blank'}#${mount}`}</b>
      },
    })
    const { view } = mountRoot(h, { 'k.maybe': SINGLE_MAYBE }, renderSlot => renderSlot('k.maybe', {}))
    return { view, seen }
  }

  it('adopts the first session: blank → first id keeps the incarnation (no remount)', () => {
    const h = makeHost()
    h.addSession('s1')
    const { view } = mountMaybeCounter(h)
    expect(view.container.textContent).toBe('blank#1')
    act(() => { h.current.set('s1') })
    // Same incarnation (#1): the blank shell adopted s1.
    expect(view.container.textContent).toBe('s1#1')
  })

  it('remounts on a post-adoption session switch (local state must not leak across sessions)', () => {
    const h = makeHost()
    h.addSession('s1')
    h.addSession('s2')
    const { view } = mountMaybeCounter(h)
    act(() => { h.current.set('s1') })
    expect(view.container.textContent).toBe('s1#1')
    act(() => { h.current.set('s2') })
    // New incarnation (#2): strict-session behavior after adoption.
    expect(view.container.textContent).toBe('s2#2')
  })

  it('remounts into a fresh blank incarnation on session loss, then adopts anew', () => {
    const h = makeHost()
    h.addSession('s1')
    h.addSession('s2')
    const { view } = mountMaybeCounter(h)
    act(() => { h.current.set('s1') })
    expect(view.container.textContent).toBe('s1#1')
    act(() => { h.current.set(undefined) })
    // The adopted incarnation dies with its session; blank state is fresh.
    expect(view.container.textContent).toBe('blank#2')
    act(() => { h.current.set('s2') })
    // The fresh blank adopts again — still incarnation #2, no flash.
    expect(view.container.textContent).toBe('s2#2')
  })

  it('keeps the incarnation across a no-op republish of the same session', () => {
    const h = makeHost()
    h.addSession('s1')
    const { view } = mountMaybeCounter(h)
    act(() => { h.current.set('s1') })
    act(() => { h.current.set('s1') })
    expect(view.container.textContent).toBe('s1#1')
  })

  it('rebinds mounted scope consumers when the installed adapter changes', () => {
    const h = makeHost()
    const { view } = mountMaybeCounter(h)
    expect(view.container.textContent).toBe('blank#1')
    const binding: ScopedStandardSourceBinding = {
      key: 'replacement',
      ctx: new Context(),
      hooks: { session: observable({ sid: 'replacement' }) },
      keyedHooks: {},
      props: { sessionId: 'replacement' },
    }
    act(() => {
      h.replaceScope({
        current: observable(binding),
        resolve: key => key === binding.key ? binding : undefined,
      })
    })
    expect(view.container.textContent).toBe('replacement#1')
  })
})
