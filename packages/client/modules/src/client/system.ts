/**
 * ClientModuleSystem — the implementation behind the {@link ClientModuleLoader}
 * contract. The conceptual contract (lazy CJS model, resolution branch order) is
 * documented on the public interfaces in `./manifest.ts`; this file owns the
 * state tables and the load/materialize machinery.
 */
import { stripClientSuffix } from './manifest.ts'
import { ClientEntries } from './entries.ts'
import { MainScriptRealm } from './main-realm.ts'
import { notifySubscribers } from './notify.ts'
import type {
  BootManifest, BootModuleRow, ClientBundleRegistration, ClientBundleRequire, ClientModuleLoader, ClientModuleRecord,
  ClientModuleSystemOptions,
} from './manifest.ts'

/** Replace the rev query while preserving absolute, protocol-relative, or path-relative form. */
function atRevision(url: string, rev: string): string {
  if (!/[?&]rev=[^&#]*/.test(url)) {
    throw new Error(`client-modules: bundle URL ${url} has no revision`)
  }
  return url.replace(/([?&]rev=)[^&#]*/, `$1${encodeURIComponent(rev)}`)
}

const CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/

/** The message of a thrown value: an Error's message, anything else stringified. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Internal module-table key for one package-local chunk. */
function chunkId(ownerId: string, fileName: string): string {
  return `${ownerId}/${fileName}`
}

/** Resolve a sibling chunk against the package's one-resource URL and current revision. */
function chunkUrl(row: BootModuleRow, fileName: string, rev: string): string {
  const url = atRevision(row.url, rev)
  const marker = '/??'
  const resourceStart = url.indexOf(marker)
  const revisionStart = url.indexOf('&rev=', resourceStart + marker.length)
  const resource = resourceStart < 0 || revisionStart < 0
    ? undefined
    : url.slice(resourceStart + marker.length, revisionStart)
  if (resource !== `${row.id}/client.js`) {
    throw new Error(`client-modules: cannot resolve chunk ${JSON.stringify(fileName)} from bundle URL ${url}`)
  }
  return `${url.slice(0, resourceStart)}/${row.id}/${fileName}?${url.slice(revisionStart + 1)}`
}

/**
 * The client module system: state tables plus the arrival/materialization
 * machinery implementing {@link ClientModuleLoader} (whose members carry the
 * contract documentation). Construction indexes the boot rows, retains the
 * already-materialized bootstrap module, and switches the HTML-installed
 * loader facade from its pending queue to live registration.
 */
export class ClientModuleSystem implements ClientModuleLoader {
  readonly version = 'client'
  manifest: BootManifest
  readonly entries: ClientEntries
  readonly loadCache = new Map<string, ClientModuleRecord>()
  readonly mainRealm: MainScriptRealm
  /** Previous records of packages under replacement, by package id, until their old runtime is released. */
  private readonly replaced = new Map<string, ClientModuleRecord[]>()
  private readonly moduleListeners = new Set<() => void>()
  private readonly factories = new Map<string, { manifest: ClientBundleRegistration; factory: ClientBundleRegistration['factory']; rev: string | undefined }>()
  private readonly bootstrapIds = new Set<string>()
  private readonly staticIds = new Set<string>()
  /** In-flight script transport per URL. */
  private readonly pendingArrival = new Map<string, Promise<void>>()
  /** Owner generation captured by in-flight chunk requests and advanced on invalidation. */
  private readonly generations = new Map<string, number>()
  /** Single-resource combo URL selected by HMR after invalidating one row. */
  private readonly reloadTargets = new Map<string, { url: string; rev: string }>()
  /** Materialization re-entrancy guard: factory-form CJS cannot deliver partial exports, so a cycle is fatal. */
  private readonly materializing = new Set<string>()
  private readonly graphRows = new Map<string, BootModuleRow>()
  readonly resolveAsset: (reference: string) => string
  /** Last import or prefetch failure per graph row, cleared by a later success or invalidation. */
  private readonly importErrors = new Map<string, Error>()
  /** Batch URLs whose transport or execution already failed; rows still missing from them go straight to their one-resource URL. */
  private readonly failedBundleUrls = new Set<string>()
  /** Every URL whose script has executed once; a batch among them is never requested again. */
  private readonly executedBundleUrls = new Set<string>()

  /**
   * Build the module system over the parsed boot rows.
   * @param options - Parsed graph, delivered manifests, bootstrap module, registration facade, and transport.
   */
  constructor(options: ClientModuleSystemOptions) {
    this.manifest = options.manifest
    this.entries = new ClientEntries(this, {
      update: (manifest, managed) => { this.updateManifest(manifest, managed) },
      invalidateForReplacement: (id, rev) => {
        if (this.bootstrapIds.has(id)) throw new Error(`client-modules: replacing bootstrap module ${id} requires a page reload`)
        this.drop(id, rev, true)
      },
      releaseReplaced: (id) => {
        if (this.replaced.delete(this.resolveModuleId(id))) this.publishModules()
      },
      prune: (roots) => { this.prune(roots) },
    })
    this.mainRealm = new MainScriptRealm(options.loadBundle)
    this.resolveAsset = options.resolveAsset ?? (reference => reference)

    for (const row of options.manifest.modules) {
      this.graphRows.set(row.id, row)
    }

    const bootstrapId = stripClientSuffix(options.bootstrapModule.id)
    this.bootstrapIds.add(bootstrapId)
    this.loadCache.set(bootstrapId, {
      id: bootstrapId,
      ownerId: bootstrapId,
      exports: options.bootstrapModule.exports,
      edges: new Set(),
    })

    const target = options.registrationTarget
    if (target.mode !== 'queue') {
      throw new Error('client-modules: window.__ModuleLoader__.create called after module-system boot')
    }
    const pending = target.pendingQueue.splice(0)
    // Switch first: a bundle that executes while pending registrations drain
    // must register live rather than append behind the drain.
    target.mode = 'live'
    target.load = (registration) => { this.register(registration) }
    for (const registration of options.staticModules) {
      this.staticIds.add(registration.id)
      if (registration.id === bootstrapId && registration.chunk === undefined) continue
      target.load(registration)
    }
    for (const registration of pending) target.load(registration)
  }

  subscribeModules(listener: () => void): () => void {
    this.moduleListeners.add(listener)
    return () => { this.moduleListeners.delete(listener) }
  }

  * activeRecords(): Iterable<ClientModuleRecord> {
    for (const records of this.replaced.values()) yield * records
    yield * this.loadCache.values()
  }

  private publishModules(): void {
    notifySubscribers(this.moduleListeners, 'modules')
  }

  /** Stop accepting script execution and await the startup carrier's pending operations. */
  dispose(): Promise<void> {
    return this.mainRealm.dispose()
  }

  private resolveModuleId(specifier: string): string {
    return this.staticIds.has(specifier) || this.factories.has(specifier) || this.loadCache.has(specifier)
      ? specifier : stripClientSuffix(specifier)
  }

  /** Register one bundle factory, rejecting a script that executes twice without invalidation. */
  private register(registration: ClientBundleRegistration): void {
    const ownerId = registration.id
    if (registration.chunk !== undefined && !CLIENT_CHUNK.test(registration.chunk)) {
      throw new Error(`client-modules: invalid package-local chunk ${JSON.stringify(registration.chunk)}`)
    }
    const id = registration.chunk === undefined ? ownerId : chunkId(ownerId, registration.chunk)
    if (this.loadCache.has(id) || this.factories.has(id)) {
      const registrationName = registration.chunk === undefined ? registration.id : id
      throw new Error(`client-modules: duplicate factory registration for "${registrationName}" (bundle executed twice without invalidate?)`)
    }
    this.factories.set(id, {
      manifest: registration,
      factory: registration.factory,
      rev: this.reloadTargets.get(ownerId)?.rev ?? this.graphRows.get(ownerId)?.rev,
    })
  }

  /** Run one shared script transport per URL. */
  private loadShared(url: string): Promise<void> {
    let transport = this.pendingArrival.get(url)
    if (transport === undefined) {
      transport = this.mainRealm.execute({ url })
        .then(() => { this.executedBundleUrls.add(url) })
        .finally(() => { this.pendingArrival.delete(url) })
      this.pendingArrival.set(url, transport)
    }
    return transport
  }

  /**
   * Load one graph row so its factory is registered (idempotent per in-flight
   * arrival). A batch script is one classic script that registers every
   * package in sequence, and {@link register} rejects a second registration,
   * so the two failure kinds differ: a transport failure (`error` event, nothing
   * executed) is retried once on the same URL; a script that loaded without
   * registering this row (a parse error registered nothing, or a runtime throw
   * stopped it after registering others) is never re-executed, because a replay
   * would stop again at the first duplicate registration; that holds even when
   * the row that first imports from the batch is one it did register, because
   * every executed batch URL is remembered. Either way the row then falls back
   * to its own one-resource URL, which the Host serves for every package, so one
   * failed batch costs at most three requests per missing row and never fails
   * the rows that were registered.
   */
  private async arrive(row: BootModuleRow): Promise<void> {
    const { id } = row
    if (this.loadCache.has(id) || this.factories.has(id)) return
    const reload = this.reloadTargets.get(id)
    const preferred = reload?.url ?? row.initialUrl
    const fallback = reload === undefined && row.url !== preferred ? row.url : undefined
    const failures: string[] = []
    const attempt = async (url: string): Promise<'registered' | 'transport-failed' | 'not-registered'> => {
      try {
        await this.loadShared(url)
      } catch (error) {
        failures.push(`${url}: ${describeError(error)}`)
        return 'transport-failed'
      }
      if (this.factories.has(id)) return 'registered'
      failures.push(`${url}: loaded without registering "${id}" via __ModuleLoader__.load`)
      return 'not-registered'
    }
    let outcome: Awaited<ReturnType<typeof attempt>> = 'transport-failed'
    if (this.failedBundleUrls.has(preferred)) {
      failures.push(`${preferred}: skipped after an earlier failure of this bundle`)
    } else if (fallback !== undefined && this.executedBundleUrls.has(preferred)) {
      // The batch already ran (an earlier importer was a row it did register)
      // and this row is still missing: a replay would stop at the first
      // duplicate registration.
      failures.push(`${preferred}: already executed without registering "${id}"`)
      outcome = 'not-registered'
      this.failedBundleUrls.add(preferred)
    } else {
      outcome = await attempt(preferred)
      if (outcome === 'transport-failed') outcome = await attempt(preferred)
      // Only a batch URL is remembered: a one-resource URL has no fallback and
      // stays retryable on the next import, as before.
      if (outcome !== 'registered' && fallback !== undefined) this.failedBundleUrls.add(preferred)
    }
    if (outcome !== 'registered' && fallback !== undefined) outcome = await attempt(fallback)
    if (outcome !== 'registered') {
      throw new Error(`client-modules: could not load "${id}": ${failures.join('; ')}`)
    }
    if (reload !== undefined && this.reloadTargets.get(id) === reload) {
      this.reloadTargets.delete(id)
    }
  }

  /** Register each injected package and unresolved dynamic request before its consumer. */
  private async arriveGraphRow(
    row: BootModuleRow,
    open: readonly string[] = [],
    visited = new Set<string>(),
  ): Promise<void> {
    const cycleStart = open.indexOf(row.id)
    if (cycleStart !== -1) {
      throw new Error(
        `client-modules: module arrival cycle ${[...open.slice(cycleStart), row.id].join(' -> ')} `
        + '(the host must reject this graph before serving it)',
      )
    }
    if (visited.has(row.id)) return
    visited.add(row.id)
    const next = [...open, row.id]
    for (const request of row.external) {
      const id = this.resolveModuleId(request)
      if (this.loadCache.has(id) || this.factories.has(id) && !this.graphRows.has(id)) continue
      const dependency = this.graphRows.get(id)
      if (dependency !== undefined) await this.arriveDependency(row.id, dependency, next, visited)
    }
    for (const packageName of row.inject) {
      const dependency = this.graphRows.get(packageName)
      if (dependency !== undefined) await this.arriveDependency(row.id, dependency, [], visited)
    }
    await this.arrive(row)
  }

  /** Arrive one dependency, naming the consumer it failed for so a cascade reads as a chain, not as 44 unrelated failures. */
  private async arriveDependency(
    consumerId: string,
    dependency: BootModuleRow,
    open: readonly string[],
    visited: Set<string>,
  ): Promise<void> {
    try {
      await this.arriveGraphRow(dependency, open, visited)
    } catch (error) {
      throw new Error(
        `client-modules: "${consumerId}" not loaded because dependency "${dependency.id}" failed: ${describeError(error)}`,
        { cause: error },
      )
    }
  }

  /** Materialize a registered factory (synchronous; memoized in loadCache). */
  private materialize(id: string): ClientModuleRecord {
    const existing = this.loadCache.get(id)
    if (existing !== undefined) return existing
    const registered = this.factories.get(id)
    /* v8 ignore next -- callers check the factory branch before dispatching here. */
    if (registered === undefined) throw new Error(`client-modules: no registered factory for "${id}"`)
    if (this.materializing.has(id)) {
      throw new Error(`client-modules: require cycle through "${id}" (factory-form CJS cannot deliver partial exports)`)
    }
    this.materializing.add(id)
    let record: ClientModuleRecord
    try {
      const edges = new Set<string>()
      const exports = registered.factory(this.makeRequire(registered.manifest.id, edges, () => {
        if (this.loadCache.get(id)?.edges === edges) this.publishModules()
      }))
      record = { id, ownerId: registered.manifest.id, exports, edges,
        ...(registered.manifest.meta === undefined ? {} : { meta: registered.manifest.meta }) }
      this.loadCache.set(id, record)
    } finally {
      this.materializing.delete(id)
    }
    this.publishModules()
    return record
  }

  /** Build the synchronous module-table require, its asynchronous chunk operation, and its asset resolver. */
  private makeRequire(
    ownerId: string,
    edges: Set<string>,
    onEdgesChanged: () => void,
  ): ClientBundleRequire {
    const resolve = (spec: string): unknown => {
      const id = this.resolveModuleId(spec)
      const record = this.loadCache.get(id)
      if (record !== undefined) return record.exports
      if (this.factories.has(id)) return this.materialize(id).exports
      throw new Error(
        `client-modules: require("${spec}") missed the module table — not a materialized module, `
        + 'and no registered package factory (a build-time externals drift, or a dynamic dependency that did not arrive)',
      )
    }
    const recordEdge = (spec: string): void => {
      if (edges.has(spec)) return
      edges.add(spec)
      // A relative chunk request stays inside its package; the chunk's own record is published when it materializes.
      if (!spec.startsWith('./')) onEdgesChanged()
    }
    const require = (spec: string): unknown => {
      const exports = resolve(spec)
      recordEdge(spec)
      return exports
    }
    require.asset = (reference: string): string => this.resolveAsset(reference)
    require.async = async (spec: string): Promise<unknown> => {
      if (!spec.startsWith('./')) {
        const exports = await this.import(spec)
        recordEdge(spec)
        return exports
      }
      const fileName = spec.slice(2)
      if (!CLIENT_CHUNK.test(fileName)) {
        throw new Error(`client-modules: invalid relative chunk request ${JSON.stringify(spec)}`)
      }
      const exports = await this.importChunk(ownerId, fileName)
      recordEdge(spec)
      return exports
    }
    return require
  }

  /** Load, register, and materialize one package-local dynamic chunk. */
  private async importChunk(ownerId: string, fileName: string): Promise<unknown> {
    const id = chunkId(ownerId, fileName)
    const existing = this.loadCache.get(id)
    if (existing !== undefined) return existing.exports
    if (!this.factories.has(id)) {
      const generation = this.generations.get(ownerId) ?? 0
      const row = this.graphRows.get(ownerId)
      if (row === undefined) throw new Error(`client-modules: chunk owner "${ownerId}" is not a boot graph entry`)
      /* v8 ignore next -- the final fallback needs an impossible graph-owned factory with no recorded revision. */
      const revision = this.factories.get(ownerId)?.rev ?? this.reloadTargets.get(ownerId)?.rev ?? row.rev
      const url = chunkUrl(row, fileName, revision)
      await this.loadShared(url)
      if ((this.generations.get(ownerId) ?? 0) !== generation) {
        this.factories.delete(id)
        if (this.loadCache.delete(id)) this.publishModules()
        return await this.importChunk(ownerId, fileName)
      }
      if (!this.factories.has(id)) {
        throw new Error(`client-modules: bundle ${url} loaded without registering "${id}" via __ModuleLoader__.load`)
      }
    }
    return this.materialize(id).exports
  }

  async import(specifier: string): Promise<unknown> {
    const id = this.resolveModuleId(specifier)
    const existing = this.loadCache.get(id)
    if (existing !== undefined) return existing.exports
    const row = this.graphRows.get(id)
    if (row === undefined) {
      if (this.factories.has(id)) return this.materialize(id).exports
      throw new Error(
        `client-modules: cannot resolve "${specifier}" — not a materialized module, `
        + 'and not a row in the boot graph (the runtime mirror of the bundle purity gate)',
      )
    }
    return this.recordingImportError(id, async () => {
      await this.arriveGraphRow(row)
      return this.materialize(id).exports
    })
  }

  async prefetch(id: string): Promise<void> {
    const normalized = this.resolveModuleId(id)
    if (this.loadCache.has(normalized)) return
    const row = this.graphRows.get(normalized)
    if (row === undefined && this.factories.has(normalized)) return
    if (row === undefined) throw new Error(`client-modules: prefetch("${id}") — not a graph entry`)
    await this.recordingImportError(normalized, () => this.arriveGraphRow(row))
  }

  importError(id: string): Error | undefined {
    return this.importErrors.get(stripClientSuffix(id))
  }

  /**
   * Run one graph-row operation, recording its failure for the boot audit and
   * clearing the record on success. Arrival and materialization both run in
   * here, so a factory that throws is recorded as well as a bundle that never
   * arrived; the Loader only sees a missing fiber either way.
   */
  private async recordingImportError<T>(id: string, operation: () => Promise<T>): Promise<T> {
    try {
      const result = await operation()
      this.importErrors.delete(id)
      return result
    } catch (error) {
      this.importErrors.set(id, error instanceof Error ? error : new Error(describeError(error)))
      throw error
    }
  }

  /** Refresh descriptors and unowned factory revisions before any entry imports its dependencies. */
  private updateManifest(manifest: BootManifest, managed: Iterable<string>): void {
    for (const id of this.bootstrapIds) {
      if (this.manifest.modules.some(row => row.id === id) && !manifest.modules.some(row => row.id === id)) {
        throw new Error(`client-modules: removing bootstrap module ${id} requires a page reload`)
      }
    }
    const owned = new Set(managed)
    for (const row of manifest.modules) {
      this.graphRows.set(row.id, { ...row, initialUrl: row.url })
      const cachedRevision = this.factories.get(row.id)?.rev ?? this.reloadTargets.get(row.id)?.rev
      if (!owned.has(row.id) && cachedRevision !== undefined && cachedRevision !== row.rev) {
        this.invalidate(row.id, row.rev)
      }
    }
    this.manifest = manifest
  }

  /** Retain live Loader modules and their transitive requests before evicting unreferenced graph records. */
  private prune(roots: Iterable<string>): void {
    const retained = new Set<string>(this.bootstrapIds)
    const visit = (specifier: string): void => {
      const id = this.resolveModuleId(specifier)
      if (retained.has(id)) return
      retained.add(id)
      const row = this.graphRows.get(id)
      // A replaced runtime that is still mounted keeps the modules its previous records requested.
      const observed = [this.loadCache.get(id), ...this.replaced.get(id) ?? []].flatMap(record => [...record?.edges ?? []])
      for (const request of [...row?.external ?? [], ...row?.inject ?? [], ...observed]) {
        visit(request)
      }
    }
    for (const id of this.staticIds) visit(id)
    for (const row of this.manifest.modules) visit(row.id)
    for (const id of roots) visit(id)
    for (const id of this.graphRows.keys()) {
      if (retained.has(id)) continue
      this.graphRows.delete(id)
      this.invalidate(id)
    }
  }

  invalidate(id: string, rev?: string): void {
    this.drop(id, rev, false)
  }

  /**
   * Reset one package's code. With `retain`, its materialized records stay in {@link activeRecords}
   * until `releaseReplaced`, because the runtime created from them is still running.
   */
  private drop(id: string, rev: string | undefined, retain: boolean): void {
    const normalized = this.resolveModuleId(id)
    if (this.bootstrapIds.has(normalized)) throw new Error(`client-modules: replacing bootstrap module ${normalized} requires a page reload`)
    if (this.staticIds.has(normalized)) return
    this.importErrors.delete(normalized)
    this.generations.set(normalized, (this.generations.get(normalized) ?? 0) + 1)
    const row = this.graphRows.get(normalized)
    if (row !== undefined) {
      const revision = rev ?? row.rev
      this.reloadTargets.set(normalized, { url: atRevision(row.url, revision), rev: revision })
    } else this.reloadTargets.delete(normalized)
    for (const key of this.factories.keys()) {
      if (key === normalized || key.startsWith(`${normalized}/client.`)) this.factories.delete(key)
    }
    const removed: ClientModuleRecord[] = []
    for (const [key, record] of this.loadCache) {
      if (key === normalized || key.startsWith(`${normalized}/client.`)) {
        this.loadCache.delete(key)
        removed.push(record)
      }
    }
    if (retain) {
      if (removed.length > 0) this.replaced.set(normalized, [...this.replaced.get(normalized) ?? [], ...removed])
      return
    }
    if (this.replaced.delete(normalized) || removed.length > 0) this.publishModules()
  }
}
