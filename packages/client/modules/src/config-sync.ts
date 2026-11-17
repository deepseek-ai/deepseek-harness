/**
 * Host-side publication of browser-synced plugin configuration: each graph row carries the projected volatile values
 * of its Loader entry's plugin, and a change of those values republishes the graph.
 */
import { isDeepStrictEqual } from 'node:util'
import { FiberState } from '@deepseek-ai/cordis'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import type z from '@deepseek-ai/schemastery'
import type { SyncedConfigValues } from '@deepseek-ai/dsh-client-config/types'
import type { Principal } from '@deepseek-ai/dsh-typert-protocol'
import type { WebBootEntry, WebBootGraph } from './client/manifest.ts'
import { hasSyncedFields, syncedValues } from './config-projection.ts'

/** Synced values per graph row, owned by the client module registry. */
export class SyncedConfigPublisher {
  /** Last published values per row; undefined for a plugin without top-level volatile fields. */
  private readonly values = new Map<string, SyncedConfigValues | undefined>()
  /**
   * Values the row's schema resolves from an empty Config, served to every non-owner Peer; undefined when the schema
   * declares no top-level volatile field or cannot resolve an empty Config.
   */
  private readonly defaults = new Map<string, SyncedConfigValues | undefined>()
  /** Loader entry name per row of the last composed graph. */
  private rows = new Map<string, string>()
  /** Current root plugin fiber per Loader entry name; of entries sharing a name, the one seen last. */
  private readonly fibers = new Map<string, Fiber>()
  /** `loader/volatile-update` listener disposer per Loader entry name. */
  private readonly watches = new Map<string, () => void>()

  /**
   * @param ctx - the registry's context; the publisher's listeners leave with it.
   * @param entries - the Loader entries present when the registry starts.
   * @param changed - recomposes and republishes the graph after a row's values change.
   */
  constructor(private readonly ctx: Context, entries: Iterable<Entry>, private readonly changed: () => void) {
    for (const entry of entries) if (entry.fiber !== undefined) this.track(entry.options.name, entry.fiber.ctx.fiber)
    // A new plugin instance (install, upgrade, code reload) is seen at creation, so the graph that announces its code
    // already carries values its schema resolves; a status change re-reads values after a (re)start.
    const seen = (fiber: Fiber): void => {
      const entry = fiber.entry
      // Only an entry's live root plugin, by the Loader's own test: a child plugin inherits its parent's entry, and a
      // replaced instance (its uid cleared at disposal) may report its teardown after its successor exists. The
      // successor is not yet `entry.fiber` here, because the Loader assigns that after construction returns.
      if (entry === undefined || fiber.parent.fiber.entry === entry) return
      const name = entry.options.name
      if (fiber.uid === null) {
        if (this.fibers.get(name) !== fiber) return
        // The selected instance is gone; a live entry of the same name, sharing its source, supplies the values.
        const live = [...ctx.loader.entries()]
          .map(candidate => candidate.options.name === name ? candidate.fiber?.ctx.fiber : undefined)
          .find(candidate => candidate !== undefined && candidate.uid !== null)
        if (live === undefined) return
        fiber = live
      }
      this.track(name, fiber)
      this.republish(name)
    }
    ctx.on('internal/plugin', seen)
    ctx.on('internal/status', seen)
    ctx.effect(() => () => {
      for (const dispose of this.watches.values()) dispose()
      this.watches.clear()
    }, 'client-modules: synced configuration watches')
  }

  /**
   * Attach current synced values to composed rows, and drop the values of rows that left the graph.
   * @param entries - composed rows.
   * @param records - the registry table, keyed by row id, naming the Loader entry that supplies each row.
   * @returns the rows, each with its values when it has any.
   */
  apply(entries: WebBootEntry[], records: ReadonlyMap<string, { readonly loaderName: string }>): WebBootEntry[] {
    this.rows = new Map([...records].map(([id, record]) => [id, record.loaderName]))
    for (const id of this.values.keys()) if (!this.rows.has(id)) this.values.delete(id)
    for (const id of this.defaults.keys()) if (!this.rows.has(id)) this.defaults.delete(id)
    for (const [id, loaderName] of this.rows) this.refresh(id, loaderName)
    return entries.map(({ config: _published, ...row }) => {
      const config = this.values.get(row.id)
      return config === undefined ? row : { ...row, config }
    })
  }

  /**
   * The graph one Peer receives, at first render and in every plugin-events frame. The owner receives the configured
   * values; every other Peer receives each row's schema defaults instead, so the owner's values stay on the Host.
   * @param graph - the composed graph.
   * @param principal - the Peer's principal; undefined for the owner or an in-process caller.
   * @returns the graph itself for the owner, otherwise a copy whose row values are the schema defaults.
   */
  graphFor(graph: WebBootGraph, principal: Principal | undefined): WebBootGraph {
    /* oxlint-disable typescript/no-unnecessary-condition -- other packages merge non-owner principal kinds into the map
       this program sees with only the owner kind. */
    if (principal === undefined || principal.kind === 'owner') return graph
    /* oxlint-enable typescript/no-unnecessary-condition */
    return {
      ...graph,
      entries: graph.entries.map(({ config: _config, ...row }) => {
        const config = this.defaults.get(row.id)
        return config === undefined ? row : { ...row, config }
      }),
    }
  }

  private track(name: string, fiber: Fiber): void {
    this.fibers.set(name, fiber)
    // `loader/volatile-update` reaches only listeners on the updated fiber's own context, and a listener there lasts one
    // activation, so each activation registers it again. Prepended: the graph frame carrying the new values is queued
    // before the plugin's own listeners can push data that depends on them.
    if (fiber.state !== FiberState.ACTIVE) return
    this.watches.get(name)?.()
    this.watches.set(name, fiber.ctx.on('loader/volatile-update', () => { this.republish(name) }, { prepend: true }))
  }

  private republish(name: string): void {
    let changed = false
    for (const [id, loaderName] of this.rows) if (loaderName === name && this.refresh(id, loaderName)) changed = true
    if (changed) this.changed()
  }

  /**
   * Recompute one row's values; equal values (deep equality) change nothing.
   * @returns whether the row's values changed.
   */
  private refresh(id: string, loaderName: string): boolean {
    const fiber = this.fibers.get(loaderName)
    /* v8 ignore next -- a table row comes from a Loader entry whose root fiber was tracked at startup or creation. */
    if (fiber === undefined) return false
    const runtimeSchema = fiber.runtime?.Config
    // A plugin without synced fields is never resolved here.
    const schema = runtimeSchema !== undefined && 'toJSON' in runtimeSchema && hasSyncedFields(runtimeSchema as z)
      ? runtimeSchema as z
      : undefined
    this.defaults.set(id, schema === undefined ? undefined : this.defaultValues(schema, fiber, id))
    let values: SyncedConfigValues | undefined
    try {
      // Before activation there is no effective Config; resolving the raw config with the instance's own schema gives
      // the object activation will receive.
      values = schema === undefined ? undefined : syncedValues(schema, fiber.effectiveConfig ?? fiber.resolveConfig(fiber.rawConfig), id)
    } catch (error) {
      // Containment: one plugin's unsyncable value keeps its last published values and leaves the other rows intact.
      this.ctx.logger.error(error)
      return false
    }
    if (isDeepStrictEqual(this.values.get(id), values)) return false
    this.values.set(id, values)
    return true
  }

  private defaultValues(schema: z, fiber: Fiber, id: string): SyncedConfigValues | undefined {
    try {
      return syncedValues(schema, fiber.resolveConfig({}), id)
    } catch (error) {
      // A schema with a required field that has no default rejects an empty Config; such a row then carries no values
      // for a non-owner Peer, and its plugin reads every field as absent there.
      this.ctx.logger.debug(error)
      return undefined
    }
  }
}
