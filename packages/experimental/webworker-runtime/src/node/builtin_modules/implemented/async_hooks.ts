/**
 * `node:async_hooks` for the worker: `AsyncLocalStorage` over an EXPLICIT-SWITCH
 * model with two fallbacks. A browser has no async-context tracking, so the store
 * a read answers is decided by three slots, in this order:
 *
 * 1. HOOK OVERLAY — set for the duration of one callback by the hook layer
 *    (`./async-context-hooks.ts`), which captures the context where a callback was
 *    REGISTERED (`.then`, `queueMicrotask`, timers, `fetch`) and restores it where
 *    the callback RUNS.
 * 2. RESUMED CONTEXT — the explicit-switch slot. {@link __snapshotAll} copies every
 *    live instance's effective store and {@link __restoreAll} publishes a copy; the
 *    module loader's `await` rewriting pauses with the first and resumes with the
 *    second, which is what makes attribution causally correct across an `await`
 *    even while another chain interleaves. The rewriter's `restore` returns nothing,
 *    so this slot holds ONE value per instance and a resume REPLACES it rather than
 *    stacking: a frame that resumes again at its next await re-publishes its own
 *    context anyway, and a new `run()` boundary shadows the slot for its extent.
 *    (Callers that want scoping get a disposer back from {@link __restoreAll}.)
 * 2b. BOUNDARY AMBIENT — `run()` also publishes its own store here, so rewritten and
 *    un-rewritten code agree on what the innermost boundary is.
 * 3. FOLDING STACK — the fallback for code the rewriter has not touched: `run()`
 *    pushes an entry that is removed synchronously for a synchronous operation, or
 *    when the returned promise settles for an asynchronous one, so a store stays
 *    visible across `await` inside that operation.
 *
 * Every slot is removed by IDENTITY, never blindly: boundaries settle and frames
 * resume out of order, so a blind pop would drop somebody else's context — and a
 * slot that is released while shadowed must leave the chain without promoting
 * itself back over whoever came after it. The three slots are separate for the same reason — a restored
 * copy pushed onto the folding stack could unwind another boundary's entry.
 *
 * A snapshot with no stores or explicit contexts is `undefined`, and the hook layer
 * then wraps nothing: a callback registered outside every boundary keeps inheriting
 * the enclosing boundary. Explicit empty contexts retain their `undefined` stores,
 * so deferred callbacks cannot inherit unrelated work. `__snapshotAll` is
 * the transformer-facing counterpart and always captures every instance, including
 * the ones reading `undefined`, because a resumed frame must see exactly what it
 * saw at its pause point.
 *
 * BOUNDARY (structural, documented rather than worked around): native
 * `async`/`await` resumption inside code the rewriter has NOT transformed is
 * invisible to user code. Such a frame falls back to the folding stack, which is
 * ordered by nesting rather than by causal chain, so two boundaries overlapping
 * there can attribute to the wrong one. Nothing crashes, the stacks still unwind by
 * identity, and everything the hook layer or the rewriter covers is exact.
 */
import { notImplementedFail } from '../../notImplementedFail.ts'

interface Entry<T> {
  readonly store: T | undefined
}

interface Overlay<T> {
  readonly store: T | undefined
}

/** Pristine `then`, so this module's own bookkeeping never re-enters the hook layer. */
// eslint-disable-next-line @typescript-eslint/unbound-method -- taking `then` unbound is the point; it is `.call`ed on its own promise
const nativeThen = Promise.prototype.then

/** Every live instance, so one snapshot can capture all of their stores at once. */
const instances = new Set<AsyncLocalStorage<unknown>>()

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  return typeof (value as { then?: unknown }).then === 'function'
}

/** Node's AsyncLocalStorage face, restricted to the members the host tree uses. */
export class AsyncLocalStorage<T> {
  private readonly entries: Entry<T>[] = []
  private overlay: Overlay<T> | undefined
  private readonly ambients: Overlay<T>[] = []
  private resumed: Overlay<T> | undefined

  constructor() {
    instances.add(this)
  }

  /**
   * Run a callback with the store visible for the operation's whole lifetime:
   * until it returns, or until the promise it returned settles.
   * @param store - value {@link getStore} answers inside the boundary.
   * @param callback - the operation.
   * @param args - callback arguments.
   * @returns the exact value the callback returned.
   */
  run<R>(store: T | undefined, callback: (...args: never[]) => R, ...args: never[]): R {
    const entry: Entry<T> = { store }
    this.entries.push(entry)
    // Removal is by entry identity: overlapping boundaries settle out of order,
    // and a blind pop would drop somebody else's entry.
    const remove = (): void => {
      const at = this.entries.lastIndexOf(entry)
      if (at !== -1) this.entries.splice(at, 1)
    }
    // The boundary also publishes an ambient slot until its entry goes away.
    // Removal is by identity here too: a shadowed slot must leave the chain
    // without promoting itself back over whoever came after it.
    const ambient: Overlay<T> = { store }
    this.ambients.push(ambient)
    const removeBoundary = (): void => {
      const at = this.ambients.lastIndexOf(ambient)
      if (at !== -1) this.ambients.splice(at, 1)
      if (this.resumed === undefined) this.resumed = restoreResumed
      remove()
    }
    // A boundary opened under an overlay or a resumed context (a hook-restored
    // callback, or a rewritten frame, that starts a new run) must not keep reading
    // them: its own entry is the truth.
    const restoreOverlay = this.overlay
    const restoreResumed = this.resumed
    this.overlay = undefined
    this.resumed = undefined
    let result: R
    try {
      result = callback(...args)
    } catch (error) {
      this.overlay = restoreOverlay
      removeBoundary()
      throw error
    }
    this.overlay = restoreOverlay
    if (!isThenable(result)) {
      removeBoundary()
      return result
    }
    try {
      // `then.call` on the caller's own promise: no species construction, and the
      // rejection stays the caller's to observe (both handlers are attached, so
      // this observation never becomes an unhandled rejection itself).
      void nativeThen.call(result, removeBoundary, removeBoundary)
    } catch {
      // A branded promise may expose a failing @@species; the boundary then ends
      // here rather than leaking an entry that nothing would ever remove.
      removeBoundary()
    }
    return result
  }

  /**
   * Current store, resolved through the slot order this module documents: the
   * hook-restored overlay, then the ambient context a resume installed (or a
   * boundary owns), then the folding stack's innermost entry.
   * @returns the store, or undefined outside every boundary.
   */
  getStore(): T | undefined {
    if (this.overlay !== undefined) return this.overlay.store
    if (this.resumed !== undefined) return this.resumed.store
    const ambient = this.ambients.at(-1)
    if (ambient !== undefined) return ambient.store
    return this.entries.at(-1)?.store
  }

  /**
   * Run a callback with no store, folding over its lifetime like {@link run}.
   * @param callback - the operation.
   * @param args - callback arguments.
   * @returns the exact value the callback returned.
   */
  exit<R>(callback: (...args: never[]) => R, ...args: never[]): R {
    return this.run(undefined, callback, ...args)
  }

  /**
   * Enter a boundary that lasts until {@link disable}, as Node's `enterWith` does
   * for the remainder of the current chain.
   * @param store - value {@link getStore} answers from now on.
   */
  enterWith(store: T): void {
    this.entries.push({ store })
  }

  /** Drop every slot; teardown calls this unconditionally. */
  disable(): void {
    this.entries.length = 0
    this.overlay = undefined
    this.ambients.length = 0
    this.resumed = undefined
  }

  /**
   * Copy every live instance's effective store, including the instances reading
   * `undefined`: a resumed frame must see exactly what its pause point saw.
   * @returns the ambient snapshot.
   */
  static snapshotAll(): AmbientSnapshot {
    return [...instances].map(instance => ({ instance, store: instance.getStore() }))
  }

  /**
   * Install a snapshot as the ambient context of every instance it names.
   * @param snapshot - a copy from {@link snapshotAll}.
   * @returns a disposer that restores the previous ambients, identity-checked.
   */
  static restoreAll(snapshot: AmbientSnapshot): () => void {
    const installed = snapshot.map(({ instance, store }) => {
      const slot = { store }
      const before = instance.resumed
      instance.resumed = slot
      return { instance, slot, before }
    })
    return () => {
      for (const { instance, slot, before } of installed) {
        if (instance.resumed === slot) instance.resumed = before
      }
    }
  }

  /**
   * Copy every live instance's current store. Not part of the Node face: this is
   * the shim's own mechanism, kept in the class so the overlay stays private.
   * @returns the snapshot, or undefined when no instance has a store or explicit context.
   */
  static captureContext(): AsyncContextSnapshot | undefined {
    let captured: CapturedStore[] | undefined
    for (const instance of instances) {
      const store = instance.getStore()
      if (store === undefined && instance.overlay === undefined && instance.resumed === undefined
        && instance.ambients.length === 0 && instance.entries.length === 0) continue
      captured ??= []
      captured.push({ instance, store })
    }
    return captured
  }

  /**
   * Run a callback with a captured context restored into the overlay slots.
   * @param snapshot - context copy, or undefined to run unchanged.
   * @param callback - the callback.
   * @returns the callback's return value.
   */
  static runWithContext<R>(snapshot: AsyncContextSnapshot | undefined, callback: () => R): R {
    if (snapshot === undefined) return callback()
    const previous = snapshot.map(({ instance, store }) => {
      const before = instance.overlay
      instance.overlay = { store }
      return { instance, before }
    })
    try {
      return callback()
    } finally {
      for (const { instance, before } of previous) instance.overlay = before
    }
  }

  /**
   * Every live instance, for {@link runAtAsyncContextRoot}.
   * @returns The stores a snapshot must capture.
   */
  static liveInstances(): readonly AsyncLocalStorage<unknown>[] {
    return [...instances]
  }

  /**
   * Bind a callback to the current context.
   * @param callback - the callback to bind.
   * @returns a callback that restores this context when invoked.
   */
  static bind<F extends (...args: never[]) => unknown>(callback: F): F {
    return bindAsyncContext(callback)
  }

  /**
   * Snapshot helper matching Node's static: run a callback in the context
   * captured now.
   * @returns a function that runs its argument in the captured context.
   */
  static snapshot(): <R>(callback: () => R) => R {
    const snapshot = AsyncLocalStorage.captureContext()
    return callback => AsyncLocalStorage.runWithContext(snapshot, callback)
  }
}

/** One instance's captured store. */
interface CapturedStore {
  readonly instance: AsyncLocalStorage<unknown>
  readonly store: unknown
}

/** Opaque context copy produced by {@link captureAsyncContext}. */
export type AsyncContextSnapshot = readonly CapturedStore[]

/** Opaque ambient copy produced by {@link __snapshotAll}; covers every live instance. */
export type AmbientSnapshot = readonly CapturedStore[]

/**
 * Copy every live instance's current store.
 * @returns the snapshot, or undefined when no instance has a store or explicit
 * context (the hook layer then wraps nothing and callbacks inherit the stack top).
 */
export function captureAsyncContext(): AsyncContextSnapshot | undefined {
  return AsyncLocalStorage.captureContext()
}

/**
 * Run a callback with a captured context restored into the overlay slots.
 * @param snapshot - context copy, or undefined to run unchanged.
 * @param callback - the callback.
 * @returns the callback's return value.
 */
export function runWithAsyncContext<R>(snapshot: AsyncContextSnapshot | undefined, callback: () => R): R {
  return AsyncLocalStorage.runWithContext(snapshot, callback)
}

/**
 * Capture the current context now and restore it around every later invocation.
 * @param callback - the callback to bind.
 * @returns the bound callback, or the original when no context is active.
 */
export function bindAsyncContext<F extends (...args: never[]) => unknown>(callback: F): F {
  const snapshot = captureAsyncContext()
  if (snapshot === undefined) return callback
  const bound = (...args: never[]): unknown => runWithAsyncContext(snapshot, () => callback(...args))
  return bound as F
}

/**
 * Run a callback at the root: every instance reads `undefined`, whatever was open
 * before. The tunnel's message entry uses this so a queued request never inherits
 * a boundary from unrelated work that happened to run first.
 * @param callback - the callback.
 * @returns the callback's return value.
 */
export function runAtAsyncContextRoot<R>(callback: () => R): R {
  const root: CapturedStore[] = AsyncLocalStorage.liveInstances().map(instance => ({ instance, store: undefined }))
  return runWithAsyncContext(root, callback)
}

/**
 * Pause point of the loader's `await` rewriting: copy the context every live
 * instance currently reads.
 *
 * The transformed module reaches this through the module proxy table
 * (`require('node:async_hooks').__snapshotAll()`), so the rewriter needs no
 * additional plumbing.
 * @returns the ambient snapshot to hand to {@link __restoreAll} after the await.
 */
export function __snapshotAll(): AmbientSnapshot {
  return AsyncLocalStorage.snapshotAll()
}

/**
 * Resume point of the loader's `await` rewriting: publish a paused context as the
 * ambient one, so reads after the await answer what the frame saw before it —
 * even while another chain interleaves.
 * @param snapshot - the copy {@link __snapshotAll} produced at the pause point.
 * @returns a disposer that restores the previous ambient context, identity-checked;
 * a rewriter that wraps a whole function body calls it in that body's `finally`.
 */
export function __restoreAll(snapshot: AmbientSnapshot): () => void {
  return AsyncLocalStorage.restoreAll(snapshot)
}

/**
 * Snapshot face the module loader's `await` rewriting consumes (its `AlsCausality`):
 * the same pair as {@link __snapshotAll}/{@link __restoreAll}, with `restore`
 * narrowed to void because the rewritten code has no place to keep a disposer.
 */
export const alsCausality = {
  snapshot: (): AmbientSnapshot => __snapshotAll(),
  restore: (snapshot: AmbientSnapshot): void => { __restoreAll(snapshot) },
}

/**
 * Async ids are not tracked; a stable id keeps callers that log it working.
 * @returns Always 1.
 */
export function executionAsyncId(): number {
  return 1
}

/**
 * Trigger ids are not tracked either.
 * @returns Always 0.
 */
export function triggerAsyncId(): number {
  return 0
}

/**
 * Async hooks cannot be created: no async resource tracking exists in the worker.
 * @returns Never — it throws naming the unavailable member.
 */
export function createHook(): never {
  throw new Error('web-preview: node:async_hooks.createHook is not available in the worker host')
}

/** Resource construction is likewise unavailable. */
export const AsyncResource: typeof import('node:async_hooks').AsyncResource
  = notImplementedFail('node:async_hooks', 'AsyncResource')

/** CommonJS interop marker: the worker loader hands `default` to default imports (see ./builtins.ts). */
export const __esModule = true

/**
 * The `node:async_hooks` declarations this module stands in for.
 * `AsyncLocalStorage` keeps this module's own class: it carries the store
 * bookkeeping the rewrite route reads through statics Node does not declare, and
 * its `run` is typed for the callback arguments the host tree passes.
 */
type NodeFace = Partial<Omit<typeof import('node:async_hooks'), 'AsyncLocalStorage'>>
  & Record<'AsyncLocalStorage', unknown>

/** CommonJS default export: the members `require()` hands a caller of this module. */
export default {
  AsyncLocalStorage, AsyncResource, executionAsyncId, triggerAsyncId, createHook,
} satisfies NodeFace
