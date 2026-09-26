/**
 * React renderer for declarative slots. Per-entry bindings enforce child
 * authorization, and entry boundaries contain registrant failures.
 */
import {
  Component, createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type FC, type ReactNode,
} from 'react'
import {
  SlotOwnershipError, StaleAuthorizationError, standardHookPropName,
  type ChainRenderOpts, type HostObservable, type KeyedStandardSource, type LocaleFace, type RenderFactorySlot, type RenderOpts,
  type ScopedStandardSourceBinding, type SessionAreaProps, type SessionProviderComponent, type SlotRenderer,
  type SlotRendererHost, type SlotScope, type SlotScopeAdapter, type StandardSourceBinding,
  type StoredEntry, type StoredFactory, type Translate,
} from '@deepseek-ai/dsh-client-ui-slots'
import {
  HostContext, RootStandardProvider, ScopeBindingProvider, ScopeProvider,
  keyedObservableHook, maybeObservableHook, observableHook, useHost, useRootBinding,
  useScopeBinding,
} from './bindings.tsx'
import { SlotAssemblyError } from './errors.ts'

type InjectedProps = Record<string, unknown>

type SlotHookFactory = (standard: InjectedProps, hookContext: unknown) => unknown
type SlotHookFactories = Readonly<Record<string, SlotHookFactory>>

interface BoundSlotInject {
  readonly props: InjectedProps
  readonly slotHookFactories?: SlotHookFactories | undefined
}

type RenderSlotBinding = (key: string, owner: object, opts?: RenderOpts) => ReactNode

type RenderSlotChainBinding = (key: string, owner: object, opts?: ChainRenderOpts) => ReactNode

type FactoryRenderOwner = StoredEntry | StoredFactory
const factoryRenderCache = new WeakMap<FactoryRenderOwner, RenderFactorySlot>()

function boundRenderFactorySlot(caller: FactoryRenderOwner): RenderFactorySlot {
  let render = factoryRenderCache.get(caller)
  if (render !== undefined) return render
  render = ((name: string, props: object, options?: {
    slots?: Readonly<Record<string, FC<InjectedProps>>>
    fallback?: ReactNode
  }) => (
    <FactoryOutlet
      name={name}
      inputProps={props}
      slots={options?.slots}
      fallback={options?.fallback}
      caller={caller}
    />
  )) as RenderFactorySlot
  factoryRenderCache.set(caller, render)
  return render
}

/**
 * Per-entry renderSlot bindings. The binding is identity-stable per entry
 * (memoized components must not resubscribe on unrelated re-renders) and dies
 * with the entry: a retained closure calling after the entry's disposal hits
 * the in-ledger check and throws.
 */
const renderSlotCache = new WeakMap<StoredEntry, RenderSlotBinding>()

function boundRenderSlot(host: SlotRendererHost, entry: StoredEntry): RenderSlotBinding {
  let binding = renderSlotCache.get(entry)
  if (!binding) {
    binding = (key, owner, opts) => {
      if (!host.isLive(entry)) {
        throw new StaleAuthorizationError(`renderSlot('${key}') from a disposed registration`)
      }
      // Plain-JS backstop; typed callers are narrowed to the declared keys.
      const declared = entry.children?.[key]
      if (declared === undefined) {
        throw new SlotOwnershipError(`slot '${key}' is not declared by this entry's children`)
      }
      if (declared.kind === 'chain') {
        throw new SlotOwnershipError(`slot '${key}' is declared 'chain' — use renderSlotChain`)
      }
      return <SlotOutlet slotKey={key} ownerProps={owner} opts={opts} />
    }
    renderSlotCache.set(entry, binding)
  }
  return binding
}

/**
 * Per-entry renderSlotChain bindings: identity-stable per entry (same cache
 * axis as renderSlot — a per-frame dispatch must not rebuild the binding) and
 * dead with the entry. The chain-kind check is the plain-JS backstop twin of
 * the declaration check; typed callers are narrowed to chain keys.
 */
const renderSlotChainCache = new WeakMap<StoredEntry, RenderSlotChainBinding>()

function boundRenderSlotChain(host: SlotRendererHost, entry: StoredEntry): RenderSlotChainBinding {
  let binding = renderSlotChainCache.get(entry)
  if (!binding) {
    binding = (key, owner, opts) => {
      if (!host.isLive(entry)) {
        throw new StaleAuthorizationError(`renderSlotChain('${key}') from a disposed registration`)
      }
      const declared = entry.children?.[key]
      if (declared === undefined) {
        throw new SlotOwnershipError(`slot '${key}' is not declared by this entry's children`)
      }
      if (declared.kind !== 'chain') {
        throw new SlotOwnershipError(`slot '${key}' is declared '${declared.kind}', not 'chain' — use renderSlot`)
      }
      return <SlotOutlet slotKey={key} ownerProps={owner} opts={opts} />
    }
    renderSlotChainCache.set(entry, binding)
  }
  return binding
}

const factoryRenderSlotCache = new WeakMap<StoredFactory, RenderSlotBinding>()
const factoryRenderSlotChainCache = new WeakMap<StoredFactory, RenderSlotChainBinding>()

function boundFactoryRenderSlot(host: SlotRendererHost, definition: StoredFactory): RenderSlotBinding {
  let binding = factoryRenderSlotCache.get(definition)
  if (binding !== undefined) return binding
  binding = (key, owner, opts) => {
    if (!host.isFactoryLive(definition)) {
      throw new StaleAuthorizationError(`renderSlot('${key}') from a disposed Factory`)
    }
    const declared = definition.children?.[key]
    if (declared === undefined) throw new SlotOwnershipError(`slot '${key}' is not declared by this Factory`)
    if (declared.kind === 'chain') throw new SlotOwnershipError(`slot '${key}' is declared 'chain' — use renderSlotChain`)
    return <SlotOutlet slotKey={key} ownerProps={owner} opts={opts} />
  }
  factoryRenderSlotCache.set(definition, binding)
  return binding
}

function boundFactoryRenderSlotChain(host: SlotRendererHost, definition: StoredFactory): RenderSlotChainBinding {
  let binding = factoryRenderSlotChainCache.get(definition)
  if (binding !== undefined) return binding
  binding = (key, owner, opts) => {
    if (!host.isFactoryLive(definition)) {
      throw new StaleAuthorizationError(`renderSlotChain('${key}') from a disposed Factory`)
    }
    const declared = definition.children?.[key]
    if (declared === undefined) throw new SlotOwnershipError(`slot '${key}' is not declared by this Factory`)
    if (declared.kind !== 'chain') {
      throw new SlotOwnershipError(`slot '${key}' is declared '${declared.kind}', not 'chain' — use renderSlot`)
    }
    return <SlotOutlet slotKey={key} ownerProps={owner} opts={opts} />
  }
  factoryRenderSlotChainCache.set(definition, binding)
  return binding
}

/**
 * Inject results cache: root entries per entry, session entries per
 * (entry x scope binding). WeakMap keys are entry/binding objects (both
 * identity-stable per registration/session scope), so cache lifetime rides
 * the same axes as the values it memoizes.
 */
const rootInjectCache = new WeakMap<StoredEntry, InjectedProps>()
const sessionInjectCache = new WeakMap<StoredEntry, WeakMap<StandardSourceBinding, InjectedProps>>()
const sessionMaybeInjectCache = new WeakMap<StoredEntry, WeakMap<StandardSourceBinding, InjectedProps>>()

const EMPTY_INJECTED_PROPS: InjectedProps = {}

function runInject(
  entry: Pick<StoredEntry, 'inject'>,
  binding: StandardSourceBinding | undefined,
  actions: object | undefined,
): InjectedProps {
  const inject = entry.inject
  if (!inject) return EMPTY_INJECTED_PROPS
  // Declaration-derived positional arguments: sessionId for session scope,
  // baked actions when a store is declared.
  const args: unknown[] = []
  if (binding !== undefined) args.push(binding.key)
  if (actions !== undefined) args.push(actions)
  return bindInjectSources((inject as (...args: unknown[]) => InjectedProps)(...args))
}

/** Bind one entry-owned inject face on its existing cache axis. */
function bindInjectSources(face: InjectedProps): InjectedProps {
  const sources = face['hooks']
  const keyedSources = face['keyedHooks']
  if (sources === undefined && keyedSources === undefined) return face
  const { hooks: _hooks, keyedHooks: _keyedHooks, ...rest } = face
  const bound: InjectedProps = rest
  for (const [name, source] of Object.entries(
    (sources ?? {}) as Record<string, HostObservable<unknown>>,
  )) {
    const hookName = standardHookPropName(name)
    bound[hookName] = observableHook(source)
  }
  for (const [name, source] of Object.entries(
    (keyedSources ?? {}) as Record<string, KeyedStandardSource>,
  )) {
    const hookName = standardHookPropName(name)
    bound[hookName] = keyedObservableHook(source)
  }
  return bound
}

const slotInjectCache = new WeakMap<object, BoundSlotInject>()
const EMPTY_SLOT_INJECT: BoundSlotInject = { props: EMPTY_INJECTED_PROPS }

/** Normalize one dispatcher-owned inject face by its stable object identity. */
function cachedSlotInject(face: object | undefined): BoundSlotInject {
  if (face === undefined) return EMPTY_SLOT_INJECT
  let bound = slotInjectCache.get(face)
  if (bound !== undefined) return bound
  const definitions = (face as InjectedProps)['hooks']
  if (definitions === undefined) {
    bound = { props: face as InjectedProps }
    slotInjectCache.set(face, bound)
    return bound
  }
  const { hooks: _hooks, ...rest } = face as InjectedProps
  const props: InjectedProps = rest
  let factories: Record<string, SlotHookFactory> | undefined
  for (const [name, definition] of Object.entries(definitions as Record<string, unknown>)) {
    const hookName = standardHookPropName(name)
    if (typeof definition === 'function') {
      factories ??= {}
      factories[name] = definition as SlotHookFactory
    } else {
      props[hookName] = observableHook(definition as HostObservable<unknown>)
    }
  }
  bound = factories === undefined
    ? { props }
    : { props, slotHookFactories: factories }
  slotInjectCache.set(face, bound)
  return bound
}

/** Bind deferred slot-level factories for one stable renderSlot occurrence. */
function bindSlotHookFactories(
  factories: SlotHookFactories,
  standard: InjectedProps,
  hookContext: unknown,
): InjectedProps {
  const hooks: InjectedProps = {}
  for (const [name, factory] of Object.entries(factories)) {
    const hookName = standardHookPropName(name)
    hooks[hookName] = factory(standard, hookContext)
  }
  return hooks
}

function cachedRootInject(entry: StoredEntry, actions: object | undefined): InjectedProps {
  let props = rootInjectCache.get(entry)
  if (!props) {
    props = runInject(entry, undefined, actions)
    rootInjectCache.set(entry, props)
  }
  return props
}

function cachedSessionInject(entry: StoredEntry, binding: StandardSourceBinding, actions: object | undefined): InjectedProps {
  let perBinding = sessionInjectCache.get(entry)
  if (!perBinding) {
    perBinding = new WeakMap()
    sessionInjectCache.set(entry, perBinding)
  }
  let props = perBinding.get(binding)
  if (!props) {
    props = runInject(entry, binding, actions)
    perBinding.set(binding, props)
  }
  return props
}

function cachedSessionMaybeInject(
  entry: StoredEntry,
  binding: StandardSourceBinding,
  actions: object | undefined,
): InjectedProps {
  let perBinding = sessionMaybeInjectCache.get(entry)
  if (!perBinding) {
    perBinding = new WeakMap()
    sessionMaybeInjectCache.set(entry, perBinding)
  }
  let props = perBinding.get(binding)
  if (!props) {
    props = runInject(entry, binding, actions)
    perBinding.set(binding, props)
  }
  return props
}

/**
 * Locale `t` seat bindings, cached per (face, namespace, revision). The
 * revision is part of the cache key ON PURPOSE: a locale switch mints a NEW
 * function reference per namespace, so `React.memo` components taking `t`
 * re-render through ordinary shallow comparison — freshness rides identity,
 * no extra invalidation channel. Within one revision the reference is stable
 * (memoized children do not churn on unrelated re-renders).
 */
const localeSeatCache = new WeakMap<LocaleFace, Map<string, { revision: number; t: Translate }>>()

function localeSeat(face: LocaleFace, ns: string): Translate {
  let perNs = localeSeatCache.get(face)
  if (!perNs) {
    perNs = new Map()
    localeSeatCache.set(face, perNs)
  }
  const revision = face.getSnapshot().revision
  const cached = perNs.get(ns)
  if (cached && cached.revision === revision) return cached.t
  const bound = face.bind(ns)
  // Fresh wrapper per revision: bind() itself may return a stable reference.
  const t: Translate = (key, params) => bound(key, params)
  perNs.set(ns, { revision, t })
  return t
}

const noopSubscribe = (): (() => void) => () => {}
const zeroRevision = (): number => 0

/**
 * Per-face subscribe/getSnapshot closure pair. Cached by face identity: the
 * face is one global source shared by every outlet, and uSES resubscribes
 * whenever the subscribe reference changes — fresh closures per render would
 * churn one unsubscribe/resubscribe pair per outlet per render.
 */
const localeSubscriptionCache = new WeakMap<LocaleFace, {
  subscribe: (fn: () => void) => () => void
  getRevision: () => number
}>()

function localeSubscription(face: LocaleFace): { subscribe: (fn: () => void) => () => void; getRevision: () => number } {
  let cached = localeSubscriptionCache.get(face)
  if (!cached) {
    cached = {
      subscribe: fn => face.subscribe(fn),
      getRevision: () => face.getSnapshot().revision,
    }
    localeSubscriptionCache.set(face, cached)
  }
  return cached
}

/**
 * Subscribe an outlet to the installed locale face's revision (0 while none
 * is installed — exactly one uSES call either way, keeping hook order
 * stable). Every outlet re-renders on a locale switch; entry bodies then
 * re-derive their `t` seat at the new revision. The face must be installed
 * before the first render that needs it — a face appearing later has no
 * notification channel to already-mounted outlets.
 */
function useLocaleRevision(face: LocaleFace | undefined): number {
  const subscription = face !== undefined ? localeSubscription(face) : undefined
  return useSyncExternalStore(
    subscription?.subscribe ?? noopSubscribe,
    subscription?.getRevision ?? zeroRevision,
  )
}

/**
 * Entry-identity React keys for entry boundaries. An outlet renders one
 * winner per position (single/keyed/list cell head, chain election) through
 * an error boundary; without a key, a boundary that failed on entry A would
 * survive a winner change (re-election, shadowing fallback after an
 * abdication, HMR re-registration) and keep a healthy entry B blacked out.
 * Keying by entry identity remounts the boundary fresh whenever the winner
 * changes (entries are identity-stable per registration, so the key is
 * stable while the same entry stays the winner).
 */
let nextEntryKey = 0
const entryKeys = new WeakMap<StoredEntry, number>()

function entryKeyOf(entry: StoredEntry): number {
  let key = entryKeys.get(entry)
  if (key === undefined) {
    key = nextEntryKey++
    entryKeys.set(entry, key)
  }
  return key
}

let nextSessionGenerationKey = 0
const sessionGenerationKeys = new WeakMap<object, number>()

function sessionGenerationKeyOf(binding: ScopedStandardSourceBinding): number {
  let key = sessionGenerationKeys.get(binding.ctx)
  if (key === undefined) {
    key = nextSessionGenerationKey++
    sessionGenerationKeys.set(binding.ctx, key)
  }
  return key
}

/**
 * Per-entry isolation: one registrant crashing (component render or inject
 * factory) must not take down siblings. Assembly errors (missing providers)
 * rethrow — a miswired shell must fail loud, not degrade into fallbacks.
 * Every catch reports through `onEntryError` (the ledger's supervision
 * seam); for shadowing kinds the report abdicates the entry, the outlet
 * re-renders onto the cell's next survivor, and this boundary's crash face
 * only shows until that re-render lands (permanently once the cell is dry —
 * the outlet then owns the crash face).
 */
class SlotErrorBoundary extends Component<
  { slotKey: string; onEntryError: (error: unknown) => void; children: ReactNode }, { failed: boolean }
> {
  override state = { failed: false }
  static getDerivedStateFromError(error: unknown): { failed: boolean } {
    if (error instanceof SlotAssemblyError) throw error
    return { failed: true }
  }
  override componentDidCatch(error: unknown): void {
    console.error(`slot entry crashed in '${this.props.slotKey}':`, error)
    this.props.onEntryError(error)
  }
  override render(): ReactNode {
    if (this.state.failed) return <div data-slot-error={this.props.slotKey} />
    return this.props.children
  }
}

/** Contain one Factory occurrence without retiring the shared definition. */
/* jscpd:ignore-start */
class FactoryErrorBoundary extends Component<
  { name: string; onEntryError: (error: unknown) => void; children: ReactNode }, { failed: boolean }
> {
  override state = { failed: false }
  static getDerivedStateFromError(error: unknown): { failed: boolean } {
    if (error instanceof SlotAssemblyError) throw error
    return { failed: true }
  }
  override componentDidCatch(error: unknown): void {
    console.error(`slot factory occurrence crashed in '${this.props.name}':`, error)
    this.props.onEntryError(error)
  }
  override render(): ReactNode {
    if (this.state.failed) return <div data-factory-error={this.props.name} />
    return this.props.children
  }
}
/* jscpd:ignore-end */

const rootStandardCache = new WeakMap<StandardSourceBinding, InjectedProps>()
const sessionStandardCache = new WeakMap<StandardSourceBinding, WeakMap<StandardSourceBinding, InjectedProps>>()
const sessionMaybeStandardCache = new WeakMap<StandardSourceBinding, WeakMap<StandardSourceBinding, InjectedProps>>()

/** Materialize one binding into stable framework Hook and plain-prop seats. */
function materializeStandardBinding(
  binding: StandardSourceBinding,
  optional: boolean,
  defaultKey?: string,
): InjectedProps {
  const standard: InjectedProps = { ...binding.props }
  for (const [name, source] of Object.entries(binding.hooks)) {
    if (source === undefined && !optional) {
      throw new SlotAssemblyError(`strict standard hook '${name}' has no source`)
    }
    standard[standardHookPropName(name)] = optional
      ? maybeObservableHook(source)
      : observableHook(source as HostObservable<unknown>)
  }
  for (const [name, source] of Object.entries(binding.keyedHooks)) {
    if (source === undefined && !optional) {
      throw new SlotAssemblyError(`strict keyed standard hook '${name}' has no source resolver`)
    }
    standard[standardHookPropName(name)] = keyedObservableHook(source, defaultKey)
  }
  return standard
}

/** Stable official-props object used by contextual Hook factories. */
function standardProps(
  scope: SlotScope,
  rootBinding: StandardSourceBinding,
  scopeBinding: StandardSourceBinding | undefined,
): InjectedProps {
  let root = rootStandardCache.get(rootBinding)
  if (root === undefined) {
    root = materializeStandardBinding(rootBinding, false)
    rootStandardCache.set(rootBinding, root)
  }
  if (scope === 'root') return root
  if (scopeBinding === undefined) throw new SlotAssemblyError(`scope '${scope}' rendered without a standard-source binding`)
  const cache = scope === 'session' ? sessionStandardCache : sessionMaybeStandardCache
  let perScope = cache.get(rootBinding)
  if (perScope === undefined) {
    perScope = new WeakMap()
    cache.set(rootBinding, perScope)
  }
  let standard = perScope.get(scopeBinding)
  if (standard !== undefined) return standard
  standard = {
    ...materializeStandardBinding(rootBinding, false, scopeBinding.key),
    ...materializeStandardBinding(scopeBinding, scope === 'session-maybe'),
  }
  perScope.set(scopeBinding, standard)
  return standard
}

const scopeAreaCache = new WeakMap<SlotScopeAdapter, SessionProviderComponent>()

/** Bind one domain-owned scope area renderer to the current scope binding. */
function scopeAreaProvider(adapter: SlotScopeAdapter): SessionProviderComponent {
  let Provider = scopeAreaCache.get(adapter)
  if (Provider !== undefined) return Provider
  if (adapter.renderArea === undefined) {
    throw new SlotAssemblyError("scope 'session' adapter does not provide its area renderer")
  }
  const renderArea = adapter.renderArea.bind(adapter)
  Provider = function ScopeAreaProvider(props: SessionAreaProps): ReactNode {
    const inherited = useScopeBinding()
    const explicit = Object.hasOwn(props, 'session')
    const source = adapter.bindingSource(props.session)
    const resolved = useSyncExternalStore(
      listener => source.subscribe(listener),
      () => source.getSnapshot(),
      () => source.getSnapshot(),
    )
    const binding = explicit ? resolved : inherited
    return (
      <ScopeBindingProvider binding={binding}>
        {renderArea(binding, props)}
      </ScopeBindingProvider>
    )
  }
  scopeAreaCache.set(adapter, Provider)
  return Provider
}

/**
 * Standard-kit synthesis shared by both scope branches: the global
 * useSessions/useWorkspaces hooks, the per-session provide bundle (every
 * `hooks` source becomes a `use<Name>` selector hook — useSession is the
 * runtime's own 'session' contribution, no special case — and `props` spread
 * verbatim), the store pair when declared, the renderSlot binding when
 * children are declared, and the SessionProvider seat when the children
 * declare a session-scope slot. Hosts hand out BARE observable sources
 * (hooks never cross the host contract); every hook is bound HERE, cached
 * per source (observableHook), so spreading a fresh kit object per render
 * never churns child subscriptions.
 */
function standardKit(
  host: SlotRendererHost,
  entry: StoredEntry,
  scope: SlotScope,
  rootBinding: StandardSourceBinding,
  scopeBinding: StandardSourceBinding | undefined,
): {
  kit: InjectedProps
  standard: InjectedProps
  actions: object | undefined
} {
  const standard = standardProps(scope, rootBinding, scopeBinding)
  const kit: InjectedProps = { ...standard, renderFactorySlot: boundRenderFactorySlot(entry) }
  if (entry.locale !== undefined) {
    const face = host.locale
    // Loud assembly failure: locale is immediately-tier infrastructure; a
    // declared namespace with no installed face is a miswired composition.
    if (face === undefined) {
      throw new SlotAssemblyError(
        `entry declares locale namespace '${entry.locale}' but no locale face is installed (locale plugin missing from the composition?)`)
    }
    kit['t'] = localeSeat(face, entry.locale)
  }
  const scopedStoreBinding = scopeBinding?.key === undefined
    ? undefined
    : scopeBinding as ScopedStandardSourceBinding
  const store = host.storeOf(entry, scopedStoreBinding)
  if (store !== undefined) {
    // The instance IS an observable snapshot source (contract getSnapshot/
    // subscribe); the useStore hook binds here, cached per instance.
    kit['useStore'] = observableHook(store)
    kit['actions'] = store.actions
  }
  if (entry.children !== undefined) {
    kit['renderSlot'] = boundRenderSlot(host, entry)
    // renderSlotChain rides the same declaration source: only entries whose
    // children include a chain-kind slot receive the chain dispatch seat.
    if (Object.values(entry.children).some(spec => spec.kind === 'chain')) {
      kit['renderSlotChain'] = boundRenderSlotChain(host, entry)
    }
    // The session owner supplies area semantics; the renderer only binds its
    // adapter to the current generic scope source.
    if (Object.values(entry.children).some(spec => spec.scope !== 'root')) {
      const adapter = host.scope('session')
      if (adapter === undefined) {
        throw new SlotAssemblyError("entry declares a session child without an installed 'session' scope adapter")
      }
      kit['SessionProvider'] = scopeAreaProvider(adapter)
    }
  }
  return { kit, standard, actions: store?.actions }
}

/**
 * One rendered entry: standard kit + cached entry inject + common slot inject
 * + owner props (owner wins). The shares are erased at this render boundary;
 * the registration and renderSlot seams already proved their contracts.
 */
function ContextualEntry({
  slotKey, Comp, kit, standard, injected, slotInjected, ownerProps, hookContext, hasHookContext,
}: {
  slotKey: string
  Comp: FC<InjectedProps>
  kit: InjectedProps
  standard: InjectedProps
  injected: InjectedProps
  slotInjected: BoundSlotInject & { readonly slotHookFactories: SlotHookFactories }
  ownerProps: object
  hookContext: unknown
  hasHookContext: boolean
}) {
  const contextual = useMemo(
    () => {
      if (!hasHookContext) {
        throw new SlotAssemblyError(`slot '${slotKey}' has contextual injected Hooks but no hookContext`)
      }
      return bindSlotHookFactories(slotInjected.slotHookFactories, standard, hookContext)
    },
    [hasHookContext, hookContext, slotInjected.slotHookFactories, slotKey, standard],
  )
  return <Comp {...kit} {...injected} {...slotInjected.props} {...contextual} {...ownerProps} />
}

function renderEntry(
  slotKey: string,
  Comp: FC<InjectedProps>,
  kit: InjectedProps,
  standard: InjectedProps,
  injected: InjectedProps,
  slotInjected: BoundSlotInject,
  ownerProps: object,
  hookContext: unknown,
  hasHookContext: boolean,
): ReactNode {
  if (slotInjected.slotHookFactories === undefined) {
    return <Comp {...kit} {...injected} {...slotInjected.props} {...ownerProps} />
  }
  return (
    <ContextualEntry
      slotKey={slotKey}
      Comp={Comp}
      kit={kit}
      standard={standard}
      injected={injected}
      slotInjected={slotInjected as BoundSlotInject & { readonly slotHookFactories: SlotHookFactories }}
      ownerProps={ownerProps}
      hookContext={hookContext}
      hasHookContext={hasHookContext}
    />
  )
}

function SessionEntry({ entry, ownerProps, binding, slotKey, slotInjected, hookContext, hasHookContext }: {
  entry: StoredEntry
  ownerProps: object
  binding: StandardSourceBinding & { readonly key: string }
  slotKey: string
  slotInjected: BoundSlotInject
  hookContext: unknown
  hasHookContext: boolean
}) {
  const host = useHost()
  const rootBinding = useRootBinding()
  const Comp = entry.component as FC<InjectedProps>
  const { kit, standard, actions } = standardKit(host, entry, 'session', rootBinding, binding)
  const injected = cachedSessionInject(entry, binding, actions)
  return renderEntry(slotKey, Comp, kit, standard, injected, slotInjected, ownerProps, hookContext, hasHookContext)
}

function SessionMaybeEntryBody({ entry, ownerProps, binding, slotKey, slotInjected, hookContext, hasHookContext }: {
  entry: StoredEntry
  ownerProps: object
  binding: StandardSourceBinding
  slotKey: string
  slotInjected: BoundSlotInject
  hookContext: unknown
  hasHookContext: boolean
}) {
  const host = useHost()
  const rootBinding = useRootBinding()
  const Comp = entry.component as FC<InjectedProps>
  const { kit, standard, actions } = standardKit(host, entry, 'session-maybe', rootBinding, binding)
  const injected = cachedSessionMaybeInject(entry, binding, actions)
  return renderEntry(slotKey, Comp, kit, standard, injected, slotInjected, ownerProps, hookContext, hasHookContext)
}

/**
 * Session-maybe identity: adoption — the ONLY behavior (there is no
 * hold-identity-forever mode). An incarnation born session-less ADOPTS the
 * first session that arrives: identity holds across that one transition
 * (undefined → first id), so a blank shell's DOM survives the moment a
 * session appears. From then on the entry behaves exactly like a strict
 * session entry: switching to a DIFFERENT session remounts (component-local
 * state must not leak between sessions), and dropping back to no-session
 * remounts into a fresh blank incarnation, which will adopt again.
 * Component-local per-session state therefore clears by construction; state
 * that must SURVIVE a switch belongs in session-bound sources (machine,
 * store, hooks) — the existing layering rule, now load-bearing.
 */
function SessionMaybeEntry({ entry, ownerProps, slotKey, slotInjected, hookContext, hasHookContext }: {
  entry: StoredEntry
  ownerProps: object
  slotKey: string
  slotInjected: BoundSlotInject
  hookContext: unknown
  hasHookContext: boolean
}) {
  const binding = useScopeBinding()
  const epoch = useMaybeIncarnation(binding)
  return (
    <SessionMaybeEntryBody
      key={epoch}
      entry={entry}
      ownerProps={ownerProps}
      binding={binding}
      slotKey={slotKey}
      slotInjected={slotInjected}
      hookContext={hookContext}
      hasHookContext={hasHookContext}
    />
  )
}

/** Adoption bookkeeping of one session-maybe outlet (see SessionMaybeEntry). */
interface MaybeIncarnation {
  /** Session generation this incarnation adopted; undefined while born blank and unadopted. */
  readonly adopted: object | undefined
  /** Incarnation counter — the child key; bumps exactly when an incarnation dies. */
  readonly epoch: number
}

const FIRST_INCARNATION: MaybeIncarnation = { adopted: undefined, epoch: 0 }

function useMaybeIncarnation(binding: StandardSourceBinding): number {
  const identity = binding.key === undefined
    ? undefined
    : (binding as ScopedStandardSourceBinding).ctx
  // The child key is an incarnation counter, NOT the session id: adoption
  // must keep the key constant across undefined → first id. Bookkeeping
  // lives in this stable (unkeyed) wrapper via the render-phase setState
  // form (React's sanctioned derived-state pattern: setState during render
  // of the same component re-renders once before children mount, and the
  // guard conditions make it convergent — StrictMode-safe).
  const [state, setState] = useState<MaybeIncarnation>(FIRST_INCARNATION)
  let { adopted, epoch } = state
  if (identity !== undefined && adopted === undefined) {
    // Adoption: same epoch — no remount.
    adopted = identity
    setState({ adopted, epoch })
  } else if (adopted !== undefined && identity !== undefined && identity !== adopted) {
    // Post-adoption session switch: next incarnation, born already adopted.
    adopted = identity
    epoch += 1
    setState({ adopted, epoch })
  } else if (adopted !== undefined && identity === undefined) {
    // Back to no-session: next incarnation, born blank (adopts anew later).
    adopted = undefined
    epoch += 1
    setState({ adopted, epoch })
  }
  return epoch
}

function RootEntry({ entry, ownerProps, slotKey, slotInjected, hookContext, hasHookContext }: {
  entry: StoredEntry
  ownerProps: object
  slotKey: string
  slotInjected: BoundSlotInject
  hookContext: unknown
  hasHookContext: boolean
}) {
  const host = useHost()
  const rootBinding = useRootBinding()
  const Comp = entry.component as FC<InjectedProps>
  const { kit, standard, actions } = standardKit(host, entry, 'root', rootBinding, undefined)
  const injected = cachedRootInject(entry, actions)
  return renderEntry(slotKey, Comp, kit, standard, injected, slotInjected, ownerProps, hookContext, hasHookContext)
}

interface FactoryOccurrenceValue {
  readonly host: SlotRendererHost
  readonly definition: StoredFactory
  readonly selected: Readonly<Record<string, FC<InjectedProps>>>
  readonly registrationKit: InjectedProps
  readonly rootBinding: StandardSourceBinding
  readonly caller: FactoryRenderOwner
}

const FactoryOccurrenceContext = createContext<FactoryOccurrenceValue | null>(null)
const FactoryAncestryContext = createContext<ReadonlySet<string>>(new Set())
const EMPTY_FACTORY_SELECTION: Readonly<Record<string, FC<InjectedProps>>> = {}

function useFactorySlotRuntime(name: string, fallback: FC<InjectedProps>): FC<InjectedProps> {
  const occurrence = useContext(FactoryOccurrenceContext)
  if (occurrence === null) throw new SlotAssemblyError('useFactorySlot() called outside a Factory occurrence')
  if (!occurrence.host.isFactoryLive(occurrence.definition)) {
    throw new StaleAuthorizationError(`useFactorySlot('${name}') from a disposed Factory`)
  }
  const declared = occurrence.definition.slots?.[name]
  if (declared === undefined) {
    throw new SlotOwnershipError(`local slot '${name}' is not declared by factory '${occurrence.definition.name}'`)
  }
  const selected = occurrence.selected[name]
  const Selected = selected ?? fallback
  const usesFallback = selected === undefined
  const { definition, host } = occurrence
  return useMemo(function bindFactoryLocalComponent() {
    return function BoundFactoryLocalComponent(localProps: InjectedProps): ReactNode {
      const current = useContext(FactoryOccurrenceContext)
      const localScopeBinding = useScopeBinding()
      const localMaybeEpoch = useMaybeIncarnation(localScopeBinding)
      if (!host.isFactoryLive(definition)) {
        throw new StaleAuthorizationError(`local slot '${name}' from a disposed Factory`)
      }
      if (current === null || current.definition !== definition) {
        throw new SlotOwnershipError(`local slot '${name}' rendered outside factory '${definition.name}'`)
      }
      if (declared.scope === 'session' && localScopeBinding.key === undefined) {
        throw new SlotAssemblyError(
          `strict session local slot '${name}' from factory '${definition.name}' rendered without a scope binding`)
      }
      const localOwner = usesFallback ? definition : current.caller
      const localScopeIdentity = declared.scope === 'root'
        ? 'root'
        : declared.scope === 'session'
          ? `session:${sessionGenerationKeyOf(localScopeBinding as ScopedStandardSourceBinding)}`
          : `session-maybe:${localMaybeEpoch}`
      const localStandard = standardProps(declared.scope, current.rootBinding, localScopeBinding)
      const localRegistrationKit = {
        ...current.registrationKit,
        renderFactorySlot: boundRenderFactorySlot(localOwner),
      }
      assertNoPropOverlap(`factory '${definition.name}' local slot '${name}'`, localRegistrationKit, localStandard)
      const provided = { ...localRegistrationKit, ...localStandard }
      assertNoPropOverlap(`factory '${definition.name}' local slot '${name}'`, provided, localProps)
      return (
        <FactoryErrorBoundary
          key={`${definition.name}:${name}:${localScopeIdentity}`}
          name={`${definition.name}:${name}`}
          onEntryError={(error) => { host.reportFactoryError(definition.name, localOwner, error) }}
        >
          <Selected {...provided} {...localProps} />
        </FactoryErrorBoundary>
      )
    }
  }, [Selected, declared.scope, definition, host, name, usesFallback])
}

function assertNoPropOverlap(owner: string, provided: InjectedProps, received: object): void {
  for (const name of Object.keys(received)) {
    if (Object.hasOwn(provided, name)) {
      throw new SlotAssemblyError(`${owner} received duplicate prop '${name}'`)
    }
  }
}

function factoryKit(
  host: SlotRendererHost,
  definition: StoredFactory,
  rootBinding: StandardSourceBinding,
  scopeBinding: StandardSourceBinding | undefined,
  occurrence: object,
): { kit: InjectedProps; registrationKit: InjectedProps; actions: object | undefined } {
  const standard = standardProps(definition.scope, rootBinding, scopeBinding)
  const registrationKit: InjectedProps = { renderFactorySlot: boundRenderFactorySlot(definition) }
  if (definition.locale !== undefined) {
    const face = host.locale
    if (face === undefined) {
      throw new SlotAssemblyError(
        `factory declares locale namespace '${definition.locale}' but no locale face is installed`)
    }
    registrationKit['t'] = localeSeat(face, definition.locale)
  }
  const scoped = scopeBinding?.key === undefined ? undefined : scopeBinding as ScopedStandardSourceBinding
  const store = host.factoryStoreOf(definition, scoped, occurrence)
  if (store !== undefined) {
    registrationKit['useStore'] = observableHook(store)
    registrationKit['actions'] = store.actions
  }
  if (definition.children !== undefined) {
    registrationKit['renderSlot'] = boundFactoryRenderSlot(host, definition)
    if (Object.values(definition.children).some(spec => spec.kind === 'chain')) {
      registrationKit['renderSlotChain'] = boundFactoryRenderSlotChain(host, definition)
    }
    if (Object.values(definition.children).some(spec => spec.scope !== 'root')) {
      const sessionAdapter = host.scope('session')
      if (sessionAdapter === undefined) {
        throw new SlotAssemblyError("factory declares a session child without an installed 'session' scope adapter")
      }
      registrationKit['SessionProvider'] = scopeAreaProvider(sessionAdapter)
    }
  }
  return { kit: { ...standard, ...registrationKit }, registrationKit, actions: store?.actions }
}

interface FactoryOccurrenceProps {
  definition: StoredFactory
  inputProps: object
  selected: Readonly<Record<string, FC<InjectedProps>>>
  caller: FactoryRenderOwner
}

function FactoryOccurrence({ definition, inputProps, selected, caller, binding, maybeEpoch }: FactoryOccurrenceProps & {
  binding: StandardSourceBinding
  maybeEpoch: number
}) {
  if (definition.scope === 'root') {
    return <FactoryOccurrenceBody definition={definition} inputProps={inputProps} selected={selected} caller={caller} />
  }
  if (definition.scope === 'session') {
    if (binding.key === undefined) {
      throw new SlotAssemblyError(`strict session factory '${definition.name}' rendered without a scope binding`)
    }
    return (
      <FactoryOccurrenceBody
        key={sessionGenerationKeyOf(binding as ScopedStandardSourceBinding)}
        definition={definition}
        inputProps={inputProps}
        selected={selected}
        caller={caller}
        scopeBinding={binding}
      />
    )
  }
  return (
    <FactoryOccurrenceBody
      key={maybeEpoch}
      definition={definition}
      inputProps={inputProps}
      selected={selected}
      caller={caller}
      scopeBinding={binding}
    />
  )
}

function FactoryOccurrenceBody({
  definition, inputProps, selected, caller, scopeBinding,
}: FactoryOccurrenceProps & { scopeBinding?: StandardSourceBinding | undefined }) {
  const host = useHost()
  const rootBinding = useRootBinding()
  const occurrence = useRef<object>({}).current
  const localeRevision = useLocaleRevision(host.locale)
  useEffect(
    () => host.retainFactoryOccurrence(definition, occurrence),
    [definition, host, occurrence],
  )
  const { kit, registrationKit, actions } = useMemo(
    () => factoryKit(host, definition, rootBinding, scopeBinding, occurrence),
    [definition, host, localeRevision, occurrence, rootBinding, scopeBinding],
  )
  const injected = useMemo(
    () => runInject(definition, scopeBinding, actions),
    [actions, definition, scopeBinding],
  )
  assertNoPropOverlap(`factory '${definition.name}' inject`, kit, injected)
  const provided = { ...kit, ...injected, useFactorySlot: useFactorySlotRuntime }
  assertNoPropOverlap(`factory '${definition.name}' occurrence`, provided, inputProps)
  const context = useMemo<FactoryOccurrenceValue>(() => ({
    host,
    definition,
    selected,
    registrationKit: { ...registrationKit, ...injected },
    rootBinding,
    caller,
  }), [caller, definition, host, injected, registrationKit, rootBinding, selected])
  const Comp = definition.component as FC<InjectedProps>
  return (
    <FactoryOccurrenceContext.Provider value={context}>
      <Comp {...provided} {...inputProps} />
    </FactoryOccurrenceContext.Provider>
  )
}

function FactoryOutlet({ name, inputProps, slots: selected = EMPTY_FACTORY_SELECTION, fallback, caller }: {
  name: string
  inputProps: object
  slots?: Readonly<Record<string, FC<InjectedProps>>> | undefined
  fallback?: ReactNode
  caller: FactoryRenderOwner
}) {
  const host = useHost()
  const ancestors = useContext(FactoryAncestryContext)
  const binding = useScopeBinding()
  const maybeEpoch = useMaybeIncarnation(binding)
  const version = useSyncExternalStore(
    listener => host.subscribeFactory(name, listener),
    () => host.getFactoryVersion(name),
  )
  const definition = host.factoryOf(name)
  if (definition === undefined) return <>{fallback ?? null}</>
  if (ancestors.has(name)) throw new SlotOwnershipError(`recursive render of factory '${name}'`)
  for (const localName of Object.keys(selected)) {
    if (definition.slots?.[localName] === undefined) {
      throw new SlotOwnershipError(`local slot '${localName}' is not declared by factory '${name}'`)
    }
  }
  const nextAncestors = new Set(ancestors).add(name)
  const scopeIdentity = definition.scope === 'root'
    ? 'root'
    : definition.scope === 'session'
      ? binding.key === undefined
        ? 'session:absent'
        : `session:${sessionGenerationKeyOf(binding as ScopedStandardSourceBinding)}`
      : `session-maybe:${maybeEpoch}`
  return (
    <FactoryErrorBoundary
      key={`${name}:${version}:${scopeIdentity}`}
      name={name}
      onEntryError={(error) => { host.reportFactoryError(name, definition, error) }}
    >
      <FactoryAncestryContext.Provider value={nextAncestors}>
        <FactoryOccurrence
          definition={definition}
          inputProps={inputProps}
          selected={selected}
          caller={caller}
          binding={binding}
          maybeEpoch={maybeEpoch}
        />
      </FactoryAncestryContext.Provider>
    </FactoryErrorBoundary>
  )
}

function StrictSessionEntry({ slotKey, entry, ownerProps, slotInjected, hookContext, hasHookContext, onEntryError }: {
  slotKey: string
  entry: StoredEntry
  ownerProps: object
  slotInjected: BoundSlotInject
  hookContext: unknown
  hasHookContext: boolean
  onEntryError: (error: unknown) => void
}) {
  const binding = useScopeBinding()
  if (binding.key === undefined) {
    throw new SlotAssemblyError(`strict session slot '${slotKey}' rendered without a scope binding`)
  }
  const scopedBinding = binding as ScopedStandardSourceBinding
  // Per-session remount rides this key; per-entry remount rides the outer
  // element's entry-identity key (the outlet's guarded() call).
  return (
    <SlotErrorBoundary slotKey={slotKey} key={sessionGenerationKeyOf(scopedBinding)} onEntryError={onEntryError}>
      <SessionEntry
        entry={entry}
        ownerProps={ownerProps}
        binding={scopedBinding}
        slotKey={slotKey}
        slotInjected={slotInjected}
        hookContext={hookContext}
        hasHookContext={hasHookContext}
      />
    </SlotErrorBoundary>
  )
}

/**
 * Anchor style shared by every outlet wrapper: `display:contents` keeps the
 * wrapper out of layout (grid/flex parents see the slot's own children), so
 * the anchor is purely addressable surface. Module-level constant — a stable
 * reference so the wrapper never diffs its style prop.
 */
const ANCHOR_STYLE = { display: 'contents' } as const

function SlotOutlet({ slotKey, ownerProps, opts }: {
  slotKey: string
  ownerProps: object
  opts?: (RenderOpts & ChainRenderOpts) | undefined
}) {
  const host = useHost()
  // Version tick drives entries() re-read; the host batches per microtask.
  useSyncExternalStore(
    fn => host.subscribe(slotKey, fn),
    () => host.getVersion(slotKey),
  )
  // Locale revision tick: a locale switch re-renders every outlet, and entry
  // bodies re-derive their `t` seat at the new revision (fresh identity).
  useLocaleRevision(host.locale)
  const scopeBinding = useScopeBinding()
  // Anchor contract: every slot render site exposes a stable
  // `[data-slot="<key>"]` wrapper — the addressable seam dynamic styles
  // target — and `display:contents` keeps it layout-neutral. The wrapper
  // rides the outlet, not the dispatch outcome: fallback, crash-face, and
  // undeclared-empty states all render inside it, so the anchor's presence
  // never flickers with registration churn.
  return (
    <div data-slot={slotKey} style={ANCHOR_STYLE}>
      {renderOutletContent(host, slotKey, ownerProps, opts, scopeBinding)}
    </div>
  )
}

/** Kind dispatch behind the outlet anchor (single/keyed/list/chain, fallbacks, crash faces). */
function renderOutletContent(
  host: SlotRendererHost,
  slotKey: string,
  ownerProps: object,
  opts: (RenderOpts & ChainRenderOpts) | undefined,
  scopeBinding: StandardSourceBinding,
): ReactNode {
  const spec = host.specOf(slotKey)
  // Undeclared (or no-longer-declared) keys render empty: a declaring entry's
  // unload returns the slot to the undeclared state while retained elements
  // may still be mounted — natural empty, not an ownership failure.
  if (!spec) return null
  if (spec.kind === 'chain' && opts?.fallbackOnly === true) {
    return renderChainResult(slotKey, null, opts)
  }
  if (spec.scope === 'session' && scopeBinding.key === undefined) {
    throw new SlotAssemblyError(`strict session slot '${slotKey}' rendered without a scope binding`)
  }
  const entries = host.entriesOf(slotKey)
  const slotInjected = cachedSlotInject(spec.inject)

  // The boundary must wrap the Entry ELEMENT, not live inside it: inject
  // factories and kit synthesis run in the Entry body and must land in the
  // per-entry fallback rather than escaping to the tree above.
  const guarded = (entry: StoredEntry, key?: string | number, owner: object = ownerProps) => {
    const hasHookContext = opts !== undefined && Object.hasOwn(opts, 'hookContext')
    const hookContext = opts?.hookContext
    // Shadowing kinds abdicate on crash (the cell falls to its next
    // survivor); chain reports without abdicating — election alternatives
    // resolve at select time, and retiring a crashed elected entry would
    // change the static crash face.
    const onEntryError = (error: unknown) => {
      host.reportEntryError(slotKey, entry, error, { abdicate: spec.kind !== 'chain' })
    }
    return spec.scope === 'session'
      ? (
        <StrictSessionEntry
          slotKey={slotKey}
          entry={entry}
          ownerProps={owner}
          slotInjected={slotInjected}
          hookContext={hookContext}
          hasHookContext={hasHookContext}
          onEntryError={onEntryError}
          key={key}
        />
      )
      : (
        <SlotErrorBoundary slotKey={slotKey} key={key} onEntryError={onEntryError}>
          {spec.scope === 'session-maybe'
            ? (
              <SessionMaybeEntry
                entry={entry}
                ownerProps={owner}
                slotKey={slotKey}
                slotInjected={slotInjected}
                hookContext={hookContext}
                hasHookContext={hasHookContext}
              />
            )
            : (
              <RootEntry
                entry={entry}
                ownerProps={owner}
                slotKey={slotKey}
                slotInjected={slotInjected}
                hookContext={hookContext}
                hasHookContext={hasHookContext}
              />
            )}
        </SlotErrorBoundary>
      )
  }
  // A cell whose every registration abdicated keeps the crash face: the
  // shadowing collapse ran out of survivors, which is a failure state, not
  // the owner's natural-empty fallback.
  const deadCell = () => <div data-slot-error={slotKey} />

  if (spec.kind === 'single') {
    const entry = host.entriesOfSlot(slotKey)[0]
    if (!entry) return entries.length > 0 ? deadCell() : <>{opts?.fallback ?? null}</>
    return guarded(entry, entryKeyOf(entry))
  }
  if (spec.kind === 'keyed') {
    const entry = host.entriesOfSlot(slotKey).find(e => e.options.key === opts?.entryKey)
    if (!entry) {
      const occupied = entries.some(e => e.options.key === opts?.entryKey)
      return occupied ? deadCell() : <>{opts?.fallback ?? null}</>
    }
    return guarded(entry, entryKeyOf(entry))
  }
  if (spec.kind === 'chain') {
    // Entries arrive priority-sorted from the ledger (the core orders at
    // register, ties keep registration sequence). Selectors are pure
    // functions of the owner props (register-face contract), so the routing
    // pass runs per render with zero mount side effects: the first non-null
    // election renders, decliners never mount.
    let elected: ReactNode = null
    for (const entry of entries) {
      let matched: unknown
      try {
        // Chain entries always carry select (SlotCore register validation).
        matched = (entry.select as (owner: object) => unknown)(ownerProps)
      } catch (error) {
        // A throwing selector is a registrant contract breach (select MUST be
        // pure and total), but it runs before the entry's SlotErrorBoundary
        // exists — uncontained it would black out the whole owner region. So
        // it degrades to a decline: the chain and the fallback stay intact,
        // and the breach is reported like a crashed entry.
        console.error(
          `chain selector crashed in '${slotKey}' (${entry.registrant ?? 'unknown registrant'}), treating as declined:`,
          error)
        continue
      }
      if (matched !== null) {
        elected = guarded(entry, entryKeyOf(entry), { ...ownerProps, matched })
        break
      }
    }
    return renderChainResult(slotKey, elected, opts)
  }
  // list: one row per id cell — the cell's shadowing winner, or the crash
  // face once every entry of the cell abdicated (a dry cell must not
  // silently drop its row). Row sequence: registration order refined by
  // explicit order, optional id filter, as before shadowing existed.
  const winners = host.entriesOfSlot(slotKey)
  const rows: { entry: StoredEntry | undefined; id: string | undefined; order: number }[] = winners.map(entry => ({
    entry,
    id: entry.options.id,
    order: entry.options.order ?? 0,
  }))
  const rowIds = new Set(rows.map(row => row.id))
  for (const entry of entries) {
    if (rowIds.has(entry.options.id)) continue
    rowIds.add(entry.options.id)
    // Dry cells anchor their row at the cell head's declared order.
    rows.push({ entry: undefined, id: entry.options.id, order: entry.options.order ?? 0 })
  }
  let list = [...rows].sort((a, b) => a.order - b.order)
  if (opts?.only !== undefined) list = list.filter(item => item.id === opts.only)
  if (list.length === 0) return <>{opts?.fallback ?? null}</>
  // Winner rows key by entry identity (see entryKeyOf); dry-cell rows key by
  // id — the disjoint prefixes keep the two namespaces from colliding.
  return (
    <>
      {list.map((item, i) => item.entry !== undefined
        ? guarded(item.entry, `e${entryKeyOf(item.entry)}`)
        : <div data-slot-error={slotKey} key={`x${item.id ?? i}`} />)}
    </>
  )
}

/** Render a chain election while preserving the overlay fallback's tree position. */
function renderChainResult(
  slotKey: string,
  elected: ReactNode,
  opts: (RenderOpts & ChainRenderOpts) | undefined,
): ReactNode {
  if (!opts?.overlay) return elected ?? <>{opts?.fallback ?? null}</>
  return (
    <>
      <div
        data-chain-overlay-fallback={slotKey}
        style={{ display: elected === null ? 'contents' : 'none' }}
      >
        {opts.fallback ?? null}
      </div>
      {elected}
    </>
  )
}

/** Root outlet: the shell's single ctx-level render entry — an unregistered 'root' is a boot-order failure, never a silent blank. */
function RootOutlet({ ownerProps }: { ownerProps: object }) {
  const host = useHost()
  useSyncExternalStore(
    fn => host.subscribe('root', fn),
    () => host.getVersion('root'),
  )
  useLocaleRevision(host.locale)
  const entry = host.entriesOfSlot('root')[0]
  if (!entry) {
    // Registrations exist but every one abdicated: the shadowing collapse ran
    // dry, so the crash face replaces the tree (registered-but-broken is a
    // crash, not the boot-order assembly failure below).
    if (host.entriesOf('root').length > 0) return <div data-slot-error="root" />
    throw new SlotAssemblyError("renderSlot('root') before any 'root' registration (boot order)")
  }
  // Same anchor contract as SlotOutlet: 'root' is a slot like any other, and
  // display:contents keeps the wrapper out of the shell's layout.
  return (
    <div data-slot="root" style={ANCHOR_STYLE}>
      <SlotErrorBoundary
        slotKey="root"
        key={entryKeyOf(entry)}
        onEntryError={(error) => { host.reportEntryError('root', entry, error, { abdicate: true }) }}
      >
        <RootEntry
          entry={entry}
          ownerProps={ownerProps}
          slotKey="root"
          slotInjected={EMPTY_SLOT_INJECT}
          hookContext={undefined}
          hasHookContext={false}
        />
      </SlotErrorBoundary>
    </div>
  )
}

/**
 * Build the renderer installed into the `ui-renderer` SlotRegistry
 * (ctx.slots.install(createSlotRenderer()) at boot; the service owns the
 * install/renderSlot contract and the double-install/not-installed throws).
 * @returns the renderer.
 */
export function createSlotRenderer(): SlotRenderer {
  return {
    renderRoot(host, ownerProps) {
      return (
        <HostContext.Provider value={host}>
          <RootStandardProvider>
            <ScopeProvider scope="session-maybe">
              <RootOutlet ownerProps={ownerProps} />
            </ScopeProvider>
          </RootStandardProvider>
        </HostContext.Provider>
      )
    },
  }
}
