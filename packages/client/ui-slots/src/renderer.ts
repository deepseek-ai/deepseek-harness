/** React-free contracts between the slot host and an installed renderer. */
import type { Context } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {
  SessionAreaProps, SlotEntryDef, SlotScope, SlotSpec, StoredEntry, StoredFactory, Translate,
} from './index.ts'

/**
 * The locale face the render machinery consumes: namespace binding plus an
 * observable revision (getSnapshot/subscribe pair — the same HostObservable
 * currency as every other standard-kit source). The revision moves on every
 * active-locale or registry change; the renderer re-derives each entry's `t`
 * from (namespace, revision), so a locale switch hands out NEW function
 * references and memoized components re-render naturally. Implemented by the
 * locale plugin, installed through the `ui-renderer` SlotRegistry.
 * Install before the first render that needs the seat: outlets bind their
 * revision subscription at mount, and a face appearing later has no channel
 * to notify already-mounted outlets (the locale plugin is immediately-tier
 * infrastructure, so normal compositions install during boot).
 */
export interface LocaleFace extends HostObservable<{ revision: number }> {
  /**
   * Bind a namespace to a translate function reading the active locale at
   * call time. Identity may be stable per namespace — freshness of rendered
   * text is carried by the renderer's (ns, revision) seat derivation, not by
   * this binding.
   * @param ns - dictionary namespace.
   * @returns the namespace-bound translate function.
   */
  bind(ns: string): Translate
}

/** Observable currency shared by domain sources, stores, and the renderer. */
export type HostObservable<T> = ObservableSnapshot<T>

/**
 * Convert one standard source name to its rendered Hook prop name.
 * @param name - registered fixed or keyed source name.
 * @returns the `use<Name>` prop exposed to Slot components.
 */
export function standardHookPropName(name: string): string {
  return `use${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`
}

/**
 * Type-erased store instance face at the render boundary (the typed twin is
 * {@link StoreInstance}): a bare snapshot source plus the draft-stripped
 * action callbacks. No React hook crosses this boundary — the render machinery
 * binds `useStore` from the source at its own side (cached per instance);
 * typing lands at the component boundary via {@link PropsStore}.
 */
export interface StoreInstanceLike {
  getSnapshot(): unknown
  /**
   * Subscribe to state changes (uSES subscribe side).
   * @param fn - change callback.
   * @returns unsubscribe.
   */
  subscribe(fn: () => void): () => void
  readonly actions: Record<string, (...params: never[]) => void>
}

/** Resolve one member of an open-key standard hook family. */
export type KeyedStandardSource = (key: string) => HostObservable<unknown> | undefined

/**
 * Framework-neutral inputs from which the renderer materializes standard
 * props. A scope adapter keeps member names present while its binding is
 * absent so optional slots retain a stable Hook call order.
 */
export interface StandardSourceBinding {
  /** Scope identity; absent for root data and an optional scope with no selection. */
  readonly key: string | undefined
  /** Fixed-name sources; each `name` becomes a `useName` selector Hook. */
  readonly hooks: Readonly<Record<string, HostObservable<unknown> | undefined>>
  /** Open-key source families; each `name` becomes a `useName(key, selector)` Hook. */
  readonly keyedHooks: Readonly<Record<string, KeyedStandardSource | undefined>>
  /** Stable plain values copied into standard props. */
  readonly props: Readonly<Record<string, unknown>>
}

/** Materialized binding for one live non-root scope. */
export interface ScopedStandardSourceBinding extends StandardSourceBinding {
  readonly key: string
  readonly ctx: Context
}

/** One installed source of bindings for a non-root Slot scope. */
export interface SlotScopeAdapter {
  /** Default binding inherited by scoped entries, including its absent projection. */
  readonly current: HostObservable<StandardSourceBinding>
  /**
   * Resolve a stable observable for an explicit scope target or explicit absence.
   * @param target - domain-owned Provider target, or absence.
   * @returns the target's current standard-source binding.
   */
  bindingSource(target: SessionAreaProps['session']): HostObservable<StandardSourceBinding>
  /**
   * Render the scope owner's area seat over the current binding. The renderer
   * binds this function to the standard `SessionProvider` prop without owning
   * Session selection semantics.
   * @param binding - current scope binding, including its absent projection.
   * @param props - render-prop body and empty branch.
   * @returns rendered scope area.
   */
  renderArea?(binding: StandardSourceBinding, props: SessionAreaProps): ReactNode
}

/** Root standard-source contribution installed by one domain UI package. */
export interface RootStandardSourceContribution {
  readonly hooks?: Readonly<Record<string, HostObservable<unknown>>>
  readonly keyedHooks?: Readonly<Record<string, KeyedStandardSource>>
  readonly props?: Readonly<Record<string, unknown>>
}

/** renderSlot dispatch options at the machinery level. */
export interface RenderOpts {
  entryKey?: string
  only?: string
  fallback?: ReactNode
  /** Opaque occurrence context consumed only by function-valued injected Hooks. */
  hookContext?: unknown
}

/** Host API the `ui-renderer` SlotRegistry presents to its React renderer. */
export interface SlotRendererHost {
  /**
   * Subscribe to a key's registration changes (microtask-batched).
   * @param key - slot key.
   * @param fn - change callback.
   * @returns unsubscribe.
   */
  subscribe(key: string, fn: () => void): () => void
  /**
   * Monotonic version for uSES pairing.
   * @param key - slot key.
   * @returns current version.
   */
  getVersion(key: string): number
  /**
   * Snapshot the registered entries for a key (stable reference between mutations).
   * @param key - slot key.
   * @returns entries in registration (list: order) sequence.
   */
  entriesOf(key: string): readonly StoredEntry[]
  /**
   * Shadowing winners per cell for a key — the render read for single/keyed/
   * list dispatch: the first live (non-abdicated) entry of each cell in
   * priority order; chain keys pass through unchanged (election consumes
   * every entry). Fresh array per call — a render-body read, not a uSES
   * getSnapshot source.
   * @param key - slot key.
   * @returns the winning entry per occupied cell.
   */
  entriesOfSlot(key: string): readonly StoredEntry[]
  /**
   * Report an entry boundary crash. With `info.abdicate` (shadowing kinds)
   * the entry retires from its cell, one-shot, so the next survivor renders;
   * chain crashes report without abdicating. The registration stays on the
   * ledger either way.
   * @param key - slot key the entry rendered under.
   * @param entry - the crashed entry.
   * @param error - the crash cause.
   * @param info - `abdicate`: whether the crash retires the entry from its cell.
   */
  reportEntryError(key: string, entry: StoredEntry, error: unknown, info: { abdicate: boolean }): void
  /**
   * Report a contained Factory occurrence crash without retiring its shared definition.
   * @param name - Factory name whose occurrence crashed.
   * @param registration - Factory definition or caller registration that owns the crashing Component.
   * @param error - the crash cause.
   */
  reportFactoryError(name: string, registration: StoredEntry | StoredFactory, error: unknown): void
  /**
   * Declared runtime spec from the declarations ledger.
   * @param key - slot key.
   * @returns the spec, or undefined while the key is undeclared (outlets render empty).
   */
  specOf(key: string): SlotSpec<SlotEntryDef> | undefined
  /**
   * Stale-authorization check: whether the entry is still in the ledger.
   * @param entry - a previously rendered entry.
   * @returns false once the entry's registration was disposed.
   */
  isLive(entry: StoredEntry): boolean
  /**
   * Resolve (create or return cached) the store instance for an entry's
   * declared handle under a scope key; lifecycle rides the ledger axis.
   * @param entry - entry whose declaration carries the handle.
   * @param scopeBinding - exact Session binding for scoped slots, undefined for root scope.
   * @returns the instance, or undefined when the entry declares no store.
   */
  storeOf(entry: StoredEntry, scopeBinding: ScopedStandardSourceBinding | undefined): StoreInstanceLike | undefined
  /**
   * Resolve a Factory Store for one render occurrence and inherited scope.
   * @param definition - live Factory definition.
   * @param scopeBinding - exact Session binding for scoped Factories, undefined for root scope.
   * @param occurrence - identity token owned by the render position.
   * @returns the occurrence Store instance, or undefined without a Store declaration.
   */
  factoryStoreOf(
    definition: StoredFactory,
    scopeBinding: ScopedStandardSourceBinding | undefined,
    occurrence: object,
  ): StoreInstanceLike | undefined
  /**
   * Retain an exclusive Factory Store occurrence after React commits it.
   * Repeated setup and cleanup preserve the occurrence's Store identity.
   * @param definition - the live Factory definition.
   * @param occurrence - identity token owned by the mounted render position.
   * @returns an idempotent cleanup function.
   */
  retainFactoryOccurrence(definition: StoredFactory, occurrence: object): () => void
  /**
   * Subscribe to one Factory definition's registration lifetime.
   * @param name - Factory name.
   * @param fn - change callback.
   * @returns the unsubscribe function.
   */
  subscribeFactory(name: string, fn: () => void): () => void
  /**
   * Read the monotonic version for one Factory definition.
   * @param name - Factory name.
   * @returns the current definition version.
   */
  getFactoryVersion(name: string): number
  /**
   * Read one live Factory definition.
   * @param name - Factory name.
   * @returns the definition, or undefined while unregistered.
   */
  factoryOf(name: string): StoredFactory | undefined
  /**
   * Check retained Factory render authority.
   * @param definition - a previously resolved Factory definition.
   * @returns whether that exact definition remains live.
   */
  isFactoryLive(definition: StoredFactory): boolean
  /** Root standard data assembled from domain-owned contributions. */
  readonly root: HostObservable<StandardSourceBinding>
  /** Monotonic source updated whenever the installed scope-adapter roster changes. */
  readonly scopeRevision: HostObservable<number>
  /**
   * Resolve the adapter installed for one non-root scope.
   * `session` and `session-maybe` intentionally resolve the same adapter.
   * @param scope - Slot scope.
   * @returns adapter, or `undefined` when the composition omitted its owner.
   */
  scope(scope: Exclude<SlotScope, 'root'>): SlotScopeAdapter | undefined
  /**
   * Installed locale face backing the `t` standard seat (absent until the
   * locale plugin installs one; rendering an entry that declared `locale:`
   * without it is an assembly failure).
   */
  locale?: LocaleFace | undefined
}

/** The installation contract between the `ui-renderer` SlotRegistry and its React renderer. */
export interface SlotRenderer {
  /**
   * Render the root slot tree over the host API (the only ctx-level entry).
   * @param host - the installing service's host API.
   * @param ownerProps - owner props from the shell's renderSlot('root', ...) call.
   * @returns the rendered tree.
   */
  renderRoot(host: SlotRendererHost, ownerProps: object): ReactNode
}

/** Thrown when a retained renderSlot binding is invoked after its declaring entry was disposed. */
export class StaleAuthorizationError extends Error {}

/**
 * Thrown when a renderSlot binding is invoked for a key outside its entry's
 * children declaration (plain-JS backstop; typed callers are narrowed
 * statically).
 */
export class SlotOwnershipError extends Error {}
