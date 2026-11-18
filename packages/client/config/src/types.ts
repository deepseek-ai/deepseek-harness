/**
 * Types of browser-synced plugin configuration. A plugin declares its Config once, with a Host schema; its Client face
 * receives the top-level volatile fields as a {@link SyncedConfig} through `apply`. `@deepseek-ai/dsh-client-modules`
 * implements these types; plugins import them from here only.
 * @module @deepseek-ai/dsh-client-config/types
 */
import type { Volatile, VolatileSnapshot } from '@deepseek-ai/cordis'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** JSON values of one plugin's synced Config fields, keyed by field name. */
export type SyncedConfigValues = { readonly [field: string]: JsonValue }

/**
 * One synced Config field. `get()` reads it as the Host face reads a volatile reference; the reference is also the
 * observable source a plugin injects into a slot's `hooks` compartment. Its snapshot keeps its identity until the value
 * changes, and every changed field of one update is set before any subscriber runs. It has no write operation.
 */
export interface SyncedConfigRef<T> extends Volatile<T>, ObservableSnapshot<VolatileSnapshot<T>> {}

/**
 * Browser view of a plugin's shared Config type: its top-level `Volatile` fields, each a {@link SyncedConfigRef}.
 * Every field may read `undefined`: the Host never sends a `role('secret')` field, keeps a field it cannot project
 * unsent, and may send values of a Host build that does not yet match the running browser code. The plugin handles
 * the absent value at each read.
 */
export type SyncedConfig<C> = {
  readonly [K in keyof C as NonNullable<C[K]> extends Volatile<unknown> ? K : never]-?:
  NonNullable<C[K]> extends Volatile<infer V> ? SyncedConfigRef<V | undefined> : never
}

/** Read-only access to other packages' synced Config; a plugin receives its own through `apply`. */
export interface SyncedConfigService {
  /**
   * The synced Config object of a package's current plugin activation, as that activation's `apply` received it. Each
   * activation receives a new object, so the result changes when the plugin is replaced. The caller states the
   * package's shared Config type.
   * @param packageName - package name of the graph row.
   * @returns the object, or undefined while no activation of the package is running.
   */
  resolveConfigByPackage<C>(packageName: string): SyncedConfig<C> | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Read-only lookup of other packages' synced Config, provided by the client-modules plugin face. */
    config: SyncedConfigService
  }
}
