/**
 * Node half of the client module system (`dsh.client` dual-face package): scans
 * the host Loader's entries for packages declaring `dsh.client`, composes the
 * `window.__DSH_BOOT__` entry graph (wire single source: {@link WebBootEntry}
 * in `./client/manifest.ts`) in module-graph order, serves one-or-more-plugin
 * combo scripts plus their source maps,
 * contributes the registration facade, application preloads, bootstrap scripts,
 * and graph to the webserver's index injection table, and provides the
 * `clientModuleHost` service (the HMR node half's registration/notification
 * face).
 *
 * Scanning is incremental per package — there is no full-rescan code path.
 * Every cordis `internal/plugin` emission (fiber construction/disposal) marks
 * the fiber's entry name dirty; a microtask flush reconciles each dirty name
 * against the live loader entries. The activation pass seeds the same dirty
 * set with all current entries and flushes synchronously, so first scan and
 * steady state share one implementation. Package metadata (including the
 * negative "not a client package" verdict) is cached per Loader specifier and
 * owning-tree base URL until restart. The manifest package name identifies
 * the browser module; distinct active Loader sources for that package are a
 * composition error. Bundle content changes reach the graph only through
 * {@link ClientModuleRegistry.rebuilt}.
 * @module @deepseek-ai/dsh-client-modules
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import type { DshClientManifest } from '@deepseek-ai/dsh-package-manifest'
import { optionalStringArray, stripClientSuffix } from './client/manifest.ts'
import type { WebBootBatch, WebBootBatchPhase, WebBootEntry, WebBootGraph } from './client/manifest.ts'

export { stripClientSuffix } from './client/manifest.ts'
export type {
  BootManifest, BootModuleRow, BootPluginRow, WebBootBatch, WebBootBatchPhase, WebBootEntry, WebBootGraph,
} from './client/manifest.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The web plugin table (provided by the client-modules node half). */
    clientModules: ClientModuleRegistry
  }
}

/** The declared fields a graph row carries, normalized (absent array declarations become empty). */
interface WebBootRowFields {
  inject?: string[]
  /** Module specifiers the package requests from the module table. */
  external: string[]
  immediately: boolean
}

/** Filesystem baseline captured before a client artifact snapshot is read. */
export interface ClientArtifactBaseline {
  /** Absolute path of the client bundle. */
  readonly path: string
  /** Bundle modification time in milliseconds. */
  readonly mtimeMs: number
  /** Bundle size in bytes. */
  readonly size: number
}

/** Resolved metadata cached for one Loader specifier and owning-tree base URL until restart. */
interface PkgMeta extends WebBootRowFields {
  clientPath: string
}

interface ResolvedPkgMeta {
  packageName: string
  meta: PkgMeta
}

/** One active Loader source and the browser package manifest it resolves to. */
interface ClientPackageSource extends ResolvedPkgMeta {
  /** Loader specifier from the active row. */
  loaderName: string
  /** Resolution base of the config tree that owns the row. */
  baseUrl: string
  /** Stable cache and contribution key for this source. */
  sourceKey: string
}

/** Recovery instruction shared by grouped startup and steady-state bundle diagnostics. */
const CLIENT_BUNDLE_BUILD_INSTRUCTION = 'run `pnpm run build` before launch'

/** Missing built client export, retained as structured data for activation-error grouping. */
class MissingClientBundleError extends Error {
  constructor(
    readonly packageName: string,
    readonly clientPath: string,
    cause: unknown,
  ) {
    super(
      [
        `client-modules: client bundle not found; ${CLIENT_BUNDLE_BUILD_INSTRUCTION}:`,
        `  package: ${packageName}`,
        `  path: ${clientPath}`,
      ].join('\n'),
      { cause },
    )
  }
}

/** Activation failures grouped by actionable package-build errors and unrelated failures. */
class ClientPackageCompositionError extends AggregateError {
  constructor(failures: Error[]) {
    const missingBundles = failures.filter((error): error is MissingClientBundleError => error instanceof MissingClientBundleError)
    const otherFailures = failures.filter(error => !(error instanceof MissingClientBundleError))
    const packageNoun = failures.length === 1 ? 'package' : 'packages'
    const lines = [`client-modules: ${String(failures.length)} client ${packageNoun} failed to compose:`]
    if (missingBundles.length > 0) {
      lines.push(`  client bundles not found; ${CLIENT_BUNDLE_BUILD_INSTRUCTION}:`)
      for (const error of missingBundles) {
        lines.push(`    - package: ${error.packageName}`, `      path: ${error.clientPath}`)
      }
    }
    if (otherFailures.length > 0) {
      lines.push('  other failures:', ...otherFailures.map(error => `    - ${error.message}`))
    }
    super(failures, lines.join('\n'))
  }
}

/** One composed table row: the wire entry plus the resolved package metadata behind it. */
interface WebPluginRecord {
  entry: WebBootEntry
  /** Loader specifier whose active row contributes this browser module. */
  loaderName: string
  /** Loader resolution input that selected this package instance. */
  sourceKey: string
  meta: PkgMeta
  /** Exact build artifact included in the startup batches. */
  bundle: Buffer
  /** Pre-read filesystem baseline handed to the HMR watcher. */
  baseline: ClientArtifactBaseline
  /** Optional authored source map snapshot; generated-file identity mapping is the fallback. */
  sourceMap?: { body: Buffer; parsed: Record<string, unknown> }
}

/** Fields shared by every generated combo response. */
interface ComboArtifactBase {
  url: string
  rev: string
  entries: string[]
  script: Buffer
}

/** One generated combo response over an ordered list of plugin resources. */
interface ComboArtifact extends ComboArtifactBase {
  sourceMap: Buffer
  sourceMapUrl: string
}

/** One generated initial-load response and its wire descriptor. */
type BatchArtifact = ComboArtifact & { descriptor: WebBootBatch }

/** Versioned code is immutable; mismatched revisions are rejected instead of serving newer bytes. */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable'
/** Generated request URLs stay below conservative browser and intermediary request-target limits. */
const MAX_COMBO_URL_BYTES = 3 * 1024
const HASH_REVISION_LENGTH = 12
const COMBO_REVISION_PLACEHOLDER = '0'.repeat(HASH_REVISION_LENGTH)

/** Source-map trailer emitted by tsdown at the end of every client bundle. */
const SOURCE_MAP_TRAILER = /(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/
/** Debugger source name appended to page bundles in the WebWorker image. */
const SOURCE_URL_TRAILER = /(?:\r?\n)?\/\/# sourceURL=([^\r\n]+)(?:\r?\n)?$/

/** Return a bare package-root specifier, excluding package subpaths and path-like entries. */
function exactPackageSpecifier(specifier: string): string | undefined {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/')
    return parts.length === 2 && parts.every(Boolean) ? specifier : undefined
  }
  return specifier.length > 0 && !specifier.includes('/') ? specifier : undefined
}

/** Narrow an unknown parsed JSON value to the `dsh.client` declaration, throwing on malformed fields. */
function parseDshClient(pkgName: string, value: unknown): DshClientManifest | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) {
    throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`)
  }
  const decl = value as Record<string, unknown>
  if (typeof decl.platform !== 'string') {
    throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`)
  }
  const inject = optionalStringArray(pkgName, 'dsh.client.inject', decl.inject)
  const external = optionalStringArray(pkgName, 'dsh.client.external', decl.external)
  if (decl.immediately !== undefined && typeof decl.immediately !== 'boolean') {
    throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`)
  }
  return {
    platform: decl.platform,
    ...(inject !== undefined ? { inject } : {}),
    ...(external !== undefined ? { external } : {}),
    ...(decl.immediately !== undefined ? { immediately: decl.immediately } : {}),
  }
}

/** Resolve `exports["./client"]` to a relative path, accepting the string and one-level conditional forms. */
function clientExportOf(pkgName: string, exportsField: unknown): string | undefined {
  if (typeof exportsField !== 'object' || exportsField === null) return undefined
  const client = (exportsField as Record<string, unknown>)['./client']
  if (client === undefined) return undefined
  if (typeof client === 'string') return client
  if (typeof client === 'object' && client !== null) {
    const fallback = (client as Record<string, unknown>).default
    if (typeof fallback === 'string') return fallback
  }
  throw new Error(`client-modules: ${pkgName} exports["./client"] must be a string or an object with a string default`)
}

/** sha1 content hash shortened to 12 hex chars (combo / graph / rebuilt-artifact rev). */
function shortHash(input: string | Buffer): string {
  return createHash('sha1').update(input).digest('hex').slice(0, HASH_REVISION_LENGTH)
}

/** Hash several response fields without allowing bytes to move across field boundaries. */
function framedHash(domain: string, parts: readonly Buffer[]): string {
  const hash = createHash('sha1').update(domain).update('\0')
  for (const part of parts) hash.update(`${String(part.byteLength)}:`).update(part)
  return hash.digest('hex').slice(0, HASH_REVISION_LENGTH)
}

/** Hash every artifact input served after HMR observes one plugin change. */
function artifactRevision(bundle: Buffer, sourceMap: WebPluginRecord['sourceMap']): string {
  return framedHash('plugin-artifact', sourceMap === undefined ? [bundle] : [bundle, sourceMap.body])
}

/** Address one ordered plugin-file list through the shared combo route. */
function comboUrl(ids: readonly string[], rev: string, sourceMap = false): string {
  const resources = ids.map(id => `${id}/client.js${sourceMap ? '.map' : ''}`).join(',')
  return `/plugins/??${resources}&rev=${rev}`
}

/** Measure the longer map-form URL used to partition a startup resource list. */
function projectedComboUrlBytes(records: readonly WebPluginRecord[]): number {
  return Buffer.byteLength(comboUrl(
    records.map(record => record.entry.id),
    COMBO_REVISION_PLACEHOLDER,
    true,
  ))
}

/** Partition one phase in graph order without allowing a generated URL above the protocol limit. */
function partitionComboRecords(records: readonly WebPluginRecord[]): WebPluginRecord[][] {
  const chunks: WebPluginRecord[][] = []
  let current: WebPluginRecord[] = []
  for (const record of records) {
    const candidate = [...current, record]
    if (projectedComboUrlBytes(candidate) <= MAX_COMBO_URL_BYTES) {
      current = candidate
      continue
    }
    if (current.length === 0) {
      throw new Error(
        `client-modules: ${record.entry.id} exceeds the ${String(MAX_COMBO_URL_BYTES)}-byte combo URL limit`,
      )
    }
    chunks.push(current)
    current = [record]
    if (projectedComboUrlBytes(current) > MAX_COMBO_URL_BYTES) {
      throw new Error(
        `client-modules: ${record.entry.id} exceeds the ${String(MAX_COMBO_URL_BYTES)}-byte combo URL limit`,
      )
    }
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** Executable source plus the generated-file name used when no authored map exists. */
interface ComboSource {
  source: string
  fallbackSource: string
}

/** Remove bundle-local debug directives and retain their stable generated-file name. */
function comboSource(record: WebPluginRecord): ComboSource {
  let source = record.bundle.toString('utf8')
  const sourceUrl = SOURCE_URL_TRAILER.exec(source)?.[1]
  source = source.replace(SOURCE_URL_TRAILER, '').replace(SOURCE_MAP_TRAILER, '')
  if (!source.endsWith('\n')) source += '\n'
  const fallbackSource = sourceUrl === undefined
    ? `/plugins/${record.entry.id}/client.js`
    : /^(?:[A-Za-z][A-Za-z\d+.-]*:|\/)/.test(sourceUrl) ? sourceUrl : `/${sourceUrl}`
  return { source, fallbackSource }
}

/** Stamp a combo script's absolute indexed-map URL onto its executable bytes. */
function comboScript(input: string, sourceMapUrl?: string): Buffer {
  return Buffer.from(sourceMapUrl === undefined ? input : `${input}//# sourceMappingURL=${sourceMapUrl}\n`)
}

/** Parse an optional source-map artifact; missing maps do not prevent plugin execution. */
function sourceMapSnapshot(clientPath: string): WebPluginRecord['sourceMap'] {
  let body: Buffer
  try {
    body = readFileSync(`${clientPath}.map`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const value = JSON.parse(body.toString('utf8')) as unknown
  const parsed = typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
  if (
    parsed === undefined
    || parsed.version !== 3
    || !Array.isArray(parsed.sources)
    || parsed.sources.some(source => typeof source !== 'string')
    || !Array.isArray(parsed.names)
    || parsed.names.some(name => typeof name !== 'string')
    || typeof parsed.mappings !== 'string'
  ) {
    throw new Error(`client-modules: ${clientPath}.map is not a regular Source Map v3 object`)
  }
  return { body, parsed }
}

/** Count generated lines while assembling indexed-map section offsets. */
function newlineCount(value: string): number {
  let count = 0
  for (const char of value) if (char === '\n') count += 1
  return count
}

/** Resolve section sources against their original per-plugin map URL before combo relocation. */
function comboSectionMap(record: WebPluginRecord): Record<string, unknown> {
  const original = record.sourceMap?.parsed
  /* v8 ignore next -- callers add sections only for records with a source map. */
  if (original === undefined) throw new Error(`client-modules: source map missing for ${record.entry.id}`)
  const sourcePaths = original.sources as string[]
  const sourceRoot = typeof original.sourceRoot === 'string' ? original.sourceRoot : ''
  const base = new URL(`/plugins/${record.entry.id}/client.js.map`, 'http://dsh.invalid')
  const relocated = sourcePaths.map((source) => {
    const separator = sourceRoot !== '' && !sourceRoot.endsWith('/') && !source.startsWith('/') ? '/' : ''
    const resolved = new URL(`${sourceRoot}${separator}${source}`, base)
    return resolved.origin === base.origin
      ? `${resolved.pathname}${resolved.search}${resolved.hash}`
      : resolved.href
  })
  const section: Record<string, unknown> = { ...original, sources: relocated }
  delete section.sourceRoot
  return section
}

/** Map each generated line to the same line in a bundled JavaScript source. */
function identitySectionMap(source: string, sourceUrl: string): Record<string, unknown> {
  const mappings = Array.from({ length: newlineCount(source) }, (_, index) => index === 0 ? 'AAAA' : 'AACA')
    .join(';')
  return {
    version: 3,
    names: [],
    sources: [sourceUrl],
    sourcesContent: [source],
    mappings,
  }
}

/** Concatenate one or more factory registrations and compose their maps as indexed sections. */
function buildCombo(records: readonly WebPluginRecord[], revision?: string): ComboArtifact {
  let source = ''
  const sections: { offset: { line: number; column: 0 }; map: Record<string, unknown> }[] = []
  let line = 0
  for (const record of records) {
    const prepared = comboSource(record)
    const section = record.sourceMap === undefined
      ? identitySectionMap(prepared.source, prepared.fallbackSource)
      : comboSectionMap(record)
    sections.push({ offset: { line, column: 0 }, map: section })
    const bundle = `${prepared.source};\n`
    source += bundle
    line += newlineCount(bundle)
  }
  const sourceMap = Buffer.from(`${JSON.stringify({ version: 3, file: 'client.js', sections })}\n`)
  const sourceBytes = Buffer.from(source)
  const rev = revision ?? framedHash('combo', [sourceBytes, sourceMap])
  const entries = records.map(record => record.entry.id)
  const url = comboUrl(entries, rev)
  const sourceMapUrl = comboUrl(entries, rev, true)
  return { url, rev, entries, script: comboScript(source, sourceMapUrl), sourceMap, sourceMapUrl }
}

/** Add initial-load scheduling metadata to a combo artifact. */
function buildBatch(phase: WebBootBatchPhase, records: readonly WebPluginRecord[]): BatchArtifact {
  const artifact = buildCombo(records)
  return {
    ...artifact,
    descriptor: { phase, url: artifact.url, rev: artifact.rev, entries: artifact.entries },
  }
}

/** Graph row for one bundle rev (url carries the rev as its cache-busting query). */
function graphRow(id: string, rev: string, fields: WebBootRowFields): WebBootEntry {
  return {
    id,
    url: comboUrl([id], rev),
    rev,
    ...(fields.inject !== undefined ? { inject: fields.inject } : {}),
    ...(fields.immediately ? { immediately: true } : {}),
    ...(fields.external.length > 0 ? { external: fields.external } : {}),
  }
}

/**
 * Order composed rows so every requested dynamic package precedes its
 * consumers. An `external` specifier is either the package row it names
 * (`<pkg>/client` aliases the bare package) or a static-table name that adds no
 * graph edge.
 * @param entries - composed rows in scan order.
 * @returns the same rows reordered; scan order breaks every tie.
 * @throws {Error} when a row requests itself or when the module graph has a
 * cycle; the message lists the packages on it.
 */
export function orderByModuleGraph(entries: readonly WebBootEntry[]): WebBootEntry[] {
  const rowsById = new Map<string, WebBootEntry>()
  for (const entry of entries) rowsById.set(entry.id, entry)
  const ordered: WebBootEntry[] = []
  const placed = new Set<string>()
  const open: string[] = []
  const visit = (entry: WebBootEntry): void => {
    if (placed.has(entry.id)) return
    const cycleStart = open.indexOf(entry.id)
    if (cycleStart !== -1) {
      throw new Error(
        `client-modules: module graph cycle ${[...open.slice(cycleStart), entry.id].join(' -> ')} `
        + '— a requested package row must precede its consumers, and factory-form CJS cannot deliver partial exports',
      )
    }
    open.push(entry.id)
    for (const name of entry.external ?? []) {
      const dependency = rowsById.get(name) ?? rowsById.get(stripClientSuffix(name))
      if (dependency === entry) {
        throw new Error(
          `client-modules: "${entry.id}" requests module "${name}" that it answers itself `
          + '— a row must not declare its own package in dsh.client.external',
        )
      }
      if (dependency !== undefined) visit(dependency)
    }
    open.pop()
    placed.add(entry.id)
    ordered.push(entry)
  }
  for (const entry of entries) visit(entry)
  return ordered
}

/** Bootstrap package whose ordinary client bundle supplies the module-system implementation. */
const CLIENT_MODULES_ID = '@deepseek-ai/dsh-client-modules'

/** Dynamic bundles grouped into the parser bootstrap batch before the Vite shell. */
const PARSER_PRELOAD_IDS = [CLIENT_MODULES_ID] as const

/**
 * The boot protocol as index injection rows. The inline registration queue
 * precedes the application-batch preload and the blocking bootstrap batch. Its
 * `create()` method materializes the modules
 * bundle, delegates construction to that bundle, and leaves the same facade
 * in live-registration mode. The graph global follows before the shell reads
 * it.
 * @param graph - the composed entry graph.
 * @returns head rows in execution order: queue script, application preloads,
 * blocking bootstrap scripts, graph global.
 */
export function bootInjections(graph: WebBootGraph): IndexInjection[] {
  const bootstrapId = JSON.stringify(CLIENT_MODULES_ID)
  const queue = `(()=>{
const pendingQueue=[]
window.__ModuleLoader__={
  mode:"queue",
  pendingQueue,
  load(registration){pendingQueue.push(registration)},
  create(options){
    if(this.mode!=="queue")throw new Error("client-modules: window.__ModuleLoader__.create called after module-system boot")
    const index=pendingQueue.findIndex(registration=>registration.id===${bootstrapId})
    const registration=pendingQueue[index]
    if(registration===undefined)throw new Error("client-modules: HTML did not preload ${CLIENT_MODULES_ID}/client.js")
    pendingQueue.splice(index,1)
    const exports=registration.factory(specifier=>{
      throw new Error('client-modules: ${CLIENT_MODULES_ID}/client.js requested external "'+specifier+'" before the module system existed')
    })
    if(typeof exports!=="object"||exports===null||typeof exports.createClientModuleSystem!=="function"||typeof exports.apply!=="function"){
      throw new Error("client-modules: ${CLIENT_MODULES_ID}/client.js did not export the bootstrap module face")
    }
    return exports.createClientModuleSystem(this,{id:registration.id,exports},options)
  }
}
})()`
  const bootstrap = graph.batches.filter(batch => batch.phase === 'bootstrap')
  const application = graph.batches.filter(batch => batch.phase === 'application')
  const rows: IndexInjection[] = [{ kind: 'script', placement: 'head', text: queue }]
  for (const batch of application) {
    rows.push({ kind: 'script-preload', src: batch.url })
  }
  for (const batch of bootstrap) {
    rows.push({ kind: 'script-src', placement: 'head', src: batch.url })
  }
  rows.push({ kind: 'global', name: '__DSH_BOOT__', value: graph })
  return rows
}

/**
 * The web plugin table service: incremental `dsh.client` scan + wire composition
 * + bundle route + index injection rows. Construction runs the activation scan
 * synchronously — a malformed declaration or missing bundle among the
 * already-loaded entries aggregates into one loud throw (FAILED fiber; the
 * boot activation audit reports it).
 */
export class ClientModuleRegistry extends Service {
  static inject = ['loader']

  private readonly table = new Map<string, WebPluginRecord>()
  private readonly sources = new Map<string, ClientPackageSource>()
  // Resolution is entry-local: the same specifier can resolve differently in
  // separate config trees. Negative verdicts remain stable until restart.
  private readonly pkgMeta = new Map<string, ResolvedPkgMeta | null>()
  private readonly rebuildListeners = new Set<(id: string, rev: string) => void>()
  private readonly graphListeners = new Set<() => void>()
  private readonly dirty = new Set<string>()
  private readonly initialRevisionNonce = randomBytes(8).toString('hex')
  private nextInitialRevision = 0
  private responses = new Map<string, { body: Buffer; contentType: string }>()
  private batchResponses = new Map<string, { body: Buffer; contentType: string }>()
  /** One prior graph generation covers a request racing the HMR recomposition that replaced its URL. */
  private previousBatchResponses = new Map<string, { body: Buffer; contentType: string }>()
  private flushQueued = false
  private composed: WebBootGraph

  /**
   * Build the service: subscribe, seed, and run the activation flush.
   * @param ctx - plugin context carrying Loader and an optional Web carrier.
   */
  constructor(ctx: Context) {
    super(ctx, 'clientModules')
    // Subscribe before seeding so a fiber arriving mid-activation lands in the
    // same dirty set (Set idempotence makes the overlap harmless). An entry-less
    // fiber is a child plugin or a manual mount — never a loader row; O(1) drop.
    ctx.on('internal/plugin', (fiber) => {
      const entryName = fiber.entry?.options.name
      if (entryName === undefined) return
      this.dirty.add(entryName)
      if (this.flushQueued) return
      this.flushQueued = true
      queueMicrotask(() => {
        this.flushQueued = false
        this.flush((err) => { ctx.logger.warn(err) })
      })
    })

    // Activation pass: the initial scan IS the incremental path over the
    // current entries, flushed synchronously (nothing async between subscribe,
    // seed, and flush).
    for (const entry of ctx.loader.entries()) this.dirty.add(entry.options.name)
    this.composed = this.compose()
    const failures: Error[] = []
    this.flush(err => failures.push(err))
    if (failures.length > 0) {
      throw new ClientPackageCompositionError(failures)
    }

    const registerWebCarrier = (webCtx: Context): void => {
      webCtx.effect(
        () => webCtx.webServer.register({ kind: 'prefix', path: '/plugins', handler: this.serveBundle }),
        'client-modules: bundle route',
      )
    }
    if (ctx.get('webServer') === undefined) ctx.inject(['webServer'], registerWebCarrier)
    else registerWebCarrier(ctx)
    ctx.on('webserver/index-inject', (table) => {
      table.push(...bootInjections(this.composed))
    })
  }

  /**
   * Current composed entry graph (stable object between changes).
   * @returns the graph served as `window.__DSH_BOOT__`.
   */
  graph(): WebBootGraph {
    return this.composed
  }

  /**
   * Absolute path of an entry's client bundle.
   * @param id - entry id (package name).
   * @returns the path, or undefined for an unknown id.
   */
  clientPath(id: string): string | undefined {
    return this.table.get(id)?.meta.clientPath
  }

  /**
   * Serve an advertised revisioned bundle or source map without a Web server.
   * Unknown URLs return 404, unsupported methods return 405, and `HEAD`
   * returns the same immutable headers without a body.
   * @param request - shell-carrier request for a `/plugins` resource.
   * @returns the exact response also exposed by the optional Web route.
   */
  fetchBundle(request: Request): Response {
    const resource = this.bundleResource(request.method, request.url)
    const body = resource.body === undefined ? null : Uint8Array.from(resource.body)
    return new Response(body, {
      status: resource.status,
      ...(resource.headers === undefined ? {} : { headers: resource.headers }),
    })
  }

  /**
   * Filesystem baseline captured before an entry's current bytes were read.
   * HMR compares it with the live files when installing a watch, so a write
   * between startup composition and watch installation cannot disappear into
   * the watcher's initial state.
   * @param id - entry id (package name).
   * @returns the path and baseline, or undefined for an unknown id.
   */
  artifactBaseline(id: string): ClientArtifactBaseline | undefined {
    const baseline = this.table.get(id)?.baseline
    return baseline === undefined ? undefined : { ...baseline }
  }

  /**
   * Re-hash one bundle (the HMR watch's registration hook — the only entry
   * point through which bundle content changes reach the graph).
   * @param id - entry id (package name).
   * @returns the new rev, or undefined for an unknown id.
   */
  rebuilt(id: string): string | undefined {
    const record = this.table.get(id)
    if (record === undefined) return undefined
    const baseline = this.captureArtifactBaseline(record.meta.clientPath)
    const bundle = readFileSync(record.meta.clientPath)
    const sourceMap = this.readSourceMapSnapshot(record.meta.clientPath)
    const rev = artifactRevision(bundle, sourceMap)
    record.baseline = baseline
    if (rev === record.entry.rev) return rev
    record.entry = graphRow(id, rev, record.meta)
    record.bundle = bundle
    if (sourceMap === undefined) delete record.sourceMap
    else record.sourceMap = sourceMap
    this.composed = this.compose()
    for (const notify of this.rebuildListeners) {
      // Containment: rebuilt() runs inside the HMR watch callback — a
      // throwing subscriber must not kill the poll or skip later subscribers.
      try {
        notify(id, rev)
      } catch (error) {
        this.ctx.logger.error(error)
      }
    }
    this.notifyGraphChanged()
    return rev
  }

  /**
   * Subscribe to bundle rebuilds; fires only when the re-hash changed the rev.
   * @param listener - receives the entry id and its new bundle rev.
   * @returns the unsubscriber.
   */
  onRebuilt(listener: (id: string, rev: string) => void): () => void {
    this.rebuildListeners.add(listener)
    return () => { this.rebuildListeners.delete(listener) }
  }

  /**
   * Fires after any flush that recomposed the graph (row added/removed, or a
   * rebuilt rev change). Pull model: listeners re-read {@link graph}.
   * @param listener - notified with no payload.
   * @returns the unsubscriber.
   */
  onGraphChanged(listener: () => void): () => void {
    this.graphListeners.add(listener)
    return () => { this.graphListeners.delete(listener) }
  }

  private compose(): WebBootGraph {
    const entries = orderByModuleGraph([...this.table.values()].map(record => record.entry))
    const bootstrap = PARSER_PRELOAD_IDS
      .map(id => this.table.get(id))
      .filter((record): record is WebPluginRecord => record !== undefined)
    const bootstrapIds = new Set(bootstrap.map(record => record.entry.id))
    const application = entries
      .filter(entry => !bootstrapIds.has(entry.id))
      .map(entry => this.table.get(entry.id))
      .filter((record): record is WebPluginRecord => record !== undefined)
    const artifacts: BatchArtifact[] = []
    for (const records of partitionComboRecords(bootstrap)) {
      artifacts.push(buildBatch('bootstrap', records))
    }
    for (const records of partitionComboRecords(application)) {
      artifacts.push(buildBatch('application', records))
    }

    const batchResponses = new Map<string, { body: Buffer; contentType: string }>()
    for (const artifact of artifacts) {
      batchResponses.set(artifact.descriptor.url, {
        body: artifact.script,
        contentType: 'text/javascript; charset=utf-8',
      })
      batchResponses.set(artifact.sourceMapUrl, {
        body: artifact.sourceMap,
        contentType: 'application/json; charset=utf-8',
      })
    }
    const responses = new Map(batchResponses)
    for (const record of this.table.values()) {
      const artifact = buildCombo([record], record.entry.rev)
      responses.set(artifact.url, {
        body: artifact.script,
        contentType: 'text/javascript; charset=utf-8',
      })
      responses.set(artifact.sourceMapUrl, {
        body: artifact.sourceMap,
        contentType: 'application/json; charset=utf-8',
      })
    }
    this.previousBatchResponses = this.batchResponses
    this.batchResponses = batchResponses
    this.responses = responses
    const batches = artifacts.map(artifact => artifact.descriptor)
    return { rev: shortHash(JSON.stringify({ entries, batches })), entries, batches }
  }

  private notifyGraphChanged(): void {
    for (const listener of this.graphListeners) {
      // A throwing subscriber must not skip later subscribers (or escape into
      // whatever triggered the flush — possibly an fs.watchFile callback).
      try {
        listener()
      } catch (error) {
        this.ctx.logger.error(error)
      }
    }
  }

  private resolveMeta(loaderName: string, baseUrl: string): ResolvedPkgMeta | null {
    const sourceKey = this.sourceKey(loaderName, baseUrl)
    const cached = this.pkgMeta.get(sourceKey)
    if (cached !== undefined) return cached
    const located = this.locatePkgJson(loaderName, baseUrl)
    if (located === undefined) {
      // Not a resolvable package root: loader builtins (cordis:include) and
      // subpath entries (…/gateway) land here — permanently not a client row.
      this.pkgMeta.set(sourceKey, null)
      return null
    }
    const { packageName, path: pkgPath } = located
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
    const dsh = pkg.dsh
    const decl = parseDshClient(
      packageName,
      dsh !== null && typeof dsh === 'object' ? (dsh as Record<string, unknown>).client : undefined,
    )
    if (decl === undefined || decl.platform !== 'web') {
      this.pkgMeta.set(sourceKey, null)
      return null
    }
    const clientRel = clientExportOf(packageName, pkg.exports)
    if (clientRel === undefined) {
      throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`)
    }
    const meta: PkgMeta = {
      clientPath: join(dirname(pkgPath), clientRel),
      ...(decl.inject !== undefined ? { inject: decl.inject } : {}),
      external: decl.external ?? [],
      immediately: decl.immediately === true,
    }
    const resolved = { packageName, meta }
    this.pkgMeta.set(sourceKey, resolved)
    return resolved
  }

  /**
   * Locate the manifest of the package the Loader mounts for a row. The row's
   * module location is authoritative: the specifier resolves through the same
   * Loader resolution that imported the row's host half — including any
   * active ESM hooks — and the nearest ancestor manifest declaring the name
   * owns the module. Tree-anchored `require` resolution remains only for
   * runtimes without Node internals.
   * @param loaderName - module specifier of the loader row.
   * @param baseUrl - resolution base of the tree that owns the row.
   * @returns the manifest path, or `undefined` when the name resolves to no package root.
   */
  private locatePkgJson(loaderName: string, baseUrl: string): { path: string; packageName: string } | undefined {
    if (loaderName.startsWith('cordis:')) return undefined
    const pathLike = loaderName.startsWith('.') || loaderName.startsWith('file:') || isAbsolute(loaderName)
    const expectedPackageName = pathLike ? undefined : exactPackageSpecifier(loaderName)
    if (!pathLike && expectedPackageName === undefined) return undefined
    const internal = this.ctx.loader.internal
    if (internal === undefined || typeof Reflect.get(internal, 'resolveSync') !== 'function') {
      if (expectedPackageName === undefined) {
        const moduleUrl = loaderName.startsWith('file:')
          ? loaderName
          : isAbsolute(loaderName) ? pathToFileURL(loaderName).href : new URL(loaderName, baseUrl).href
        return this.nearestPackage(moduleUrl)
      }
      try {
        return {
          path: createRequire(baseUrl).resolve(`${expectedPackageName}/package.json`),
          packageName: expectedPackageName,
        }
      } catch {
        // Without Node internals the owning tree is the only resolver; an
        // unresolvable name is classified exactly as below.
        return undefined
      }
    }
    let moduleUrl: string
    try {
      moduleUrl = internal.version === 'v2'
        ? internal.resolveSync(baseUrl, { specifier: loaderName, attributes: {} }).url
        : internal.resolveSync(loaderName, baseUrl, {}).url
    } catch {
      // The Loader cannot resolve the name: its row cannot have imported, so
      // the name is permanently not a client row.
      return undefined
    }
    return this.nearestPackage(moduleUrl, expectedPackageName)
  }

  private nearestPackage(
    moduleUrl: string,
    expectedPackageName?: string,
  ): { path: string; packageName: string } | undefined {
    if (!moduleUrl.startsWith('file:')) return undefined
    let dir = dirname(fileURLToPath(moduleUrl))
    while (true) {
      const candidate = join(dir, 'package.json')
      if (existsSync(candidate)) {
        try {
          const name = (JSON.parse(readFileSync(candidate, 'utf8')) as { name?: unknown }).name
          if (typeof name === 'string' && (expectedPackageName === undefined || name === expectedPackageName)) {
            return { path: candidate, packageName: name }
          }
        } catch {
          // An unreadable or malformed intermediate manifest cannot own the
          // module; keep walking toward the declaring package root.
        }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return undefined
  }

  private sourceKey(loaderName: string, baseUrl: string): string {
    return `${baseUrl}\0${loaderName}`
  }

  /** Capture the bundle stats before reading its bytes. */
  private captureArtifactBaseline(clientPath: string): ClientArtifactBaseline {
    const bundle = statSync(clientPath)
    return {
      path: clientPath,
      mtimeMs: bundle.mtimeMs,
      size: bundle.size,
    }
  }

  /** Allocate an opaque initial row revision without inspecting artifact bytes. */
  private allocateInitialRevision(): string {
    return `${this.initialRevisionNonce}-${String(this.nextInitialRevision++)}`
  }

  /**
   * Read the activation-time bundle and optional source-map snapshots.
   * @param pkgName - package that declares the client bundle.
   * @param clientPath - absolute path of the built client artifact.
   * @returns the immutable bytes plus the pre-read filesystem baseline.
   * @throws {MissingClientBundleError} when the read fails with `ENOENT`; other filesystem errors are rethrown unchanged.
   */
  private initialBundleSnapshot(pkgName: string, clientPath: string): {
    bundle: Buffer
    baseline: ClientArtifactBaseline
    sourceMap?: WebPluginRecord['sourceMap']
  } {
    try {
      const baseline = this.captureArtifactBaseline(clientPath)
      const bundle = readFileSync(clientPath)
      const sourceMap = this.readSourceMapSnapshot(clientPath)
      return { bundle, baseline, ...(sourceMap === undefined ? {} : { sourceMap }) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      throw new MissingClientBundleError(pkgName, clientPath, error)
    }
  }

  /** Treat a missing, torn, or malformed development map as an identity-mapped artifact revision. */
  private readSourceMapSnapshot(clientPath: string): WebPluginRecord['sourceMap'] {
    try {
      return sourceMapSnapshot(clientPath)
    } catch (error) {
      this.ctx.logger.warn(error)
      return undefined
    }
  }

  /** Reconcile one entry name against the live Loader sources. @returns whether the table changed. */
  private processOne(entryName: string, onError: (err: Error) => void): boolean {
    const nextSources = new Map<string, ClientPackageSource>()
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.name !== entryName || entry.fiber === undefined || entry.disabled) continue
      const source = this.resolveSource(entry)
      if (source !== undefined) nextSources.set(source.sourceKey, source)
    }

    const affectedPackages = new Set<string>()
    for (const [sourceKey, source] of this.sources) {
      if (source.loaderName !== entryName) continue
      affectedPackages.add(source.packageName)
      if (!nextSources.has(sourceKey)) this.sources.delete(sourceKey)
    }
    for (const [sourceKey, source] of nextSources) {
      affectedPackages.add(source.packageName)
      this.sources.set(sourceKey, source)
    }
    let changed = false
    for (const packageName of affectedPackages) {
      try {
        if (this.reconcilePackage(packageName)) changed = true
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)))
      }
    }
    return changed
  }

  private resolveSource(entry: Entry): ClientPackageSource | undefined {
    const loaderName = entry.options.name
    const baseUrl = entry.parent.tree.ctx.baseUrl
    if (baseUrl === undefined) {
      throw new Error(`client-modules: loader entry ${loaderName} has no resolution base URL`)
    }
    const resolved = this.resolveMeta(loaderName, baseUrl)
    if (resolved === null) return undefined
    return { ...resolved, loaderName, baseUrl, sourceKey: this.sourceKey(loaderName, baseUrl) }
  }

  private reconcilePackage(packageName: string): boolean {
    const sources: ClientPackageSource[] = []
    for (const source of this.sources.values()) {
      if (source.packageName === packageName) sources.push(source)
    }
    if (sources.length > 1) {
      const locations = sources
        .map(source => `${JSON.stringify(source.loaderName)} from ${source.baseUrl}`)
        .join(', ')
      throw new Error(
        `client-modules: package ${packageName} resolves from multiple active Loader sources: ${locations}; remove one entry`,
      )
    }
    const source = sources[0]
    if (source === undefined) return this.table.delete(packageName)
    if (this.table.get(packageName)?.sourceKey === source.sourceKey) return false
    // The opaque initial rev rides the row until HMR observes a file change;
    // a fiber restart from the same source reuses the existing row.
    const snapshot = this.initialBundleSnapshot(packageName, source.meta.clientPath)
    const rev = this.allocateInitialRevision()
    this.table.set(packageName, {
      entry: graphRow(packageName, rev, source.meta),
      loaderName: source.loaderName,
      sourceKey: source.sourceKey,
      meta: source.meta,
      bundle: snapshot.bundle,
      baseline: snapshot.baseline,
      ...(snapshot.sourceMap === undefined ? {} : { sourceMap: snapshot.sourceMap }),
    })
    return true
  }

  private flush(onError: (err: Error) => void): void {
    let changed = false
    for (const entryName of [...this.dirty]) {
      this.dirty.delete(entryName)
      try {
        if (this.processOne(entryName, onError)) changed = true
      } catch (error) {
        // Steady state: one broken package must not poison the others; the
        // activation pass aggregates these into a loud throw instead.
        onError(error instanceof Error ? error : new Error(String(error)))
      }
    }
    if (!changed) return
    let composed: WebBootGraph
    try {
      composed = this.compose()
    } catch (error) {
      // An unorderable module graph is a property of the whole table, not of
      // the arriving package, so it surfaces here: aggregated into the
      // activation throw, or warned in steady state while the last orderable
      // graph stays served.
      onError(error as Error)
      return
    }
    this.composed = composed
    this.notifyGraphChanged()
  }

  private bundleResource(method: string | undefined, url: string): {
    status: number
    headers?: Record<string, string>
    body?: Buffer
  } {
    if (method !== 'GET' && method !== 'HEAD') return { status: 405 }
    const requestUrl = new URL(url, 'http://x')
    const resourceUrl = `${requestUrl.pathname}${requestUrl.search}`
    const response = this.responses.get(resourceUrl) ?? this.previousBatchResponses.get(resourceUrl)
    if (response !== undefined) {
      return {
        status: 200,
        headers: { 'content-type': response.contentType, 'cache-control': IMMUTABLE_CACHE },
        ...(method === 'HEAD' ? {} : { body: response.body }),
      }
    }
    // Anything else under /plugins (including unadvertised combinations and
    // /plugins/events when the HMR row is absent) is an unknown resource.
    return { status: 404 }
  }

  private readonly serveBundle = (req: IncomingMessage, res: ServerResponse): void => {
    /* v8 ignore next -- `?? '/'` arm: node:http always sets url on server requests. */
    const response = this.bundleResource(req.method, req.url ?? '/')
    res.writeHead(response.status, response.headers)
    res.end(response.body)
  }
}

export default ClientModuleRegistry
