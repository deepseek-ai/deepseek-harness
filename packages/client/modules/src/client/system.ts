/**
 * ClientModuleSystem — the implementation behind the {@link ClientModuleLoader}
 * contract. The conceptual contract (lazy CJS model, resolution branch order) is
 * documented on the public interfaces in `./manifest.ts`; this file owns the
 * state tables and the load/materialize machinery.
 */
import { stripClientSuffix } from './manifest.ts'
import { ClientEntries } from './entries.ts'
import { removeOwnedStyles } from './entry-lifecycle.ts'
import type {
  BootManifest, BootModuleRow, ClientBundleRegistration, ClientBundleRequire, ClientModuleLoader, ClientModuleRecord,
  ClientModuleSystemOptions,
} from './manifest.ts'

/** Default bundle-load hook: same-origin external classic script. */
const defaultLoadBundle = (url: string): Promise<void> => new Promise((resolve, reject) => {
  const el = document.createElement('script')
  el.async = true
  el.src = url
  el.addEventListener('load', () => {
    el.remove()
    resolve()
  }, { once: true })
  el.addEventListener('error', () => {
    el.remove()
    reject(new Error(`client-modules: bundle script ${url} failed to load`))
  }, { once: true })
  document.head.append(el)
})

/** Replace the rev query while preserving absolute, protocol-relative, or path-relative form. */
function atRevision(url: string, rev: string): string {
  if (!/[?&]rev=[^&#]*/.test(url)) {
    throw new Error(`client-modules: bundle URL ${url} has no revision`)
  }
  return url.replace(/([?&]rev=)[^&#]*/, `$1${encodeURIComponent(rev)}`)
}

const CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/

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
 * Claim and inventory the <style> tags a factory injected during
 * materialization: preset-emitted tags arrive pre-tagged with data-plugin;
 * any untagged tag is claimed for the materializing plugin (HMR bookkeeping).
 */
const claimStyles = (id: string): string[] => {
  if (typeof document === 'undefined') return []
  for (const el of document.querySelectorAll('style:not([data-plugin])')) {
    el.setAttribute('data-plugin', id)
  }
  const owned: string[] = []
  for (const el of document.querySelectorAll(`style[data-plugin=${JSON.stringify(id)}]`)) {
    owned.push(el.getAttribute('data-plugin-css') ?? id)
  }
  return owned
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

  private readonly seed: Map<string, unknown>
  private readonly factories = new Map<string, { factory: ClientBundleRegistration['factory']; rev: string | undefined }>()
  private readonly bootstrapIds = new Set<string>()
  /** In-flight script transport per URL; every row in one batch shares it. */
  private readonly pendingArrival = new Map<string, Promise<void>>()
  /** Owner generation captured by in-flight chunk requests and advanced on invalidation. */
  private readonly generations = new Map<string, number>()
  /** Single-resource combo URL selected by HMR after invalidating one row. */
  private readonly reloadTargets = new Map<string, { url: string; rev: string }>()
  /** Materialization re-entrancy guard: factory-form CJS cannot deliver partial exports, so a cycle is fatal. */
  private readonly materializing = new Set<string>()
  private readonly graphRows = new Map<string, BootModuleRow>()
  private readonly loadBundle: (url: string) => Promise<void>

  /**
   * Build the module system over the parsed boot rows.
   * @param options - Parsed graph, platform seed, bootstrap module, registration facade, and transport.
   */
  constructor(options: ClientModuleSystemOptions) {
    this.manifest = options.manifest
    this.entries = new ClientEntries(this, {
      update: (manifest, managed) => { this.updateManifest(manifest, managed) },
      invalidateForReplacement: (id, rev) => {
        if (this.bootstrapIds.has(id)) throw new Error(`client-modules: replacing bootstrap module ${id} requires a page reload`)
        this.invalidate(id, rev)
      },
      prune: (roots) => { this.prune(roots) },
    })
    this.seed = new Map(Object.entries(options.staticModules))
    this.loadBundle = options.loadBundle ?? defaultLoadBundle

    for (const row of options.manifest.modules) {
      this.graphRows.set(row.id, row)
    }

    const bootstrapId = stripClientSuffix(options.bootstrapModule.id)
    this.bootstrapIds.add(bootstrapId)
    this.loadCache.set(bootstrapId, {
      id: bootstrapId,
      exports: options.bootstrapModule.exports,
      styles: [],
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
    for (const registration of pending) target.load(registration)
  }

  /** Register one bundle factory, rejecting a script that executes twice without invalidation. */
  private register(registration: ClientBundleRegistration): void {
    const ownerId = stripClientSuffix(registration.id)
    if (registration.chunk !== undefined && !CLIENT_CHUNK.test(registration.chunk)) {
      throw new Error(`client-modules: invalid package-local chunk ${JSON.stringify(registration.chunk)}`)
    }
    const id = registration.chunk === undefined ? ownerId : chunkId(ownerId, registration.chunk)
    if (this.bootstrapIds.has(id) || this.factories.has(id)) {
      const registrationName = registration.chunk === undefined ? registration.id : id
      throw new Error(`client-modules: duplicate factory registration for "${registrationName}" (bundle executed twice without invalidate?)`)
    }
    this.factories.set(id, {
      factory: registration.factory,
      rev: this.reloadTargets.get(ownerId)?.rev ?? this.graphRows.get(ownerId)?.rev,
    })
  }

  /** Load one graph row so its factory is registered (idempotent per in-flight arrival). */
  private arrive(row: BootModuleRow): Promise<void> {
    const { id } = row
    if (this.loadCache.has(id) || this.factories.has(id)) return Promise.resolve()
    const reload = this.reloadTargets.get(id)
    const url = reload?.url ?? row.initialUrl
    let transport = this.pendingArrival.get(url)
    if (transport === undefined) {
      transport = this.loadBundle(url).finally(() => { this.pendingArrival.delete(url) })
      this.pendingArrival.set(url, transport)
    }
    return transport.then(() => {
      if (!this.factories.has(id)) {
        throw new Error(`client-modules: bundle ${url} loaded without registering "${id}" via __ModuleLoader__.load`)
      }
      if (reload !== undefined && this.reloadTargets.get(id) === reload) {
        this.reloadTargets.delete(id)
      }
    })
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
      const id = stripClientSuffix(request)
      if (this.seed.has(request) || this.loadCache.has(id)) continue
      const dependency = this.graphRows.get(id)
      if (dependency !== undefined) await this.arriveGraphRow(dependency, next, visited)
    }
    for (const packageName of row.inject) {
      const dependency = this.graphRows.get(packageName)
      if (dependency !== undefined) await this.arriveGraphRow(dependency, [], visited)
    }
    await this.arrive(row)
  }

  /** Materialize a registered factory (synchronous; memoized in loadCache). */
  private materialize(id: string, ownerId = id): ClientModuleRecord {
    const existing = this.loadCache.get(id)
    if (existing !== undefined) return existing
    const registered = this.factories.get(id)
    /* v8 ignore next -- callers check the factory branch before dispatching here. */
    if (registered === undefined) throw new Error(`client-modules: no registered factory for "${id}"`)
    if (this.materializing.has(id)) {
      throw new Error(`client-modules: require cycle through "${id}" (factory-form CJS cannot deliver partial exports)`)
    }
    this.materializing.add(id)
    try {
      const edges = new Set<string>()
      const exports = registered.factory(this.makeRequire(ownerId, edges))
      const record: ClientModuleRecord = { id, exports, styles: claimStyles(ownerId), edges }
      this.loadCache.set(id, record)
      return record
    } catch (error) {
      removeOwnedStyles(ownerId)
      throw error
    } finally {
      this.materializing.delete(id)
    }
  }

  /** Build the synchronous module-table require and its asynchronous chunk operation. */
  private makeRequire(ownerId: string, edges: Set<string>): ClientBundleRequire {
    const require = (spec: string): unknown => {
      edges.add(spec)
      if (this.seed.has(spec)) return this.seed.get(spec)
      const id = stripClientSuffix(spec)
      const record = this.loadCache.get(id)
      if (record !== undefined) return record.exports
      if (this.factories.has(id)) return this.materialize(id).exports
      throw new Error(
        `client-modules: require("${spec}") missed the module table — not a platform seed word, not a materialized module, `
        + 'and no registered package factory (a build-time externals drift, or a dynamic dependency that did not arrive)',
      )
    }
    require.async = async (spec: string): Promise<unknown> => {
      edges.add(spec)
      if (!spec.startsWith('./')) return await this.import(spec)
      const fileName = spec.slice(2)
      if (!CLIENT_CHUNK.test(fileName)) {
        throw new Error(`client-modules: invalid relative chunk request ${JSON.stringify(spec)}`)
      }
      return await this.importChunk(ownerId, fileName)
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
      let transport = this.pendingArrival.get(url)
      if (transport === undefined) {
        transport = this.loadBundle(url).finally(() => { this.pendingArrival.delete(url) })
        this.pendingArrival.set(url, transport)
      }
      await transport
      if ((this.generations.get(ownerId) ?? 0) !== generation) {
        this.factories.delete(id)
        this.loadCache.delete(id)
        return await this.importChunk(ownerId, fileName)
      }
      if (!this.factories.has(id)) {
        throw new Error(`client-modules: bundle ${url} loaded without registering "${id}" via __ModuleLoader__.load`)
      }
    }
    return this.materialize(id, ownerId).exports
  }

  async import(specifier: string): Promise<unknown> {
    if (this.seed.has(specifier)) return this.seed.get(specifier)
    const id = stripClientSuffix(specifier)
    const existing = this.loadCache.get(id)
    if (existing !== undefined) return existing.exports
    const row = this.graphRows.get(id)
    if (row !== undefined) {
      await this.arriveGraphRow(row)
    } else if (!this.factories.has(id)) {
      throw new Error(
        `client-modules: cannot resolve "${specifier}" — not a seed word, not a materialized module, `
        + 'and not a row in the boot graph (the runtime mirror of the bundle purity gate)',
      )
    }
    return this.materialize(id).exports
  }

  async prefetch(id: string): Promise<void> {
    const normalized = stripClientSuffix(id)
    if (this.loadCache.has(normalized)) return
    const row = this.graphRows.get(normalized)
    if (row === undefined) throw new Error(`client-modules: prefetch("${id}") — not a graph entry`)
    await this.arriveGraphRow(row)
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
        removeOwnedStyles(row.id)
      }
    }
    this.manifest = manifest
  }

  /** Retain live Loader modules and their transitive requests before evicting unreferenced graph records. */
  private prune(roots: Iterable<string>): void {
    const retained = new Set<string>(this.bootstrapIds)
    const visit = (specifier: string): void => {
      const id = stripClientSuffix(specifier)
      if (retained.has(id)) return
      retained.add(id)
      const row = this.graphRows.get(id)
      for (const request of [...row?.external ?? [], ...row?.inject ?? [], ...this.loadCache.get(id)?.edges ?? []]) {
        visit(request)
      }
    }
    for (const row of this.manifest.modules) visit(row.id)
    for (const id of roots) visit(id)
    for (const id of this.graphRows.keys()) {
      if (retained.has(id)) continue
      this.graphRows.delete(id)
      this.invalidate(id)
      removeOwnedStyles(id)
    }
  }

  invalidate(id: string, rev?: string): void {
    const normalized = stripClientSuffix(id)
    if (this.bootstrapIds.has(normalized)) return
    this.generations.set(normalized, (this.generations.get(normalized) ?? 0) + 1)
    const row = this.graphRows.get(normalized)
    if (row !== undefined) {
      const revision = rev ?? row.rev
      this.reloadTargets.set(normalized, { url: atRevision(row.url, revision), rev: revision })
    } else this.reloadTargets.delete(normalized)
    for (const key of this.factories.keys()) {
      if (key === normalized || key.startsWith(`${normalized}/client.`)) this.factories.delete(key)
    }
    for (const key of this.loadCache.keys()) {
      if (key === normalized || key.startsWith(`${normalized}/client.`)) this.loadCache.delete(key)
    }
  }
}
