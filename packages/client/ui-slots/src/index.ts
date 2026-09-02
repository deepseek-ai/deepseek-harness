/**
 * Slot registry pure core. Owners declare slot
 * contracts by merging into {@link SlotMap}; one `register` call contributes a
 * component AND (optionally) declares child slots, a store seat, and the
 * registrant's business face. Zero runtime dependencies (React types only).
 *
 * SlotMap and the standard-kit interfaces live directly in this entry module:
 * consumer `declare module` augmentation merges with declarations lexically in
 * the augmented module, not with re-exports.
 */
/* oxlint-disable typescript/no-redundant-type-constituents --
 * `keyof SlotMap & string` is the declare-merge key pattern: SlotMap is empty
 * in THIS compilation unit (so the intersection reads as `never`), but every
 * consumer merges keys in and the intersection is what keeps them string-typed.
 * The rule fires on the empty-map view, not on real redundancy. */
import type { ReactNode } from 'react'
import type {
  BoundActions, HandleOf, PropsStore, SnapshotSelectorHook, StoreDecl,
} from '@deepseek-ai/dsh-client-store'
import type { HostObservable, KeyedStandardSource } from './renderer.ts'

export * from './store.ts'
export * from './renderer.ts'

/** Slot contract table. Owners extend via declaration merging; entries are {@link SlotEntryDef}. */
export interface SlotMap {}

/**
 * Locale namespace table. Dictionary owners extend via declaration merging
 * (exactly like {@link SlotMap}, and declared in this entry module for the
 * same lexical-merge reason): the key is the namespace string, the value is
 * the union of its dictionary keys. Register sites declare one of these
 * namespaces (`locale:`), which puts the typed `t` standard seat on the
 * component props.
 */
export interface LocaleNamespaceMap {}

/**
 * Translate a dictionary key with optional `{name}` template params.
 * `K` narrows the accepted keys to the owning namespace's dictionary union
 * (plus the shared common vocabulary where composed).
 */
export type Translate<K extends string = string> =
  (key: K, params?: Record<string, unknown>) => string

/**
 * The shared `common` vocabulary keys as merged by the locale plugin;
 * resolves to `never` in programs without the merge (this package's tests),
 * keeping the union collapse harmless.
 */
export type CommonKeyOf = LocaleNamespaceMap extends { common: infer C } ? C & string : never

/**
 * Key domain of a namespace-bound translate: the namespace's own dictionary
 * union plus the shared common vocabulary (the lookup chain consults common
 * after the namespace misses).
 */
export type LocaleKeysOf<N extends keyof LocaleNamespaceMap & string> =
  (LocaleNamespaceMap[N] & string) | CommonKeyOf

/**
 * Namespace-addressed translate — the developer-facing alias over
 * {@link Translate}: `TranslateNS<'model'>` is the translate function of the
 * `model` namespace (key domain = its dictionary union plus the shared
 * common vocabulary), the exact type of the framework-injected `t` seat and
 * of the locale service's typed `bind`.
 */
export type TranslateNS<N extends keyof LocaleNamespaceMap & string> = Translate<LocaleKeysOf<N>>

/**
 * Dictionary shape for a declared namespace: exactly the keys the namespace
 * merged into {@link LocaleNamespaceMap} — a missing or extra key at a typed
 * registration site is a compile error.
 */
export type LocaleDictOf<N extends keyof LocaleNamespaceMap & string> =
  Record<LocaleNamespaceMap[N] & string, string>

/**
 * Locale share of the composed component props: the framework-injected `t`
 * seat, present exactly on entries whose registration declares `locale:`.
 */
export type PropsLocale<N> = N extends keyof LocaleNamespaceMap & string
  ? {
    /** Translate a dictionary key of the declared namespace (or the shared common vocabulary). */
    t: TranslateNS<N>
  }
  : object

/** Slot cardinality: single occupant, ordered list, key-dispatched, or selector-routed chain. */
export type SlotKind = 'single' | 'list' | 'keyed' | 'chain'

/** Slot data context: global, current-session-optional, or strict session-bound. */
export type SlotScope = 'root' | 'session-maybe' | 'session'

/**
 * One SlotMap entry: kind/scope axes plus the optional owner-supplied props
 * share (`owner` is what the parent passes at its renderSlot call site; the
 * framework standard kit and the registrant's injected share never enter this
 * table — full component props compose at the component as the four-share
 * intersection, see {@link ComposedProps}).
 */
export interface SlotEntryDef {
  kind: SlotKind
  scope: SlotScope
  owner?: object
  /**
   * Optional keyed-entry prop table. A keyed registration contributes one
   * literal key and receives the corresponding prop share; ordinary owner
   * props remain common to every key.
   */
  keyProps?: Record<string, object>
  /**
   * Optional opaque context carried by one renderSlot occurrence. Only
   * function-valued members of the slot-level injected hooks compartment
   * receive it; the slot machinery never interprets the value.
   */
  hookContext?: unknown
  /**
   * Optional Slot-level inject face supplied by the parent registration's
   * child declaration. Every registered entry receives its bound component
   * face; child registrants do not own or replace this common capability.
   */
  inject?: object
}

/**
 * Runtime dispatch spec for one slot, recorded from a register call's
 * `children` value. The literal is compile-time checked against the SlotMap
 * entry (`SlotSpec<SlotMap[P]>` in {@link ChildrenDecl}), so kind, scope, and
 * any common inject face are declared at one point and validate each other.
 */
export type SlotSpec<E extends SlotEntryDef> = {
  kind: E['kind']
  scope: E['scope']
} & ('inject' extends keyof E
  ? E extends { inject: infer Injected extends object }
    ? { inject: Injected }
    : { inject?: object }
  : { inject?: never })

/**
 * Child-slot declaration table for register(): keys are the declared (and
 * thereby render-authorized) slot names, values are their runtime dispatch
 * specs. Declaring is claiming: the registering entry becomes the only entry
 * allowed to render these keys.
 */
export type ChildrenDecl = { [P in keyof SlotMap & string]?: SlotSpec<SlotMap[P]> }

/** Owner-supplied props share for a slot key ({} for entries declaring no `owner`). */
export type OwnerOf<K extends keyof SlotMap & string> =
  SlotMap[K] extends { owner: infer O extends object } ? O : object

/** Registration/dispatch key domain of one keyed slot. */
export type EntryKeyOf<K extends keyof SlotMap & string> =
  SlotMap[K] extends { kind: 'keyed'; keyProps: infer P extends object }
    ? keyof P & string
    : string

/** Key-dependent props supplied by the owner at one keyed dispatch site. */
export type KeyPropsOf<
  K extends keyof SlotMap & string,
  EntryKey extends EntryKeyOf<K>,
> = SlotMap[K] extends { kind: 'keyed'; keyProps: infer P extends object }
  ? EntryKey extends keyof P
    ? P[EntryKey] extends object ? P[EntryKey] : never
    : never
  : object

/** Opaque per-render occurrence context declared by one slot. */
export type HookContextOf<K extends keyof SlotMap & string> =
  SlotMap[K] extends { hookContext: infer Context } ? Context : never

/** Common render-occurrence inject face declared by one slot. */
export type SlotInjectOf<K extends keyof SlotMap & string> =
  SlotMap[K] extends { inject: infer Injected extends object } ? Injected : object

/** Scope axis of a slot key's SlotMap entry. */
export type ScopeOf<K extends keyof SlotMap & string> = SlotMap[K]['scope']

/**
 * Framework standard kit delivered to every session-scope slot component.
 * Declared empty here (zero-dependency layer): `ui-session` merges the
 * Session lifecycle hook, projection hook, and Session identity; domain UI
 * adapters merge their own standard hooks exactly as consumers merge SlotMap keys.
 */
export interface SessionStandardProps {}

/**
 * Framework standard kit delivered to current-session-optional slots. Its
 * hooks stay callable while no session is selected and return `undefined`
 * until one becomes current; `ui-session` and domain UI adapters merge the
 * concrete members.
 */
export interface SessionMaybeStandardProps {}

/**
 * Framework standard kit delivered to EVERY slot component (the global seat).
 * Declared empty here; each owning UI adapter merges the global selector hooks
 * that shared page composition consumes.
 */
export interface GlobalStandardProps {}

/**
 * The session id type as `ui-session`'s SessionStandardProps merge declares it
 * (branded); falls back to `string` in programs without the merge (this
 * package's own tests).
 */
export type SessionIdOf = SessionStandardProps extends { sessionId: infer S } ? S : string

/**
 * Runtime props share for a slot key: owner share (parent's renderSlot call
 * site) + session standard kit (session scope only) + the global seat.
 */
export type PropsRuntime<
  K extends keyof SlotMap & string,
  EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>,
> =
  OwnerOf<K> &
  KeyPropsOf<K, EntryKey> &
  SlotInjectFace<SlotInjectOf<K>> &
  (ScopeOf<K> extends 'session' ? SessionStandardProps
    : ScopeOf<K> extends 'session-maybe' ? SessionMaybeStandardProps
      : object) &
  GlobalStandardProps

/** renderSlot dispatch options: keyed dispatch key, list filtering, and empty fallback. */
export interface RenderOpts<EntryKey extends string = string> {
  entryKey?: EntryKey
  only?: string
  fallback?: ReactNode
  /** Type-erased runtime seat; PropsRenderSlots narrows or removes it per slot declaration. */
  hookContext?: unknown
}

/** renderSlotChain dispatch options. */
export interface ChainRenderOpts {
  /** The owner's fallback body, rendered when every entry's selector declines. */
  fallback?: ReactNode
  /** Render only the owner fallback without resolving or dispatching the chain's scope. */
  fallbackOnly?: boolean
  /**
   * Keep the fallback permanently mounted: an election hides it (wrapped,
   * display:none) instead of unmounting it, and the all-decline case shows it
   * as-is — fallback-held state (composer drafts, DOM state) survives a
   * takeover. Chain kind only; the sole consumer is the
   * `conversation.composer` chain.
   */
  overlay?: boolean
}

/**
 * Chain-entry selector: the routing decision of one chain contribution.
 * Runs at render time in chain order (ascending `priority`, default 0, lower
 * tries first; ties keep registration = assembly order); the first non-null
 * return elects its entry
 * and becomes the component's `matched` prop; `null` passes to the next
 * entry; all-null falls to the owner's {@link ChainRenderOpts} fallback.
 * MUST be pure — a function of the owner props only, no external mutable
 * reads, no side effects (the decline decision lives here, never in a
 * mounted component probing its own props).
 */
export type ChainSelect<O extends object, M> = (owner: O) => M | null

/** Keys of a slot-key union whose SlotMap entry is chain-kind (renderSlotChain's dispatch domain). */
export type ChainKeysOf<S extends keyof SlotMap & string> =
  S extends unknown ? (SlotMap[S]['kind'] extends 'chain' ? S : never) : never

/** Keys in a render share whose dispatch occurrence requires hookContext. */
type ContextualKeysOf<S extends keyof SlotMap & string> =
  S extends unknown ? (SlotMap[S] extends { hookContext: unknown } ? S : never) : never

/** Keys in a render share with the ordinary optional options bag. */
type OrdinaryKeysOf<S extends keyof SlotMap & string> = Exclude<S, ContextualKeysOf<S>>

/**
 * Plain and contextual child dispatch signatures. Keeping them as separate
 * call signatures preserves ordinary renderSlot assignability while making a
 * declared hookContext mandatory only for the Slot keys that need it.
 */
type RenderSlotFn<S extends keyof SlotMap & string> =
  ([ContextualKeysOf<S>] extends [never] ? object : {
    <
      K extends ContextualKeysOf<S>,
      EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>,
    >(
      key: K,
      owner: OwnerOf<K> & KeyPropsOf<K, NoInfer<EntryKey>>,
      opts: RenderOpts<EntryKey> & { hookContext: HookContextOf<K> },
    ): ReactNode
  }) &
  ([OrdinaryKeysOf<S>] extends [never] ? object : {
    <
      K extends OrdinaryKeysOf<S>,
      EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>,
    >(
      key: K,
      owner: OwnerOf<K> & KeyPropsOf<K, NoInfer<EntryKey>>,
      opts?: Omit<RenderOpts<EntryKey>, 'hookContext'>,
    ): ReactNode
  })

/**
 * Chain matched share: a chain-slot component receives its selector's
 * non-null result as the framework-injected `matched` prop; other kinds add
 * nothing to the composed constraint.
 */
export type MatchedShare<E extends SlotEntryDef, M> =
  E['kind'] extends 'chain' ? { matched: M } : object

/** Props of the standard-kit SessionProvider seat. */
export interface SessionAreaProps {
  /** No-session body (also covers a current id whose session cannot be resolved). */
  empty?: (() => ReactNode) | undefined
  /** Session body; the framework remounts it per session identity. */
  children: ReactNode
}

/**
 * Framework-wired session area component. `ui-session` supplies the current
 * Controller binding through the renderer scope adapter; entries that declare
 * session-scoped children receive this component without importing it.
 */
export type SessionProviderComponent = (props: SessionAreaProps) => ReactNode

/**
 * Child-slot render share: `renderSlot` statically narrowed to the entry's
 * declared children keys. Delegation is plain props passing (hand
 * `props.renderSlot` down); the authorizing identity stays the registering
 * entry. `__renders` is a phantom variance anchor (never materialized):
 * generic method signatures compare loosely across differing key unions, so
 * this contravariant marker is what actually enforces "component key set ⊆
 * children declaration" at the register call site.
 */
export type PropsRenderSlots<S extends keyof SlotMap & string> = {
  /**
   * Render a declared non-chain child slot (chain keys dispatch through
   * `renderSlotChain` — their routing lives in entry selectors).
   * @param key - declared child key.
   * @param owner - owner props share for that key (decided at the render site).
   * @param opts - kind dispatch options.
   * @returns rendered node(s).
   */
  renderSlot: RenderSlotFn<Exclude<S, ChainKeysOf<S>>>
  readonly __renders?: ((key: S) => void) | undefined
} & ([ChainKeysOf<S>] extends [never] ? object : {
  /**
   * Render a declared chain child slot: entry selectors run in chain order
   * over `owner`; the first non-null match renders its component with the
   * selector result injected as `matched`; all-null renders `opts.fallback`.
   * @param key - declared chain child key.
   * @param owner - owner props share (the selectors' routing input).
   * @param opts - fallback body for the all-null case.
   * @returns rendered node(s).
   */
  renderSlotChain: <K extends ChainKeysOf<S>>(key: K, owner: OwnerOf<K>, opts?: ChainRenderOpts) => ReactNode
}) & ('session' extends ScopeOf<S>
  // The SessionProvider seat rides the same source as renderSlot: declaring
  // a session-scope child is what makes a session area exist, so the seat
  // derives from the children key set's scopes (renderer injects the value).
  ? { SessionProvider: SessionProviderComponent }
  : object)

/**
 * Registration-position component shape: the bare call signature, so composed
 * constraints check through clean parameter contravariance (FC statics add
 * covariant noise rejecting legitimate narrowings).
 */
export type SlotComponent<P> = (props: P) => ReactNode

/**
 * Registrant hooks compartment: bare observable sources (getSnapshot +
 * subscribe pairs) supplied under the reserved `hooks` key of an entry's
 * inject face. These retain the original source-to-selector binding and do
 * not participate in render-occurrence context.
 */
export type HooksSources = Record<string, HostObservable<unknown>>

/** Registrant keyed-hooks compartment: stable key-to-observable resolvers. */
export type KeyedHooksSources = Record<string, KeyedStandardSource>

/** Selector Hook over an open family of keyed observable sources. */
export type KeyedSnapshotSelectorHook<Snapshot> = {
  /** @param key - source key. @returns the current value, or absence when the source is unavailable. */
  (key: string): Snapshot | undefined
  /**
   * @param key - source key.
   * @param selector - projection over the current keyed value.
   * @param equal - optional selected-value equality.
   * @returns the selected value.
   */
  <Selected>(
    key: string,
    selector: (value: Snapshot | undefined) => Selected,
    equal?: (left: Selected, right: Selected) => boolean,
  ): Selected
}

/** Framework-owned props visible while a slot-level contextual Hook is bound. */
export type StandardPropsOf<K extends keyof SlotMap & string> =
  (ScopeOf<K> extends 'session' ? SessionStandardProps
    : ScopeOf<K> extends 'session-maybe' ? SessionMaybeStandardProps
      : object) &
  GlobalStandardProps

/**
 * One function-valued slot-level inject.hooks member. The factory is pure and
 * returns the actual custom Hook; it must not invoke a Hook while being bound.
 */
export type SlotHookFactory<
  K extends keyof SlotMap & string,
  Hook extends (...args: never[]) => unknown,
> = (
  standard: StandardPropsOf<K>,
  hookContext: HookContextOf<K>,
) => Hook

/** Component-side Hook produced from one slot-level inject.hooks member. */
type BoundHookOf<Definition> =
  Definition extends HostObservable<infer Snapshot>
    ? SnapshotSelectorHook<Snapshot>
    : Definition extends (...args: never[]) => infer Hook
      ? Hook extends (...args: never[]) => unknown ? Hook : never
      : never

/**
 * Selector-hook share synthesized from a hooks compartment: each source
 * `name` becomes a `use<Name>` selector hook over its snapshot type.
 */
export type PropsSlotHooks<HS extends object> = {
  [N in keyof HS & string as `use${Capitalize<N>}`]:
  BoundHookOf<HS[N]>
}

/** Component-side view of a slot dispatcher's common inject face. */
export type SlotInjectFace<I extends object> =
  I extends { hooks: infer HS extends object } ? Omit<I, 'hooks'> & PropsSlotHooks<HS> : I

/** Selector-hook share synthesized from an entry inject hooks compartment. */
export type PropsHooks<HS extends HooksSources> = {
  [N in keyof HS & string as `use${Capitalize<N>}`]:
  SnapshotSelectorHook<HS[N] extends HostObservable<infer T> ? T : never>
}

/** Selector-hook share synthesized from an entry inject keyed-hooks compartment. */
export type PropsKeyedHooks<HS extends KeyedHooksSources> = {
  [N in keyof HS & string as `use${Capitalize<N>}`]: KeyedSnapshotSelectorHook<
    HS[N] extends (key: string) => HostObservable<infer T> | undefined ? T : never
  >
}

/**
 * The component-side view of an inject face: the reserved `hooks`
 * compartment (when declared) arrives as bound `use<Name>` selector hooks;
 * every other member passes through verbatim.
 */
export type InjectFace<I extends object> =
  I extends { hooks: infer HS extends HooksSources }
    ? I extends { keyedHooks: infer KS extends KeyedHooksSources }
      ? Omit<I, 'hooks' | 'keyedHooks'> & PropsHooks<HS> & PropsKeyedHooks<KS>
      : Omit<I, 'hooks'> & PropsHooks<HS>
    : I extends { keyedHooks: infer KS extends KeyedHooksSources }
      ? Omit<I, 'keyedHooks'> & PropsKeyedHooks<KS>
      : I

/**
 * The composed component props intersection: runtime share (SlotMap) +
 * child-render share (children declaration) + store share (declared handle) +
 * the registrant's injected business face (its hooks compartment bound, see
 * {@link InjectFace}) + the locale `t` seat (declared namespace, see
 * {@link PropsLocale}). Each share derives from its single source of truth;
 * components reference this composition, never re-type it.
 */
export type ComposedProps<
  K extends keyof SlotMap & string,
  EntryKey extends EntryKeyOf<K>,
  S extends keyof SlotMap & string,
  H,
  I extends object,
  M = never,
  N = undefined,
> = PropsRuntime<K, EntryKey> & PropsRenderSlots<S> & PropsStore<H> & InjectFace<I> & MatchedShare<SlotMap[K], M> & PropsLocale<N>

/**
 * Inject factory parameter list, derived from the registration's declaration:
 * strict session slots receive a definite framework-resolved `sessionId`;
 * session-maybe slots receive the current id or `undefined`; a declared store
 * appends the baked `actions` (the same callbacks the component receives).
 * Business data access happens through the apply closure's ctx — no binding
 * object parameter exists.
 */
export type InjectParams<K extends keyof SlotMap & string, H> =
  ScopeOf<K> extends 'session'
    ? ([H] extends [StoreDecl] ? [sessionId: SessionIdOf, actions: BoundActions<HandleOf<H>>] : [sessionId: SessionIdOf])
    : ScopeOf<K> extends 'session-maybe'
      ? ([H] extends [StoreDecl]
        ? [sessionId: SessionIdOf | undefined, actions: BoundActions<HandleOf<H>> | undefined]
        : [sessionId: SessionIdOf | undefined])
      : ([H] extends [StoreDecl] ? [actions: BoundActions<HandleOf<H>>] : [])

/**
 * A list-entry display label: a plain string, or a thunk re-evaluated per
 * read so registration-time text (nav rows, tabs) follows the active locale
 * without re-registration. Owners resolve through {@link resolveSlotLabel}.
 */
export type SlotLabel = string | (() => string)

/**
 * Kind shape fields carried in register options (keyed dispatch key; list
 * id/order/label; chain select/priority; non-chain priority = cell shadowing rank).
 */
export type KindOptions<
  K extends keyof SlotMap & string,
  EntryKey extends EntryKeyOf<K>,
  M = never,
> =
  SlotMap[K]['kind'] extends 'keyed' ? {
    key: EntryKey
    /** Cell shadowing rank (ascending, default 0, lowest renders; same key + same priority throws — see {@link SlotCore.register}). */
    priority?: number
  }
    : SlotMap[K]['kind'] extends 'list' ? {
      id: string
      order?: number
      label?: SlotLabel
      /** Cell shadowing rank (ascending, default 0, lowest renders; same id + same priority throws — see {@link SlotCore.register}). */
      priority?: number
    }
      : SlotMap[K]['kind'] extends 'chain' ? {
        /** Routing selector, mandatory on chain entries; `M` (the component's `matched` prop) infers from its return. */
        select: ChainSelect<SlotMap[K] extends { owner: infer O extends object } ? O : object, M>
        /** Explicit chain position (ascending, default 0, lower tries first); ties keep registration = assembly order. */
        priority?: number
      }
        : {
          /**
           * Cell shadowing rank (ascending, default 0, lowest renders; a
           * same-priority second registration throws — see {@link SlotCore.register}).
           */
          priority?: number
        }

/**
 * Compile-time presence check: an entry declaring children MUST consume
 * `renderSlot` (or `renderSlotChain` when its only children are chain slots)
 * — declaring is claiming; an entry that does not render its children should
 * not declare them. Evaluates to an unsatisfiable intersection member naming
 * the declared keys when violated.
 */
type RendersCheck<C, D> =
  [keyof D & keyof SlotMap & string] extends [never] ? unknown
    : C extends (props: infer P) => ReactNode
      ? ('renderSlot' extends keyof P ? unknown
        : 'renderSlotChain' extends keyof P ? unknown
          : { 'children declared but the component consumes no renderSlot': keyof D & keyof SlotMap & string })
      : unknown

/** Common register options share (see {@link SlotCore.register} for semantics). */
type BaseOptions<
  K extends keyof SlotMap & string,
  EntryKey extends EntryKeyOf<K>,
  D extends ChildrenDecl,
  H,
  M = never,
  N = undefined,
> = {
  /** Target slot key (the entry contributes INTO this slot). */
  name: K
  /** Child-slot declaration + render authorization + runtime spec, in one table. */
  children?: D
  /** Store seat: a shared handle (apply-constructed) or an exclusive factory (framework-called per entry x scope). */
  store?: H
  /**
   * Dictionary namespace of this entry's copy. Declaring it puts the
   * framework-synthesized `t` seat (typed to the namespace's dictionary
   * union) on the component props; rendering requires an installed locale
   * face — fails loud otherwise.
   */
  locale?: N
  /** Registrant identity label for diagnostics (the runtime Service wrapper stamps the caller's fiber name). */
  registrant?: string
} & KindOptions<K, EntryKey, M>

/**
 * One stored registration, as recorded by the core and read by the render
 * machinery (type-erased at this boundary; the registration contract already proved
 * the shares against the component).
 */
export interface StoredEntry {
  component: unknown
  options: { key?: string; id?: string; order?: number; label?: SlotLabel; priority?: number }
  /** Chain routing selector (type-erased like `inject`; present exactly on chain-slot entries). */
  select?: ((owner: never) => unknown) | undefined
  /** Registrant business face; positional params derive from the declaration (sessionId?, actions?). */
  inject?: ((...args: never[]) => Record<string, unknown>) | undefined
  /** Child-slot declaration table (declaration + authorization + runtime spec in one). */
  children?: Readonly<Record<string, SlotSpec<SlotEntryDef>>> | undefined
  /** Declared store seat (instance resolution and lifecycle live with the host machinery). */
  store?: StoreDecl | undefined
  /** Declared dictionary namespace (the render machinery synthesizes the `t` seat from it). */
  locale?: string | undefined
  /** Diagnostics label of who registered. */
  registrant?: string | undefined
}

/**
 * Resolve a possibly-thunked list label at read time (thunks follow the
 * active locale; owners projecting ledger rows call this instead of reading
 * `options.label` raw).
 * @param label - the stored label.
 * @returns the display string, or undefined when the entry declared none.
 */
export function resolveSlotLabel(label: SlotLabel | undefined): string | undefined {
  return typeof label === 'function' ? label() : label
}

/**
 * Type-erased options view the implementation works with. Optional members
 * carry explicit `| undefined`: under exactOptionalPropertyTypes the public
 * overloads (whose generics admit undefined) would otherwise fail
 * overload-to-implementation compatibility.
 */
interface ErasedOptions {
  name: string
  key?: string | undefined
  id?: string | undefined
  order?: number | undefined
  label?: SlotLabel | undefined
  select?: ((owner: never) => unknown) | undefined
  priority?: number | undefined
  children?: Record<string, SlotSpec<SlotEntryDef>> | undefined
  store?: StoreDecl | undefined
  locale?: string | undefined
  /* oxlint-disable-next-line typescript/no-explicit-any --
   * implementation-signature position only (both public overloads type inject
   * exactly); `never[]` would fail overload-to-implementation compatibility
   * against the per-declaration InjectParams tuples. */
  inject?: ((...args: any) => Record<string, unknown>) | undefined
  registrant?: string | undefined
}

/**
 * Per-key registry record. Created on first touch; never removed (version
 * stays monotonic across redeclarations).
 */
interface SlotRecord {
  spec: SlotSpec<SlotEntryDef> | undefined
  /** Diagnostics: which slot's entry declared this key ('(built-in)' for root). */
  declaredBy: string | undefined
  /** Live parent declaration, absent for root slots. */
  parent: string | undefined
  /** Monotonic declaration lifetime, distinct from ordinary entry mutations. */
  declarationEpoch: number
  entries: readonly StoredEntry[]
  version: number
  listeners: Set<() => void>
  declarationListeners: Set<() => void>
}

const NO_ENTRIES: readonly StoredEntry[] = Object.freeze([])

/** JSON-safe live occupant returned by slot inspection. */
export interface LiveSlotOccupant {
  /** Plugin or package that registered the entry, when known. */
  registrant?: string
  /** Keyed-slot cell. */
  key?: string
  /** List-slot cell. */
  id?: string
  /** List display order. */
  order?: number
  /** Shadowing or chain priority. */
  priority: number
  /** Whether the renderer currently selects this entry. */
  active: boolean
}

/** JSON-safe live slot declaration tree. */
export interface LiveSlotNode {
  /** Exact SlotMap key. */
  name: string
  /** Slot cardinality. */
  kind: SlotKind
  /** Runtime data scope. */
  scope: SlotScope
  /** Diagnostic owner of this declaration. */
  declaredBy?: string
  /** Current registrations in ledger order. */
  occupants: LiveSlotOccupant[]
  /** Slots declared by entries mounted in this slot. */
  children: LiveSlotNode[]
}

/**
 * Pure slot registry (no cordis; event emission and the renderer installation contract
 * live in the runtime Service wrapper).
 *
 * The 'root' slot is the one a-priori declaration, seeded at construction
 * (single/root, declared by the framework) — the render tree's root hole.
 *
 * Change propagation contract: versions bump and {@link SlotCore.onMutate}
 * fires synchronously per mutation (registry state is consistent when they
 * fire); {@link SlotCore.subscribeDeclaration} fires synchronously for each
 * declaration lifetime boundary; {@link SlotCore.subscribe} notifications
 * batch per microtask, so N same-tick mutations produce one notification per
 * touched key. Entry crash reports ({@link SlotCore.reportEntryError}) ride
 * the same mutation channel when they abdicate, then notify
 * {@link SlotCore.onEntryError} synchronously.
 */
export class SlotCore {
  private records = new Map<string, SlotRecord>()
  private mutateListeners = new Set<(key: string) => void>()
  /** Shared-handle scope ledger: handle → the scope it first mounted under + live mount count. */
  private handleScopes = new Map<object, { scope: SlotScope; count: number }>()
  // Dirty records, not keys: records are never removed, so holding the
  // reference skips a lookup (and an unreachable missing-record branch) at flush.
  private dirty = new Set<SlotRecord>()
  private flushScheduled = false
  /**
   * Entries retired by an abdicating crash report
   * ({@link SlotCore.reportEntryError}): excluded from
   * {@link SlotCore.entriesOfSlot} projections for the rest of their
   * registration's life, while the registration itself stays on the ledger
   * (disposal authority remains with the registrant).
   */
  private abdicated = new WeakSet<StoredEntry>()
  private entryErrorListeners
    = new Set<(key: string, entry: StoredEntry, error: unknown, info: { abdicated: boolean }) => void>()

  constructor() {
    // The a-priori root hole. No markDirty: nothing can observe construction.
    const root = this.record('root')
    root.spec = { kind: 'single', scope: 'root' }
    root.declaredBy = '(built-in)'
    root.declarationEpoch = 1
  }

  /**
   * Contribute a component to a declared slot and (optionally) declare child
   * slots, a store seat, and the registrant's business face.
   *
   * Load-time validation (misconfiguration fails loud; the render hot path
   * re-checks nothing): registering into an undeclared slot throws; declaring
   * an already-declared child key throws (one declarer per slot — the message
   * names the first declarer); mounting one shared store handle under slots
   * of different scopes throws. Kind constraints: keyed — missing `key`
   * throws; list — missing `id` throws; chain — missing `select` throws (the
   * selector is the entry's routing seat, see {@link ChainSelect}).
   *
   * Shadowing (single/keyed/list): entries sharing one cell (single — the
   * slot itself; keyed — same `key`; list — same `id`) coexist at distinct
   * priorities, sorted ascending with ties keeping registration order; the
   * cell's lowest live entry renders ({@link SlotCore.entriesOfSlot}). A
   * second registration at an occupied cell's exact priority (default 0)
   * throws naming the occupant, so priority-less composition keeps the
   * historical one-occupant-per-cell fail-loud.
   *
   * Lifecycle: the disposer removes the contribution AND collapses every
   * declared child slot (child entries clear recursively; their stale
   * disposers become no-ops) — one lifecycle axis, no dangling state.
   *
   * @param options - registration options: target `name`, `children`
   * declaration table, `store` seat, `inject` business-face factory, kind
   * shape fields (keyed `key`; list `id`/`order`/`label`).
   * @param component - component honoring the four-share composed props
   * contract ({@link ComposedProps}); checked at this call site.
   * @returns disposer removing the registration and its declarations
   * (idempotent; stale disposers after a cascade are no-ops).
   */
  /* jscpd:ignore-start -- the two register overloads are deliberately
   * parallel declarations differing only in the inject share; folding them
   * would lose the per-overload inference of I. */
  register<
    K extends keyof SlotMap & string,
    const EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>,
    const D extends ChildrenDecl = Record<never, never>,
    H extends StoreDecl | undefined = undefined,
    M = never,
    N extends (keyof LocaleNamespaceMap & string) | undefined = undefined,
    C extends SlotComponent<never> = SlotComponent<never>,
  >(
    options: BaseOptions<K, EntryKey, D, H, M, N> & { inject?: undefined },
    component: C
      & SlotComponent<ComposedProps<
        K, NoInfer<EntryKey>, keyof NoInfer<D> & keyof SlotMap & string,
        HandleOf<NoInfer<H>>, object, NoInfer<M>, NoInfer<N>
      >>
      & RendersCheck<C, D>,
  ): () => void
  /**
   * Inject-bearing overload: identical semantics to the overload above, plus
   * the registrant's business face — `I` is inferred from the inject
   * factory's return and joins the component's composed-props constraint
   * (factory parameters derive from the declaration, {@link InjectParams}).
   * @param options - registration options plus the `inject` business-face factory.
   * @param component - component honoring the four-share composed props
   * contract including the inject share `I`.
   * @returns disposer removing the registration and its declarations.
   */
  register<
    K extends keyof SlotMap & string,
    I extends object,
    const EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>,
    const D extends ChildrenDecl = Record<never, never>,
    H extends StoreDecl | undefined = undefined,
    M = never,
    N extends (keyof LocaleNamespaceMap & string) | undefined = undefined,
    C extends SlotComponent<never> = SlotComponent<never>,
  >(
    options: BaseOptions<K, EntryKey, D, H, M, N> & { inject: (...args: InjectParams<K, H>) => I },
    component: C
      & SlotComponent<ComposedProps<
        K, NoInfer<EntryKey>, keyof NoInfer<D> & keyof SlotMap & string,
        HandleOf<NoInfer<H>>, I, NoInfer<M>, NoInfer<N>
      >>
      & RendersCheck<C, D>,
  ): () => void
  /* jscpd:ignore-end */
  register(options: ErasedOptions, component: unknown): () => void {
    const rec = this.records.get(options.name)
    if (!rec?.spec) {
      throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`)
    }
    const spec = rec.spec
    // Kind constraints stay runtime checks for dynamically-composed callers;
    // typed callers already satisfied KindOptions statically. Cell occupancy
    // clashes only at the exact priority: a different priority shadows.
    const priority = options.priority ?? 0
    const occupantHint = (occupant: StoredEntry) =>
      `at priority ${priority}${occupant.registrant !== undefined ? ` (registered by ${occupant.registrant})` : ''} — register at a different priority to shadow it (lowest renders)`
    switch (spec.kind) {
      case 'single': {
        const occupant = rec.entries.find(e => (e.options.priority ?? 0) === priority)
        if (occupant) throw new Error(`single slot "${options.name}" already has a registration ${occupantHint(occupant)}`)
        break
      }
      case 'keyed': {
        if (options.key === undefined) throw new Error(`keyed slot "${options.name}" requires options.key`)
        const occupant = rec.entries.find(e => e.options.key === options.key && (e.options.priority ?? 0) === priority)
        if (occupant) {
          throw new Error(`keyed slot "${options.name}" already has an entry for key "${options.key}" ${occupantHint(occupant)}`)
        }
        break
      }
      case 'list': {
        if (options.id === undefined) throw new Error(`list slot "${options.name}" requires options.id`)
        const occupant = rec.entries.find(e => e.options.id === options.id && (e.options.priority ?? 0) === priority)
        if (occupant) {
          throw new Error(`list slot "${options.name}" already has an entry with id "${options.id}" ${occupantHint(occupant)}`)
        }
        break
      }
      case 'chain':
        if (options.select === undefined) throw new Error(`chain slot "${options.name}" requires options.select`)
        break
    }
    if (options.children) {
      for (const childKey of Object.keys(options.children)) {
        const childRec = this.records.get(childKey)
        if (childRec?.spec) {
          throw new Error(`slot "${childKey}" is already declared (by ${childRec.declaredBy ?? 'an unknown entry'})`)
        }
      }
    }
    // Shared handles pin their scope on first mount; factories are exempt
    // (the framework creates per-entry instances, no shared identity exists).
    if (options.store !== undefined && typeof options.store !== 'function') {
      const pinned = this.handleScopes.get(options.store)
      if (pinned && pinned.scope !== spec.scope) {
        throw new Error(
          `store handle mounted under "${options.name}" (scope "${spec.scope}") is already mounted under scope "${pinned.scope}" — one handle, one scope`)
      }
      if (pinned) pinned.count += 1
      else this.handleScopes.set(options.store, { scope: spec.scope, count: 1 })
    }

    const entry: StoredEntry = {
      component,
      options: {
        ...(options.key !== undefined ? { key: options.key } : {}),
        ...(options.id !== undefined ? { id: options.id } : {}),
        ...(options.order !== undefined ? { order: options.order } : {}),
        ...(options.label !== undefined ? { label: options.label } : {}),
        ...(options.priority !== undefined ? { priority: options.priority } : {}),
      },
      ...(options.select !== undefined ? { select: options.select } : {}),
      ...(options.inject !== undefined ? { inject: options.inject } : {}),
      ...(options.children !== undefined ? { children: options.children } : {}),
      ...(options.store !== undefined ? { store: options.store } : {}),
      ...(options.locale !== undefined ? { locale: options.locale } : {}),
      ...(options.registrant !== undefined ? { registrant: options.registrant } : {}),
    }
    const next = [...rec.entries, entry]
    // Stable sorts: priority ascending for every kind, ties keep registration
    // sequence — a cell's winner is its first occurrence, chain tries lower
    // priority first. List refines equal priorities by explicit `order` so the
    // raw ledger keeps its display sequence for priority-less compositions.
    next.sort(spec.kind === 'list'
      ? (a, b) => ((a.options.priority ?? 0) - (b.options.priority ?? 0)) || ((a.options.order ?? 0) - (b.options.order ?? 0))
      : (a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))
    rec.entries = next
    this.markDirty(options.name, rec)
    if (options.children) {
      const declarations: [key: string, record: SlotRecord][] = []
      for (const [childKey, childSpec] of Object.entries(options.children)) {
        const childRec = this.record(childKey)
        childRec.spec = childSpec
        childRec.declaredBy = `an entry in "${options.name}"${options.registrant ? ` (${options.registrant})` : ''}`
        childRec.parent = options.name
        childRec.declarationEpoch += 1
        declarations.push([childKey, childRec])
      }
      // Synchronous listeners may register into or try to redeclare a sibling;
      // publish only after the whole children table owns its declarations.
      for (const [childKey, childRec] of declarations) {
        this.markDirty(childKey, childRec)
      }
      for (const [, childRec] of declarations) {
        this.notifyDeclaration(childRec)
      }
    }
    return () => {
      if (!rec.entries.includes(entry)) return
      rec.entries = rec.entries.filter(e => e !== entry)
      this.markDirty(options.name, rec)
      this.releaseEntry(entry)
    }
  }

  /**
   * Whether a previously obtained entry is still registered (the render
   * machinery's stale-authorization probe: a retained renderSlot binding
   * whose entry left the ledger must not render).
   * @param entry - a previously read entry.
   * @returns false once the entry's registration was disposed.
   */
  isLive(entry: StoredEntry): boolean {
    for (const rec of this.records.values()) {
      if (rec.entries.includes(entry)) return true
    }
    return false
  }

  /**
   * Snapshot the registered entries for a key. Returns the cached array
   * reference (stable between mutations — safe as a uSES getSnapshot source);
   * empty for keys not (or no longer) declared, so renderers may probe ahead
   * of plugin load order.
   * @param key - slot key (dynamic: the render machinery holds keys as strings).
   * @returns entries in registration (list: order) sequence.
   */
  entries(key: string): readonly StoredEntry[] {
    return this.records.get(key)?.entries ?? NO_ENTRIES
  }

  /**
   * Project a key's entries to its shadowing winners: the first live
   * (non-abdicated) entry of each cell in priority order — single: the slot
   * is one cell; keyed: one cell per `key`; list: one cell per `id` (winners
   * keep ledger sequence; list renderers still refine display by `order`).
   * Chain keys return the raw entries unchanged: election consumes every
   * entry, shadowing does not apply. The raw {@link SlotCore.entries} view
   * stays the inspection surface. Builds a fresh array per call — a render
   * body read, not a uSES getSnapshot source.
   * @param key - slot key (dynamic: the render machinery holds keys as strings).
   * @returns the winning entry per occupied cell (empty while undeclared).
   */
  entriesOfSlot(key: string): readonly StoredEntry[] {
    const rec = this.records.get(key)
    if (!rec?.spec) return NO_ENTRIES
    const kind = rec.spec.kind
    if (kind === 'chain') return rec.entries
    const heads: StoredEntry[] = []
    const seenCells = new Set<string | undefined>()
    for (const entry of rec.entries) {
      if (this.abdicated.has(entry)) continue
      // Single-kind entries all share the one undefined cell.
      const cell = kind === 'keyed' ? entry.options.key : kind === 'list' ? entry.options.id : undefined
      if (seenCells.has(cell)) continue
      seenCells.add(cell)
      heads.push(entry)
    }
    return heads
  }

  /**
   * Look up a slot's declared spec, narrowed by the SlotMap key.
   * @param key - SlotMap key.
   * @returns the spec, or undefined while undeclared.
   */
  spec<K extends keyof SlotMap & string>(key: K): SlotSpec<SlotMap[K]> | undefined {
    return this.records.get(key)?.spec as SlotSpec<SlotMap[K]> | undefined
  }

  /**
   * Dynamic-key escape hatch for spec lookup — renderers resolving keys they
   * only hold as strings (generic dispatch) use this wide form; statically
   * keyed callers use {@link SlotCore.spec}.
   * @param key - candidate slot key.
   * @returns the wide-typed spec, or undefined while undeclared.
   */
  specDynamic(key: string): SlotSpec<SlotEntryDef> | undefined {
    return this.records.get(key)?.spec
  }

  /**
   * Export the current declaration topology without components or executable hooks.
   * @param root - exact Slot key to select; omitted returns every live root.
   * @returns selected live Slot trees, or an empty array when `root` is unavailable.
   */
  snapshot(root?: string): LiveSlotNode[] {
    const build = (name: string, seen: Set<string>): LiveSlotNode | undefined => {
      const record = this.records.get(name)
      if (record?.spec === undefined || seen.has(name)) return undefined
      const branch = new Set(seen)
      branch.add(name)
      const active = new Set(this.entriesOfSlot(name))
      const children = [...this.records.entries()]
        .filter(([, candidate]) => candidate.spec !== undefined && candidate.parent === name)
        .flatMap(([child]) => {
          const node = build(child, branch)
          return node === undefined ? [] : [node]
        })
      return {
        name,
        kind: record.spec.kind,
        scope: record.spec.scope,
        ...record.declaredBy === undefined ? {} : { declaredBy: record.declaredBy },
        occupants: record.entries.map(entry => ({
          ...entry.registrant === undefined ? {} : { registrant: entry.registrant },
          ...entry.options.key === undefined ? {} : { key: entry.options.key },
          ...entry.options.id === undefined ? {} : { id: entry.options.id },
          ...entry.options.order === undefined ? {} : { order: entry.options.order },
          priority: entry.options.priority ?? 0,
          active: active.has(entry),
        })),
        children,
      }
    }
    if (root !== undefined) {
      const node = build(root, new Set())
      return node === undefined ? [] : [node]
    }
    return [...this.records.entries()]
      .filter(([, record]) => record.spec !== undefined
        && (record.parent === undefined || this.records.get(record.parent)?.spec === undefined))
      .flatMap(([name]) => {
        const node = build(name, new Set())
        return node === undefined ? [] : [node]
      })
  }

  /**
   * Read the declaration lifetime of a key. Entry additions and removals do
   * not change it; declaration creation and collapse each advance it.
   * @param key - slot key.
   * @returns monotonic epoch (0 before the first declaration).
   */
  declarationEpoch(key: string): number {
    return this.records.get(key)?.declarationEpoch ?? 0
  }

  /**
   * Subscribe to registration changes for a key (microtask-batched).
   * Subscribing ahead of declaration is allowed; the declaration notifies.
   * @param key - slot key.
   * @param fn - change callback.
   * @returns unsubscribe.
   */
  subscribe(key: string, fn: () => void): () => void {
    const rec = this.record(key)
    rec.listeners.add(fn)
    return () => { rec.listeners.delete(fn) }
  }

  /**
   * Subscribe to declaration lifetime boundaries for a key. Notifications
   * are synchronous so declaration teardown finishes before a subsequent
   * same-tick registration can observe stale resources. Ordinary entry
   * mutations do not notify this surface. A children table commits every
   * sibling declaration before its first notification.
   * @param key - slot key.
   * @param fn - declaration or collapse callback.
   * @returns unsubscribe.
   */
  subscribeDeclaration(key: string, fn: () => void): () => void {
    const rec = this.record(key)
    rec.declarationListeners.add(fn)
    return () => { rec.declarationListeners.delete(fn) }
  }

  /**
   * Monotonic version for a key, bumped synchronously per mutation so a
   * uSES getSnapshot read is never stale when its batched notification lands.
   * @param key - slot key.
   * @returns current version (0 for untouched keys).
   */
  getVersion(key: string): number {
    return this.records.get(key)?.version ?? 0
  }

  /**
   * Hook every mutation (the runtime Service wrapper bridges this to ctx.emit).
   * Fires synchronously per mutation, unbatched — event semantics need one
   * emission per change.
   * @param fn - called with the mutated key.
   * @returns unsubscribe.
   */
  onMutate(fn: (key: string) => void): () => void {
    this.mutateListeners.add(fn)
    return () => { this.mutateListeners.delete(fn) }
  }

  /**
   * Renderer crash report from an entry boundary. Always notifies
   * {@link SlotCore.onEntryError} listeners; with `info.abdicate` set (the
   * shadowing kinds — single/keyed/list) it first retires the entry from its
   * cell, one-shot: the record's version bumps through the ordinary mutation
   * channel so outlets re-project onto the cell's next survivor, and a
   * repeat abdicating report no-ops entirely. Chain crashes report with
   * `abdicate: false` — election alternatives resolve at select time, so the
   * entry keeps its cell and only the notification fires. The registration
   * itself stays on the ledger either way — raw {@link SlotCore.entries}
   * still lists the entry and its disposer keeps working.
   * @param key - slot key the entry rendered under.
   * @param entry - the crashed entry.
   * @param error - the crash cause, forwarded to listeners verbatim.
   * @param info - `abdicate`: whether the crash retires the entry from its cell.
   */
  reportEntryError(key: string, entry: StoredEntry, error: unknown, info: { abdicate: boolean }): void {
    if (info.abdicate) {
      if (this.abdicated.has(entry)) return
      this.abdicated.add(entry)
      const rec = this.records.get(key)
      if (rec !== undefined) this.markDirty(key, rec)
    }
    for (const fn of [...this.entryErrorListeners]) fn(key, entry, error, { abdicated: info.abdicate })
  }

  /**
   * Observe entry boundary crashes (every render-time entry failure the
   * boundaries contain, abdicating or not) — the supervision seam for hosts
   * mirroring contribution health. Fires synchronously per report, after the
   * registry mutated for abdicating crashes (same listener discipline as
   * {@link SlotCore.onMutate}).
   * @param fn - called with the slot key, the crashed entry, the crash
   * cause, and `abdicated`: whether the crash retired the entry from its cell.
   * @returns unsubscribe.
   */
  onEntryError(fn: (key: string, entry: StoredEntry, error: unknown, info: { abdicated: boolean }) => void): () => void {
    this.entryErrorListeners.add(fn)
    return () => { this.entryErrorListeners.delete(fn) }
  }

  /**
   * Cascade for a removed entry: release its store mount and collapse every
   * child slot it declared — specs clear, contributions empty (their stale
   * disposers no-op), recursively down the declaration tree. One lifecycle
   * axis: ledger rows, slots, contributions, and store mounts die together.
   */
  private releaseEntry(entry: StoredEntry): void {
    if (entry.store !== undefined && typeof entry.store !== 'function') {
      const pinned = this.handleScopes.get(entry.store)
      if (pinned && --pinned.count === 0) this.handleScopes.delete(entry.store)
    }
    if (!entry.children) return
    for (const childKey of Object.keys(entry.children)) {
      const childRec = this.records.get(childKey)
      /* v8 ignore next -- defensive: declaring always creates the record */
      if (!childRec) continue
      const doomed = childRec.entries
      childRec.spec = undefined
      childRec.declaredBy = undefined
      childRec.parent = undefined
      childRec.declarationEpoch += 1
      childRec.entries = NO_ENTRIES
      this.markDirty(childKey, childRec)
      this.notifyDeclaration(childRec)
      for (const dead of doomed) this.releaseEntry(dead)
    }
  }

  private record(key: string): SlotRecord {
    let rec = this.records.get(key)
    if (!rec) {
      rec = {
        spec: undefined,
        declaredBy: undefined,
        parent: undefined,
        declarationEpoch: 0,
        entries: NO_ENTRIES,
        version: 0,
        listeners: new Set(),
        declarationListeners: new Set(),
      }
      this.records.set(key, rec)
    }
    return rec
  }

  private markDirty(key: string, rec: SlotRecord): void {
    rec.version += 1
    for (const fn of [...this.mutateListeners]) fn(key)
    this.dirty.add(rec)
    if (!this.flushScheduled) {
      this.flushScheduled = true
      queueMicrotask(() => { this.flush() })
    }
  }

  private notifyDeclaration(rec: SlotRecord): void {
    for (const fn of [...rec.declarationListeners]) fn()
  }

  private flush(): void {
    // Reset before iterating so a mutation from inside a listener re-schedules.
    this.flushScheduled = false
    const dirty = [...this.dirty]
    this.dirty.clear()
    for (const rec of dirty) {
      for (const fn of [...rec.listeners]) fn()
    }
  }
}
