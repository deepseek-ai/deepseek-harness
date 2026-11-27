/**
 * React-free snapshot store engine (zustand vanilla + immer + subscribeWithSelector +
 * rafFlush middleware + opt-in persist + dev freeze) plus the declarative
 * shell over it: {@link defineStore} bakes an init/persist/actions literal
 * into a {@link StoreHandle}, the registration-side store seat of slot
 * terminals. Engine products are bare observables — subscribe/getSnapshot/
 * update/set, NO selector hook. Hook synthesis is ui-renderer's (the one
 * uSES bridge, cached per source at the binding site).
 */
import { createStore, type StoreApi } from 'zustand/vanilla'
import { subscribeWithSelector } from 'zustand/middleware'
import { freeze, produce } from 'immer'
import type {
  ActionsDecl, BakedActions, ObservableSnapshot, StoreHandle, StoreInstance, StoreSpec,
} from './contract.ts'

// Store contract types are ui-slots authority; re-exported beside the engine
// so store consumers get one import path.
export type {
  ActionsDecl, BakedActions, BoundActions, DefineStore, HandleOf, MaybeSnapshotSelectorHook,
  ObservableSnapshot, PropsStore, SnapshotSelectorHook, StoreDecl, StoreFactory,
  StoreHandle, StoreInstance, StoreSpec,
} from './contract.ts'

/** Writable snapshot store (bare data face; React selector hooks are synthesized in ui-renderer). */
export interface SnapshotStore<T> extends ObservableSnapshot<T> {
  /**
   * Mutate the state through an immer draft.
   * @param mutator - draft mutator.
   */
  update(mutator: (draft: T) => void): void
  /**
   * Replace the state wholesale.
   * @param next - next state.
   */
  set(next: T): void
}

/**
 * Notify an observer set without allowing one callback to starve the rest.
 * @param listeners - current observer callbacks; copied before dispatch.
 * @param label - diagnostic owner prefix.
 * @param args - callback arguments.
 */
export function notifySubscribers<Args extends readonly unknown[]>(
  listeners: Iterable<(...args: Args) => void>,
  label: string,
  ...args: Args
): void {
  for (const listener of [...listeners]) {
    try {
      listener(...args)
    } catch (error) {
      console.error(`${label} subscriber failed:`, error)
    }
  }
}

/**
 * Shallow equality for selector slices. `Object.is` equal values match; two
 * Maps match when they have the same keys with `Object.is` equal values, two
 * Sets when they hold the same members, and other object pairs, including
 * arrays, when they have the same own enumerable string keys with `Object.is`
 * equal values. Maps and Sets are recognized by their `Object.prototype.toString`
 * tag, so a collection built by an isolated plugin's iframe compares like one
 * built by the page.
 * @param a - left value.
 * @param b - right value.
 * @returns whether the values are shallowly equal.
 */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  const tag = Object.prototype.toString.call(a)
  if (tag === Object.prototype.toString.call(b)) {
    if (tag === '[object Map]') return mapsEqual(a as ReadonlyMap<unknown, unknown>, b as ReadonlyMap<unknown, unknown>)
    if (tag === '[object Set]') return setsEqual(a as ReadonlySet<unknown>, b as ReadonlySet<unknown>)
  }
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every(key => Object.hasOwn(b, key) && Object.is(Reflect.get(a, key), Reflect.get(b, key)))
}

function mapsEqual(a: ReadonlyMap<unknown, unknown>, b: ReadonlyMap<unknown, unknown>): boolean {
  if (a.size !== b.size) return false
  for (const [key, value] of a) {
    if (!b.has(key) || !Object.is(value, b.get(key))) return false
  }
  return true
}

function setsEqual(a: ReadonlySet<unknown>, b: ReadonlySet<unknown>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) {
    if (!b.has(value)) return false
  }
  return true
}

/** Batches subscriber notification into one flush per animation frame. */
function rafBatch(notify: () => void): () => void {
  // Fall back to microtask batching where rAF is absent (node unit tests);
  // both preserve the N-changes=1-notification contract within a tick.
  const schedule: (fn: () => void) => void =
    typeof requestAnimationFrame === 'function'
      ? (fn) => { requestAnimationFrame(() => { fn() }) }
      : (fn) => { queueMicrotask(fn) }
  let scheduled = false
  return () => {
    if (scheduled) return
    scheduled = true
    schedule(() => {
      scheduled = false
      notify()
    })
  }
}

/**
 * Create a snapshot store.
 *
 * Flush default is 'sync' (controlled inputs need same-tick echo); frame-driven
 * stores opt into 'raf', where a frame's worth of updates coalesces into one
 * notification. Known raf-mode tradeoff: a component mounting mid-frame reads
 * fresh state while existing subscribers hear it next flush — transient
 * frame-level skew, same nature as the object layer's microtask batching.
 *
 * @param init - initial state.
 * @param opts - flush mode and opt-in persistence (localStorage, keyed by name).
 * @returns the store.
 */
export function createSnapshotStore<T>(
  init: T, opts?: { flush?: 'raf' | 'sync'; persist?: { name: string } }): SnapshotStore<T> {
  // Immer enters through produce() in update() below (identical semantics to
  // the immer middleware without its setState-signature mutator generics).
  const withSelector = subscribeWithSelector(() => init)
  const api: StoreApi<T> = createStore<T>()(withSelector)
  if (opts?.persist) attachPersistence(api, opts.persist.name)

  let subscribe = (fn: () => void) => api.subscribe(() => {
    notifySubscribers([fn], '[client-store]')
  })
  if (opts?.flush === 'raf') {
    const listeners = new Set<() => void>()
    const flush = rafBatch(() => { notifySubscribers(listeners, '[client-store]') })
    api.subscribe(flush)
    subscribe = (fn: () => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    }
  }

  return {
    getSnapshot: () => api.getState(),
    subscribe: fn => subscribe(fn),
    update: (mutator) => {
      // Immer's produce (not setState's partial-merge path) so scalar and
      // array roots replace correctly; produce also freezes in dev.
      api.setState(produce(api.getState(), (draft) => { mutator(draft as T) }), true)
    },
    set: (next) => {
      api.setState(devFreeze(next), true)
    },
  }
}

/**
 * Whole-value JSON persistence to localStorage. Hand-rolled instead of the
 * zustand persist middleware: its write path spreads state into an object
 * (`partialize({ ...get() })`), exploding primitive state (a persisted string
 * draft becomes {0:'h',1:'e',...}) — not fixable via merge/deserialize options
 * because the corruption happens before serialization. Storage failures
 * (quota, private mode) only disable persistence, never break the store.
 */
function attachPersistence<T>(api: StoreApi<T>, name: string): void {
  // Non-browser runs (node e2e booting the client tree) have no localStorage:
  // persistence silently disables — same contract as a storage failure, minus
  // the per-store console noise a ReferenceError would produce.
  if (typeof localStorage === 'undefined') return
  try {
    const raw = localStorage.getItem(name)
    if (raw !== null) {
      api.setState(devFreeze(JSON.parse(raw) as T), true)
    }
  } catch (error) {
    console.error(`snapshot store '${name}' rehydration failed:`, error)
  }
  api.subscribe((state) => {
    try {
      localStorage.setItem(name, JSON.stringify(state))
    } catch (error) {
      console.error(`snapshot store '${name}' persistence failed:`, error)
    }
  })
}

/** Deep-freeze draftable wholesale-set state outside production: set() bypasses immer's freeze. */
function devFreeze<T>(value: T): T {
  if (process.env.NODE_ENV === 'production') return value
  return freeze(value, true)
}

// ui-slots owns the contract; this module supplies the engine implementation.

/** A live engine instance: the contract instance plus the raw engine store. */
export interface EngineStoreInstance<T, A extends ActionsDecl<T>> extends StoreInstance<T, A> {
  /** The underlying engine store (framework/test API; components never see it). */
  readonly store: SnapshotStore<T>
}

/** The engine-backed handle: create() narrowed to the engine instance. */
export interface EngineStoreHandle<T, A extends ActionsDecl<T>> extends StoreHandle<T, A> {
  /**
   * Construct a live engine instance (see the contract JSDoc on
   * {@link StoreHandle.create} for scopeKey/persist semantics).
   *
   * Known boundary: the persist key is the storage identity, so multiple live
   * instances created under the same resolved key share (and cross-pollute)
   * one localStorage entry. Instance uniqueness per key is the caller's
   * responsibility — production is safe because the framework caches one
   * instance per handle x scope key; tests wanting isolation use distinct
   * scope keys or persist-free declarations (multi-create freedom is a
   * feature there, so create() deliberately does not dedupe or throw).
   * @param scopeKey - session id for session-scope instances; omitted for root scope.
   * @returns the engine instance.
   */
  create(scopeKey?: string): EngineStoreInstance<T, A>
}

/**
 * Declare a store: initial state, optional persistence, and the full write
 * set as pure draft mutators. The returned handle is the registration
 * currency of the store seat — its identity keys instance sharing. Satisfies
 * ui-slots' DefineStore contract (the handle/instance are the engine-extended
 * subtypes).
 *
 * The `A & ActionsDecl<T>` actions position is load-bearing: T resolves from
 * `init` in the first inference round, and the intersection then contextually
 * types each mutator's draft parameter (context-sensitive functions defer),
 * so call sites write `(d, x: X) => { ... }` with no draft annotation. If a
 * future TS version breaks this single-literal inference, the design's
 * documented fallback is currying (`defineStore(init).actions({...})`).
 * @param decl - init lambda (fresh state per instance), optional persist key, actions table.
 * @returns the store handle.
 */
export function defineStore<T, A extends ActionsDecl<T>>(
  decl: StoreSpec<T, A> & { actions: A & ActionsDecl<T> }): EngineStoreHandle<T, A> {
  return {
    spec: decl,
    create(scopeKey?: string): EngineStoreInstance<T, A> {
      const persistKey = decl.persist === undefined
        ? undefined
        : scopeKey === undefined ? decl.persist : `${decl.persist}.${scopeKey}`
      const store = createSnapshotStore<T>(
        decl.init(),
        persistKey !== undefined ? { persist: { name: persistKey } } : undefined)
      const actions = {} as Record<string, (...params: unknown[]) => void>
      for (const key of Object.keys(decl.actions)) {
        const mutate = decl.actions[key] as (draft: T, ...params: unknown[]) => void
        actions[key] = (...params: unknown[]) => { store.update((draft) => { mutate(draft, ...params) }) }
      }
      return {
        actions: actions as BakedActions<T, A>,
        getSnapshot: () => store.getSnapshot(),
        subscribe: fn => store.subscribe(fn),
        store,
        clearPersisted: () => {
          if (persistKey === undefined || typeof localStorage === 'undefined') return
          try {
            localStorage.removeItem(persistKey)
          } catch (_storageUnavailable) {
            // Storage failures (private mode, quota teardown races) only skip
            // cleanup — the same non-fatal contract as attachPersistence.
          }
        },
      }
    },
  }
}
