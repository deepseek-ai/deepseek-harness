/** Framework-neutral snapshot and store contracts. */

/** Minimal observable snapshot source shared by controllers, stores, and render adapters. */
export interface ObservableSnapshot<T> {
  /** Read the cached snapshot reference. */
  getSnapshot(): T
  /**
   * Subscribe to snapshot invalidation.
   * @param fn - invalidation callback.
   * @returns unsubscribe function.
   */
  subscribe(fn: () => void): () => void
}

/**
 * Typed selector hook over a snapshot source. Canonical shape for the whole
 * slot system (ui-renderer's engine hook is structurally identical; the
 * framework is the only party that ever constructs one).
 */
export type SnapshotSelectorHook<T> = <S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean) => S

/**
 * Selector hook over a source that follows the current session. The hook is
 * always present, while its selected value is absent whenever no session is
 * current. This keeps hook call sites stable across no-session/session
 * transitions without pretending that a session snapshot exists.
 */
export type MaybeSnapshotSelectorHook<T> =
  <S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean) => S | undefined

/**
 * Action declaration table: pure immer-draft transforms over the store state,
 * declared as the store's complete write set (the audit face — components can
 * only write through these).
 */
/* oxlint-disable-next-line typescript/no-explicit-any --
 * any[] (not unknown[]): each action carries its own parameter list, and
 * unknown[] would reject every concrete signature under strict parameter
 * contravariance. Params are re-inferred per action by BakedActions. */
export type ActionsDecl<T> = Record<string, (draft: T, ...params: any[]) => void>

/**
 * Draft-stripped callback form of an actions table: what components
 * (`props.actions`) and inject factories receive — the framework bakes the
 * draft parameter away by binding each action to the resolved instance.
 */
export type BakedActions<T, A extends ActionsDecl<T>> = {
  [K in keyof A]: A[K] extends (draft: T, ...params: infer P) => void ? (...params: P) => void : never
}

/**
 * Store declaration spec: initial-state factory (a lambda so every instance
 * gets a fresh state), optional persistence key (mechanical, framework-run),
 * and the actions write set.
 */
export interface StoreSpec<T, A extends ActionsDecl<T>> {
  init: () => T
  persist?: string
  actions: A
}

/**
 * Live engine instance: the create() product consumed by the render machinery
 * and by tests. A bare snapshot source plus the baked write set — no React
 * hook rides the engine product (the engine lives in this React-free package);
 * the render machinery binds the `useStore` hook from this source on its own
 * side, cached per instance. Production components and render paths never
 * call create() themselves — instance lifecycle is the framework's.
 */
export interface StoreInstance<T, A extends ActionsDecl<T>> {
  readonly actions: BakedActions<T, A>
  getSnapshot(): T
  /**
   * Subscribe to state changes (uSES subscribe side).
   * @param fn - change callback.
   * @returns unsubscribe.
   */
  subscribe(fn: () => void): () => void
  /**
   * Explicitly drop this instance's persisted value.
   * Runtime scope teardown does not call this operation.
   */
  clearPersisted(): void
}

/**
 * Store handle: spec + state/actions types + shared identity + instance
 * factory in one value. Handles are constructed in apply world (shared across
 * registrations of one plugin) or by the framework from a registrant's
 * factory (exclusive). Never export a handle at module level — module-cache
 * identity is a disguised singleton across plugin reloads.
 */
export interface StoreHandle<T, A extends ActionsDecl<T>> {
  readonly spec: StoreSpec<T, A>
  /**
   * Create a live engine instance (framework machinery and tests only).
   * @param scopeKey - session id for session-scope instances; suffixes the
   * persist key so per-session instances persist independently (root-scope
   * instances omit it).
   * @returns a fresh instance seeded from `spec.init()`.
   */
  create(scopeKey?: string): StoreInstance<T, A>
}

/**
 * Exclusive-store registration form: the registrant passes the factory itself
 * and the framework calls it per entry x scope (no shared identity exists).
 */
/* oxlint-disable-next-line typescript/no-explicit-any --
 * erased position accepting every StoreHandle instantiation; T/A are
 * recovered per use site by conditional inference (HandleOf/BoundActions/
 * PropsStore). */
export type StoreFactory = () => StoreHandle<any, any>

/** The register `store` option position: a shared handle or an exclusive factory. */
// oxlint-disable-next-line typescript/no-explicit-any -- same erased-constraint position as StoreFactory (see above).
export type StoreDecl = StoreHandle<any, any> | StoreFactory

/** Normalize a store declaration to its handle type (factories yield their return). */
export type HandleOf<H> = H extends () => infer R ? R : H

/**
 * Handle-keyed baked actions: the `actions` parameter of an inject factory
 * whose registration declared a store — the same baked callback set the
 * component receives via {@link PropsStore}.
 */
export type BoundActions<H> = H extends StoreHandle<infer T, infer A> ? BakedActions<T, A> : never

/**
 * The store props share, derived from the declared handle: a typed selector
 * hook plus the baked write set. Components never see the instance itself
 * (no update/set — reads via useStore, writes via the declared actions only).
 */
export type PropsStore<H> = H extends StoreHandle<infer T, infer A>
  ? { useStore: SnapshotSelectorHook<T>; actions: BakedActions<T, A> }
  : object

/**
 * The defineStore contract (implementation lives beside this declaration,
 * bound to the snapshot-store engine): spec in, handle out, with T inferred
 * from `init` and the actions table constrained by T.
 */
export type DefineStore = <T, A extends ActionsDecl<T>>(spec: StoreSpec<T, A>) => StoreHandle<T, A>
