/**
 * SlotRegistry: the renderer-owned Cordis service over the pure
 * SlotCore (ui-slots owns registration semantics, the declaration ledger,
 * the load-time validations, and the unload cascade). This layer owns what
 * needs a live application: the 'slots/changed' event bridge, register and
 * declaration injection through the caller's ctx.effect (fiber unload
 * collects both), the renderer installation contract (install()/renderSlot('root') +
 * the SlotRendererHost face), and the store INSTANCE axis — handle x scope
 * key -> create/cache, dropped with the last holding entry, and in-memory
 * session instances released without clearing persisted state on scope death.
 */
/* oxlint-disable typescript/no-redundant-type-constituents --
 * `keyof SlotMap & string` is the declare-merge key pattern: SlotMap only
 * holds this package's 'root' row in this compilation unit, but consumers
 * merge keys in; the rule fires on the narrow-map view, not on real
 * redundancy. */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { SlotCore, StaleAuthorizationError, standardHookPropName } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  HostObservable, LiveCompositionNode, LocaleFace, OwnerOf, RegisterFactory, SlotEntryDef, SlotMap, SlotRenderer, SlotRendererHost,
  RootStandardSourceContribution, ScopedStandardSourceBinding, SlotScope, SlotScopeAdapter, SlotSpec,
  StandardSourceBinding, StoredFactory,
  StoreDecl, StoreFactory, StoredEntry, StoreInstanceLike,
} from '@deepseek-ai/dsh-client-ui-slots'
import { SlotAssemblyError } from './errors.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The built-in render-tree root hole (seeded by SlotCore): the one slot the
     * shell itself renders, and the ancestor of every other seat. OCCUPIED by
     * ui-layout's AppFrame, which declares the sidebar, conversation, details,
     * and shell.overlay seats inside it.
     *
     * DO NOT register here. This is a single slot, so a second entry does not
     * sit beside the frame — it shadows it, and a dynamically registered entry
     * is assigned a lower priority than the shipped one, which makes it the
     * winner: the page would render your component alone, with every seat the
     * frame declares gone. For a surface of your own that floats over the whole
     * app, register into `shell.overlay` instead (a list slot: additive, and
     * click-through until your entry opts into pointer events).
     */
    'root': { kind: 'single'; scope: 'root'; owner: RootOwnerProps }
  }
}

/** Root owner share: the shell supplies nothing — the frame is inject-assembled. */
export interface RootOwnerProps { children?: never }

/** Instance key for root-scoped store records (session records key by session id, so the literal cannot collide). */
const ROOT_INSTANCE_KEY = 'root'

/** Canonical type-erased store handle used by the runtime lifecycle map. */
type EngineStoreHandle = Exclude<StoreDecl, StoreFactory>

/** Canonical engine instance derived from the handle's create contract. */
type EngineStoreInstance = ReturnType<EngineStoreHandle['create']>

/** Store axis record: one per live handle, dropped when the last holding entry unloads. */
interface StoreAxisRecord {
  /** Scope of the slot the handle mounted under (the core validated cross-scope conflicts). */
  scope: SlotScope
  /** Live registrations holding the handle. */
  refs: number
  /** Root scope: the single instance under {@link ROOT_INSTANCE_KEY}; session scope: one per session id. */
  instances: Map<string, EngineStoreInstance>
}

interface FactoryStoreOccurrence {
  readonly handle: EngineStoreHandle
  readonly instances: Map<string, EngineStoreInstance>
  retainers: number
}

interface FactoryStoreAxis {
  /** Render-created records stay weak until their occurrence commits. */
  readonly occurrences: WeakMap<object, FactoryStoreOccurrence>
  /** Committed occurrences are enumerable for Session-generation cleanup. */
  readonly mounted: Map<object, FactoryStoreOccurrence>
}

/** Type-erased options view the implementation works with (the typed overloads proved the shares). */
interface ErasedRegisterOptions {
  name: string
  children?: Record<string, SlotSpec<SlotEntryDef>>
  store?: StoreDecl
  inject?: (...args: never[]) => Record<string, unknown>
  key?: string
  id?: string
  order?: number
  label?: string
  /** Chain-slot routing selector (pure; the core validates presence for chain targets). */
  select?: (owner: never) => unknown
  /** Chain-slot explicit ordering override (ascending; registration order otherwise). */
  priority?: number
  /** Declared dictionary namespace (the renderer synthesizes the `t` seat from it). */
  locale?: string
  registrant?: string
}

interface ErasedFactoryOptions {
  name: string
  scope: SlotScope
  children?: Record<string, SlotSpec<SlotEntryDef>>
  store?: StoreDecl
  inject?: (...args: never[]) => Record<string, unknown>
  locale?: string
  slots?: Record<string, { scope: SlotScope }>
}

/** Erased core call face (the service re-erases at its own boundary; the core's typed face targets end callers). */
interface ErasedCore { register(options: object, component: unknown): () => void }
interface ErasedFactoryCore { registerFactory(options: object, component: unknown): () => void }

/** One synchronous effect installed while an injected slot declaration is live. */
type SlotInjectionEffect = (() => void) | Iterable<() => void, void, void>

/** cordis Service layer of the slot system; see the module doc for the split with SlotCore. */
export class SlotRegistry extends Service {
  private readonly _core = new SlotCore()
  /** Store-instance axis: handle -> mounted scope, refcount, resolved instances. */
  private readonly _stores = new Map<EngineStoreHandle, StoreAxisRecord>()
  private readonly _factoryStores = new Map<StoredFactory, FactoryStoreAxis>()
  /** Latest live Context generation for each scoped store key. */
  private readonly _storeScopeOwners = new Map<string, Context>()
  private _renderer: SlotRenderer | undefined
  private _locale: LocaleFace | undefined
  private _host: SlotRendererHost | undefined
  private readonly _rootContributions: RootStandardSourceContribution[] = []
  private readonly _rootListeners = new Set<() => void>()
  private _rootBinding: StandardSourceBinding = {
    key: undefined,
    hooks: {},
    keyedHooks: {},
    props: {},
  }
  private readonly _rootSource = {
    getSnapshot: (): StandardSourceBinding => this._rootBinding,
    subscribe: (listener: () => void): (() => void) => {
      this._rootListeners.add(listener)
      return () => { this._rootListeners.delete(listener) }
    },
  }
  private readonly _scopes = new Map<Exclude<SlotScope, 'root' | 'session-maybe'>, SlotScopeAdapter>()
  private _scopeRevision = 0
  private readonly _scopeListeners = new Set<() => void>()
  private readonly _scopeRevisionSource: HostObservable<number> = {
    getSnapshot: () => this._scopeRevision,
    subscribe: (listener) => {
      this._scopeListeners.add(listener)
      return () => { this._scopeListeners.delete(listener) }
    },
  }

  /**
   * @param ctx - owning root context.
   */
  constructor(ctx: Context) {
    super(ctx, 'slots')
    this._core.onMutate((key) => { ctx.emit('slots/changed', key) })
  }

  /**
   * The ordinary Slot registration API. The typed face IS the core's register
   * (both overloads reused verbatim — one authority, no structural copy;
   * see SlotCore.register for children declaration, store seat, inject
   * face, load-time validation, and the unload cascade). This layer adds:
   * disposal through the caller's ctx.effect (fiber unload = cascade),
   * exclusive-factory minting (`store: createXxxStore` becomes a per-entry
   * handle), the registrant diagnostics stamp, and store-instance lifecycle
   * on the entry axis.
   *
   * Declared here, implemented by prototype assignment below the class: it
   * MUST stay a prototype method (never an instance arrow) — the cordis
   * service proxy binds `this.ctx` to the CALLER's context at call time,
   * which is what routes the effect (and the unload cascade) into the
   * caller's fiber. An arrow property would freeze `this` to the service's
   * own root ctx and silently break per-plugin disposal.
   */
  declare readonly register: SlotCore['register']

  /**
   * Register one reusable Component Factory under the caller's effect lifetime.
   * A Store factory mints one handle per rendered occurrence rather than per
   * definition. Like {@link SlotRegistry.register}, this remains a prototype
   * method so the Cordis proxy binds `this.ctx` to the caller's Context.
   * @param options - runtime definition checked against `SlotFactoryMap`.
   * @param component - reusable Factory Component.
   * @returns the idempotent definition disposer.
   */
  declare readonly registerFactory: RegisterFactory

  /**
   * Install an effect for each declaration lifetime of a slot. The callback
   * runs synchronously when the declaration already exists; otherwise it runs
   * inside the declaring `register()` call after the declaration is committed.
   * Collapse disposes the effect and a later declaration runs it again.
   * Callback effects are synchronous disposers; iterable effects install
   * transactionally and dispose in reverse order. The controller belongs to
   * the caller's fiber, so plugin unload cancels a pending wait and removes any
   * active contribution.
   *
   * @param key - declared SlotMap key to depend on.
   * @param callback - creates one disposer or an iterable of disposers.
   * @returns idempotent disposer for the wait and active effect.
   * @throws callback setup failures synchronously when the slot is already declared.
   */
  inject(key: keyof SlotMap & string, callback: () => SlotInjectionEffect): () => void {
    const ctx = this.ctx
    const disposeController = ctx.effect(() => {
      let active: (() => void) | undefined
      let activeEpoch: number | undefined
      let stopped = false
      let unsubscribe = (): void => {}

      const stop = (): void => {
        if (stopped) return
        // Failure callers retire the injection permanently: a delayed setup
        // failure never retries on a later declaration.
        stopped = true
        unsubscribe()
        const dispose = active
        active = undefined
        activeEpoch = undefined
        dispose?.()
      }

      const reconcile = (): void => {
        if (stopped) return
        const spec = this._core.specDynamic(key)
        const epoch = this._core.declarationEpoch(key)
        if (active !== undefined && activeEpoch === epoch) return
        const dispose = active
        active = undefined
        activeEpoch = undefined
        dispose?.()
        if (spec === undefined) return
        // A declaration lifetime is a nested Cordis effect. This gives
        // generator callbacks the same transactional setup, reverse teardown,
        // diagnostics tree, and idempotence as every other plugin effect.
        const disposeEffect = ctx.effect(callback, `slots.inject(${JSON.stringify(key)}): declaration`)
        active = () => { void disposeEffect() }
        activeEpoch = epoch
      }

      const changed = (): void => {
        try {
          reconcile()
        } catch (error) {
          if ((error as { code?: unknown } | null)?.code === 'INACTIVE_EFFECT') {
            stop()
            return
          }
          stop()
          const failure = error instanceof Error ? error : new Error(String(error))
          queueMicrotask(() => { throw failure })
        }
      }

      unsubscribe = this._core.subscribeDeclaration(key, changed)
      try {
        reconcile()
      } catch (error) {
        stop()
        throw error
      }
      return stop
    }, `slots.inject(${JSON.stringify(key)})`)
    return () => { void disposeController() }
  }

  /**
   * Install the shell's renderer (ui-renderer's createSlotRenderer product).
   * Boot-once: a second install throws. Runs through the caller's ctx.effect,
   * so shell fiber unload uninstalls the renderer.
   * @param renderer - the outlet machinery implementing SlotRenderer.
   */
  install(renderer: SlotRenderer): void {
    if (this._renderer !== undefined) throw new Error('slot renderer already installed (install() is boot-once)')
    this.ctx.effect(() => {
      this._renderer = renderer
      return () => {
        if (this._renderer === renderer) this._renderer = undefined
      }
    }, 'slots.install()')
  }

  /**
   * Install the locale face backing the `t` standard seat (the locale
   * plugin's product; same boot-once discipline as the renderer install).
   * Runs through the caller's ctx.effect, so the installing fiber's unload
   * uninstalls the face.
   * @param face - namespace binder + revision observable.
   */
  installLocale(face: LocaleFace): void {
    if (this._locale !== undefined) throw new Error('locale face already installed (installLocale() is boot-once)')
    this.ctx.effect(() => {
      this._locale = face
      return () => {
        if (this._locale === face) this._locale = undefined
      }
    }, 'slots.installLocale()')
  }

  /**
   * Contribute domain-owned root data. Hook names must be globally unique;
   * registration and disposal republish one atomic root binding.
   * @param contribution - bare sources and stable props.
   * @returns disposer owned by the caller's Cordis fiber.
   */
  provideRoot(contribution: RootStandardSourceContribution): () => void {
    const dispose = this.ctx.effect(() => {
      this._rootContributions.push(contribution)
      try {
        this.rebuildRootBinding()
      } catch (error) {
        this._rootContributions.pop()
        throw error
      }
      return () => {
        const index = this._rootContributions.indexOf(contribution)
        if (index === -1) return
        this._rootContributions.splice(index, 1)
        this.rebuildRootBinding()
      }
    }, 'slots.provideRoot()')
    return () => { void dispose() }
  }

  /**
   * Install the owner adapter for one strict scope. Its optional counterpart
   * resolves through the same adapter.
   * @param scope - strict scope name.
   * @param adapter - current/resolved binding source and release notifications.
   */
  installScope(
    scope: Exclude<SlotScope, 'root' | 'session-maybe'>,
    adapter: SlotScopeAdapter,
  ): void {
    if (this._scopes.has(scope)) throw new Error(`slot scope '${scope}' already has an adapter`)
    this.ctx.effect(() => {
      this._scopes.set(scope, adapter)
      this.publishScopeRevision()
      return () => {
        if (this._scopes.get(scope) === adapter) {
          this._scopes.delete(scope)
          this.publishScopeRevision()
        }
      }
    }, `slots.installScope(${JSON.stringify(scope)})`)
  }

  /**
   * Bind scoped Store instances to one Context generation. Rebinding the key
   * drops the previous generation's memory instances before the new owner can
   * resolve them. Cleanup never clears persisted state, which belongs to the
   * durable scope key, or drops a replacement generation's instances.
   *
   * @param binding - materialized scope identity and its owning Context.
   */
  bindStoreScope(binding: Pick<ScopedStandardSourceBinding, 'key' | 'ctx'>): void {
    const current = this._storeScopeOwners.get(binding.key)
    if (current === binding.ctx) return
    if (current !== undefined) this.releaseStoreScope(binding.key)
    this._storeScopeOwners.set(binding.key, binding.ctx)
    binding.ctx.effect(() => () => {
      if (this._storeScopeOwners.get(binding.key) !== binding.ctx) return
      this._storeScopeOwners.delete(binding.key)
      this.releaseStoreScope(binding.key)
    }, `slots: store scope ${binding.key}`)
  }

  /**
   * The single ctx-level render entry: the shell renders 'root'; every other
   * key renders inside components through the props renderSlot face. All
   * three guards are fail-loud boot-order checks, no fallback.
   * @param key - must be 'root' (runtime-enforced for dynamically composed callers).
   * @param owner - owner share for the root entry (the shell supplies {}).
   * @returns the rendered root tree.
   */
  renderSlot<K extends keyof SlotMap & string>(key: K, owner: OwnerOf<K>): ReturnType<SlotRenderer['renderRoot']> {
    // Widened: in this package's own program SlotMap holds only 'root', which
    // would fold the guard to constant-false; the check exists for plain-JS
    // and cross-program callers where K is wider.
    if ((key as string) !== 'root') {
      throw new Error(`ctx-level renderSlot only renders 'root' (got "${key}"); child slots render through the component props face`)
    }
    if (this._renderer === undefined) {
      throw new Error("slot renderer not installed — boot must call ctx.slots.install(createSlotRenderer()) before rendering 'root'")
    }
    if (this._core.entries('root').length === 0) {
      throw new Error("'root' has no registration — a layout entry must register into 'root' before the shell renders it")
    }
    return this._renderer.renderRoot(this.hostFace(), owner)
  }

  /**
   * Snapshot entries for a key (render-erased view; stable reference between mutations).
   * @param key - SlotMap key.
   * @returns registered entries.
   */
  entries(key: keyof SlotMap & string): readonly StoredEntry[] {
    return this._core.entries(key)
  }

  /**
   * Shadowing winners per cell for a key: the first live (non-abdicated)
   * entry of each cell in priority order — what outlets render; chain keys
   * pass through unchanged (election consumes every entry). The raw
   * {@link SlotRegistry.entries} view stays the inspection surface. Fresh
   * array per call, not a uSES getSnapshot source.
   * @param key - SlotMap key.
   * @returns the winning entry per occupied cell.
   */
  entriesOfSlot(key: keyof SlotMap & string): readonly StoredEntry[] {
    return this._core.entriesOfSlot(key)
  }

  /**
   * Export the current JSON-safe Slot and Factory declaration trees for read-only inspection.
   * @param root - exact live Slot key or `factory:<name>`; omitted returns all roots.
   * @returns selected composition trees.
   */
  snapshot(root?: string): LiveCompositionNode[] {
    return this._core.snapshot(root)
  }

  /**
   * Observe ordinary entry and Factory occurrence crashes through one
   * supervision channel. Fires synchronously after any ordinary-entry
   * abdication mutation. Callers own the disposer (wire it through ctx.effect
   * for fiber-lifetime cleanup, as with {@link SlotRegistry.subscribe}).
   * @param fn - called with the Slot or `factory:<name>` key, crashed
   * registration, cause, and whether an ordinary entry was retired.
   * @returns unsubscribe.
   */
  onEntryError(fn: (
    key: string,
    registration: StoredEntry | StoredFactory,
    error: unknown,
    info: { abdicated: boolean },
  ) => void): () => void {
    return this._core.onEntryError(fn)
  }

  /**
   * Look up a declared spec (register-declared or the built-in 'root').
   * @param key - SlotMap key.
   * @returns spec or undefined.
   */
  spec<K extends keyof SlotMap & string>(key: K): SlotSpec<SlotMap[K]> | undefined {
    return this._core.spec(key)
  }

  /**
   * Subscribe to a key's registration changes (microtask-batched).
   * @param key - SlotMap key.
   * @param fn - change callback.
   * @returns unsubscribe.
   */
  subscribe(key: keyof SlotMap & string, fn: () => void): () => void {
    return this._core.subscribe(key, fn)
  }

  /**
   * Version counter for uSES pairing.
   * @param key - SlotMap key.
   * @returns current version.
   */
  getVersion(key: keyof SlotMap & string): number {
    return this._core.getVersion(key)
  }

  /** Delegating registration path: factory minting + registrant stamp + core write + instance-axis bookkeeping. */
  private _register(options: ErasedRegisterOptions, component: unknown): () => void {
    // Exclusive stores pass the factory itself: minted here into a per-entry
    // handle so the stored entry always carries a resolvable handle (the
    // core's shared-handle scope pinning applies to it harmlessly).
    const store = typeof options.store === 'function' ? options.store() : options.store
    const registrant = options.registrant ?? (this.ctx.fiber as { name?: string } | undefined)?.name
    const erased: ErasedRegisterOptions = {
      ...options,
      ...(store !== undefined ? { store } : {}),
      ...(registrant !== undefined ? { registrant } : {}),
    }
    // Core write first: all load-time validation (undeclared target,
    // duplicate declaration, kind conflicts, cross-scope handle) throws
    // there before this layer commits anything.
    const dispose = (this._core as ErasedCore).register(erased, component)
    if (store !== undefined) {
      const scope = (this._core.specDynamic(options.name) as SlotSpec<SlotEntryDef>).scope
      this._acquire(store, scope)
    }
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      dispose()
      if (store !== undefined) this._release(store)
    }
  }

  private _registerFactory(options: ErasedFactoryOptions, component: unknown): () => void {
    const registrant = (this.ctx.fiber as { name?: string } | undefined)?.name
    const erased = {
      ...options,
      ...(registrant === undefined ? {} : { registrant }),
    }
    const dispose = (this._core as ErasedFactoryCore).registerFactory(erased, component)
    const definition = this._core.factory(options.name)
    if (definition === undefined) throw new Error(`slot factory "${options.name}" disappeared during registration`)
    if (definition.store !== undefined && typeof definition.store !== 'function') {
      this._acquire(definition.store, definition.scope)
    } else if (typeof definition.store === 'function') {
      this._factoryStores.set(definition, {
        occurrences: new WeakMap(),
        mounted: new Map(),
      })
    }
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      dispose()
      this._factoryStores.delete(definition)
      if (definition.store !== undefined && typeof definition.store !== 'function') {
        this._release(definition.store)
      }
    }
  }

  /** Build the domain-neutral host face once; installed adapters remain live through getters. */
  private hostFace(): SlotRendererHost {
    if (this._host !== undefined) return this._host
    // `locale` is a live getter: the face installs (and, under HMR, swaps)
    // on the locale plugin's own fiber lifetime, while this host object is
    // built once — a captured value would strand renders on a dead face. The
    // alias is required: `this` inside the getter is the host literal.
    // oxlint-disable-next-line typescript/no-this-alias
    const service = this
    this._host = {
      subscribe: (key, fn) => this._core.subscribe(key, fn),
      getVersion: key => this._core.getVersion(key),
      entriesOf: key => this._core.entries(key),
      entriesOfSlot: key => this._core.entriesOfSlot(key),
      reportEntryError: (key, entry, error, info) => { this._core.reportEntryError(key, entry, error, info) },
      reportFactoryError: (name, registration, error) => { this._core.reportFactoryError(name, registration, error) },
      specOf: key => this._core.specDynamic(key),
      isLive: entry => this._core.isLive(entry),
      storeOf: (entry, scopeBinding) =>
        entry.store === undefined
          ? undefined
          : this.resolveStore(entry.store as EngineStoreHandle, scopeBinding),
      factoryStoreOf: (definition, scopeBinding, occurrence) =>
        this.resolveFactoryStore(definition, scopeBinding, occurrence),
      retainFactoryOccurrence: (definition, occurrence) =>
        this.retainFactoryOccurrence(definition, occurrence),
      subscribeFactory: (name, fn) => this._core.subscribeFactory(name, fn),
      getFactoryVersion: name => this._core.factoryVersion(name),
      factoryOf: name => this._core.factory(name),
      isFactoryLive: definition => this._core.isFactoryLive(definition),
      root: this._rootSource,
      scopeRevision: this._scopeRevisionSource,
      scope: scope => service._scopes.get(scope === 'session-maybe' ? 'session' : scope),
      get locale() { return service._locale },
    }
    return this._host
  }

  /** Validate and atomically publish the current root contribution roster. */
  private rebuildRootBinding(): void {
    const hooks: Record<string, HostObservable<unknown>> = {}
    const keyedHooks: Record<string, import('@deepseek-ai/dsh-client-ui-slots').KeyedStandardSource> = {}
    const props: Record<string, unknown> = {}
    const finalProps = new Set<string>()
    for (const contribution of this._rootContributions) {
      copyUnique('hook', hooks, contribution.hooks, finalProps, standardHookPropName)
      copyUnique('keyed hook', keyedHooks, contribution.keyedHooks, finalProps, standardHookPropName)
      copyUnique('prop', props, contribution.props, finalProps, name => name)
    }
    this._rootBinding = { key: undefined, hooks, keyedHooks, props }
    for (const listener of [...this._rootListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('root standard-source subscriber failed:', error)
      }
    }
  }

  /** Publish one installed-scope roster transition after the map is authoritative. */
  private publishScopeRevision(): void {
    this._scopeRevision += 1
    for (const listener of [...this._scopeListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('scope-adapter subscriber failed:', error)
      }
    }
  }

  /** Resolve (create or reuse) the store instance for a registered handle under a scope key. */
  private resolveStore(
    handle: EngineStoreHandle,
    scopeBinding: ScopedStandardSourceBinding | undefined,
  ): StoreInstanceLike {
    const record = this._stores.get(handle)
    if (record === undefined) throw new Error('store handle is not registered (entry unloaded, or the handle never went through register)')
    let key: string
    if (record.scope === 'root') {
      key = ROOT_INSTANCE_KEY
    } else {
      if (scopeBinding === undefined) throw new Error(`${record.scope} store resolution requires a session id`)
      key = scopeBinding.key
      this.bindStoreScope(scopeBinding)
    }
    let instance = record.instances.get(key)
    if (instance === undefined) {
      // Session instances get the scope key (the engine suffixes the persist
      // key per session); root instances stay keyless.
      instance = record.scope === 'root' ? handle.create() : handle.create(key)
      record.instances.set(key, instance)
    }
    return instance
  }

  private resolveFactoryStore(
    definition: StoredFactory,
    scopeBinding: ScopedStandardSourceBinding | undefined,
    occurrence: object,
  ): StoreInstanceLike | undefined {
    if (!this._core.isFactoryLive(definition)) {
      throw new StaleAuthorizationError(`slot factory "${definition.name}" is not registered`)
    }
    const declaration = definition.store
    if (declaration === undefined) return undefined
    if (typeof declaration !== 'function') {
      return this.resolveStore(declaration, scopeBinding)
    }
    const axis = this._factoryStores.get(definition) as FactoryStoreAxis
    const scopeKey = definition.scope === 'root'
      ? ROOT_INSTANCE_KEY
      : requireScopeKey(definition, scopeBinding)
    if (scopeBinding !== undefined && definition.scope !== 'root') this.bindStoreScope(scopeBinding)
    let record = axis.occurrences.get(occurrence)
    if (record === undefined) {
      const handle = declaration()
      if (handle.spec.persist !== undefined) {
        throw new SlotAssemblyError(
          `exclusive store for factory "${definition.name}" cannot declare persistence`,
        )
      }
      record = { handle, instances: new Map(), retainers: 0 }
      axis.occurrences.set(occurrence, record)
    }
    const existing = record.instances.get(scopeKey)
    if (existing !== undefined) return existing
    const instance = definition.scope === 'root' || scopeBinding === undefined
      ? record.handle.create()
      : record.handle.create(scopeBinding.key)
    record.instances.set(scopeKey, instance)
    return instance
  }

  private retainFactoryOccurrence(definition: StoredFactory, occurrence: object): () => void {
    if (!this._core.isFactoryLive(definition)) return () => {}
    if (typeof definition.store !== 'function') return () => {}
    const axis = this._factoryStores.get(definition) as FactoryStoreAxis
    const record = axis.occurrences.get(occurrence) as FactoryStoreOccurrence
    record.retainers += 1
    axis.mounted.set(occurrence, record)
    let released = false
    return () => {
      if (released) return
      released = true
      record.retainers -= 1
      if (record.retainers !== 0) return
      axis.mounted.delete(occurrence)
    }
  }

  /** Drop every materialized non-root Store instance for one ended Context generation. */
  private releaseStoreScope(key: string): void {
    for (const record of this._stores.values()) {
      if (record.scope === 'root') continue
      record.instances.delete(key)
    }
    for (const axis of this._factoryStores.values()) {
      for (const record of axis.mounted.values()) record.instances.delete(key)
    }
  }

  /** Bind (or re-reference) a handle on the axis; cross-scope conflicts already threw in the core. */
  private _acquire(handle: EngineStoreHandle, scope: SlotScope): void {
    const record = this._stores.get(handle)
    if (record === undefined) {
      this._stores.set(handle, { scope, refs: 1, instances: new Map() })
      return
    }
    record.refs += 1
  }

  /** Drop one reference; the last holder's unload drops the record (instances go with it — engine stores need no explicit dispose). */
  private _release(handle: EngineStoreHandle): void {
    const record = this._stores.get(handle)
    /* v8 ignore next -- defensive: release only runs from a disposer whose
     * register acquired the same handle, so the record must exist; kept so a
     * future call site cannot underflow the axis. */
    if (record === undefined) return
    record.refs -= 1
    if (record.refs !== 0) return
    this._stores.delete(handle)
  }
}

function copyUnique<T>(
  kind: string,
  target: Record<string, T>,
  values: Readonly<Record<string, T>> | undefined,
  finalProps: Set<string>,
  propNameOf: (name: string) => string,
): void {
  if (values === undefined) return
  for (const [name, value] of Object.entries(values)) {
    const propName = propNameOf(name)
    if (finalProps.has(propName)) {
      throw new Error(`duplicate root standard ${kind} '${name}' at prop '${propName}'`)
    }
    finalProps.add(propName)
    target[name] = value
  }
}

// register's implementation (prototype assignment pairs with the `declare`
// inside the class — see its JSDoc for why it must live on the prototype).
// Element access reaches the private _register legally and keeps it a
// TS-visible read.
;(SlotRegistry.prototype as { register: (options: object, component: unknown) => () => void }).register
  = function register(this: SlotRegistry, rawOptions: object, component: unknown): () => void {
    // The core's overloads proved the shares; the implementation works on
    // the erased view (same pattern as the core's own implementation arm).
    const options = rawOptions as ErasedRegisterOptions
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return this.ctx.effect(() => this['_register'](options, component), 'slots.register()')
  }

;(SlotRegistry.prototype as { registerFactory: (options: object, component: unknown) => () => void }).registerFactory
  = function registerFactory(this: SlotRegistry, rawOptions: object, component: unknown): () => void {
    const options = rawOptions as ErasedFactoryOptions
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return this.ctx.effect(() => this['_registerFactory'](options, component), 'slots.registerFactory()')
  }

function requireScopeKey(
  definition: StoredFactory,
  binding: ScopedStandardSourceBinding | undefined,
): string {
  if (binding === undefined) {
    throw new Error(`${definition.scope} factory store resolution requires a session id`)
  }
  return binding.key
}
