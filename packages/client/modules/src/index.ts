/**
 * Node half of the client module system (`dsh.client` dual-face package): scans
 * the host Loader's entries for packages declaring `dsh.client`, composes the
 * `window.__DSH_BOOT__` entry graph (wire single source: {@link WebBootEntry}
 * in `./client/manifest.ts`) in module-graph order, serves one-or-more-plugin
 * combo scripts plus their source maps, package-local chunks, and the
 * content-revisioned `./assets/*` exports of active client packages,
 * contributes the registration facade, application preloads, bootstrap scripts,
 * and graph to the webserver's index injection table, and provides the
 * `clientModules` service (the HMR node half's registration/notification
 * face).
 *
 * Package reconciliation is incremental by Loader entry name.
 * Every cordis `internal/plugin` emission (fiber construction/disposal) marks
 * the fiber's entry name dirty; a microtask flush reconciles each dirty name
 * against the Loader entries indexed at the start of that flush. Synchronous
 * package resolution must not add or remove Loader entries during reconciliation.
 * The activation pass seeds the same pending names and flushes synchronously,
 * so initial activation and steady state share one implementation. Each
 * reconciliation reads the package manifest and the bundle metadata again,
 * so an entry that restarts after its package was reinstalled or moved
 * publishes them as they are now; an unchanged result publishes nothing and
 * does not read the bundle. The manifest package name identifies the browser
 * module; distinct active Loader sources for that package are a composition
 * error. Bundle rebuilds outside
 * an entry restart reach the graph through {@link ClientModuleRegistry.rebuilt}.
 * @module @deepseek-ai/dsh-client-modules
 */

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { PACKAGE_ASSET_SEGMENT, packageAssetMediaType } from './assets.ts'
import { exactPackageSpecifier, parseDshClient, stripClientSuffix } from './client/manifest.ts'
import type { WebBootBatch, WebBootBatchPhase, WebBootEntry, WebBootGraph, WebBootRelease } from './client/manifest.ts'

export { stripClientSuffix } from './client/manifest.ts'
export type {
  BootManifest, BootModuleRow, BootPluginRow, WebBootBatch, WebBootBatchPhase, WebBootEntry, WebBootGraph, WebBootRelease,
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
  /** Bundle status-change time in milliseconds, including writes that preserve mtime. */
  readonly ctimeMs: number
  /** Bundle size in bytes. */
  readonly size: number
}

/** Package metadata read from the manifest of one active Loader source. */
interface PkgMeta extends WebBootRowFields {
  clientPath: string
  /** The package's own manifest; package-asset requests resolve against it as a self-reference. */
  manifestPath: string
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
  /** Stable source identity and contribution key. */
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
}

/** Immutable inputs captured for one resource in a generated combo. */
interface ComboResource {
  id: string
  rev: string
  clientPath: string
  fileName: string
  bundle: Buffer
}

/** One lazily materialized immutable response body. */
interface LazyResponse {
  contentType: string
  body: () => Promise<Buffer>
}

/** Fields shared by every generated combo plan. */
interface ComboArtifact {
  /** Absolute route URL of this response. */
  url: string
  rev: string
  entries: string[]
  /** Absolute route URL of the map response. */
  sourceMapUrl: string
  scriptBody: () => Promise<Buffer>
  sourceMapBody: () => Promise<Buffer>
}

/**
 * One generated initial-load response and its wire descriptor. The descriptor
 * travels to the browser, so its URL is the document-relative reference while
 * {@link ComboArtifact.url} is the route key.
 */
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
/** Published package-local client chunk names accepted by the on-demand route. */
const CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/

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

/** sha1 metadata hash shortened to 12 hex chars. */
function shortHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, HASH_REVISION_LENGTH)
}

/** Hash several response fields without allowing bytes to move across field boundaries. */
function framedHash(domain: string, parts: readonly string[]): string {
  const hash = createHash('sha1').update(domain).update('\0')
  for (const part of parts) hash.update(`${String(Buffer.byteLength(part))}:`).update(part)
  return hash.digest('hex').slice(0, HASH_REVISION_LENGTH)
}

/** Identify an entry's build from filesystem metadata without hashing its contents. */
function artifactRevision(baseline: ClientArtifactBaseline): string {
  return framedHash('plugin-artifact', [String(baseline.mtimeMs), String(baseline.ctimeMs), String(baseline.size)])
}

/** Absolute route prefix serving every plugin resource. */
const PLUGIN_ROUTE = '/plugins'

/**
 * `/plugins/<package>/assets/<path>`. A scoped package name spans two segments
 * (`@scope/name`); an unscoped name never starts with `@`, so `@scope/assets/…`
 * stays a chunk request of the package `@scope/assets`.
 */
const PACKAGE_ASSET_PATH = /^\/plugins\/(@[^/]+\/[^/]+|[^@/][^/]*)\/assets\/(.*)$/

/** Expose a Node read stream as a shell-carrier Response body; cancelling the body closes the stream. */
function transforStreamBody(stream: Readable): ReadableStream<Uint8Array> {
  const chunks: AsyncIterator<Uint8Array> = stream[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next()
      if (next.done === true) controller.close()
      else controller.enqueue(next.value)
    },
    async cancel() {
      await chunks.return?.()
    },
  })
}

/**
 * Expose a held bundle buffer as a Response body without copying it: the
 * single chunk is the buffer itself, which readers must not modify.
 */
function heldBody(buffer: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(buffer)
      controller.close()
    },
  })
}

/** Combo query addressing one ordered plugin-file list. */
function comboSearch(ids: readonly string[], rev: string, sourceMap = false): string {
  const resources = ids.map(id => `${id}/client.js${sourceMap ? '.map' : ''}`).join(',')
  return `??${resources}&rev=${rev}`
}

/** Absolute route URL for one combo resource. */
function comboUrl(ids: readonly string[], rev: string, sourceMap = false): string {
  return `${PLUGIN_ROUTE}/${comboSearch(ids, rev, sourceMap)}`
}

/**
 * Browser reference to one combo resource: app-owned browser routes are
 * document-relative, so the route key's leading slash is stripped here, at the
 * boundary between the two halves. The rule and its reasons are owned by
 * .agents/notes/implemented/architecture/2026-09-14-web-document-relative-app-routes.md.
 */
function comboReference(ids: readonly string[], rev: string, sourceMap = false): string {
  return comboUrl(ids, rev, sourceMap).slice(1)
}

/** Absolute route URL for one package-local chunk. */
function chunkUrl(id: string, fileName: string, rev: string, sourceMap = false): string {
  return `${PLUGIN_ROUTE}/${id}/${fileName}${sourceMap ? '.map' : ''}?rev=${rev}`
}

/**
 * Source-map reference stamped into one chunk script. A script's map reference
 * resolves against that script's own directory rather than the document, so
 * this is the bare map file name, not the document-relative route.
 */
function chunkMapReference(fileName: string, rev: string): string {
  return `${fileName}.map?rev=${rev}`
}

/** Measure the longest browser-facing combo URL used to partition a startup resource list. */
function projectedComboUrlBytes(records: readonly WebPluginRecord[]): number {
  return Buffer.byteLength(comboReference(
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
interface PreparedSource {
  source: string
  fallbackSource: string
}

/** Remove bundle-local debug directives and retain their stable generated-file name. */
function prepareSource(resource: ComboResource): PreparedSource {
  let source = resource.bundle.toString('utf8')
  const sourceUrl = SOURCE_URL_TRAILER.exec(source)?.[1]
  source = source.replace(SOURCE_URL_TRAILER, '').replace(SOURCE_MAP_TRAILER, '')
  if (!source.endsWith('\n')) source += '\n'
  const fallbackSource = sourceUrl === undefined
    ? `/plugins/${resource.id}/${resource.fileName}`
    : /^(?:[A-Za-z][A-Za-z\d+.-]*:|\/)/.test(sourceUrl) ? sourceUrl : `/${sourceUrl}`
  return { source, fallbackSource }
}

/** Stamp a combo script's source-map reference onto its executable bytes. */
function comboScript(input: string, sourceMapUrl?: string): Buffer {
  return Buffer.from(sourceMapUrl === undefined ? input : `${input}//# sourceMappingURL=${sourceMapUrl}\n`)
}

/** Read and parse an optional source map when its combo-map endpoint is requested. */
function readSourceMap(clientPath: string): Record<string, unknown> | undefined {
  let body: Buffer
  try {
    body = readFileSync(`${clientPath}.map`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const value: unknown = JSON.parse(body.toString('utf8'))
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
  return parsed
}

/** Count generated lines while assembling indexed-map section offsets. */
function newlineCount(value: string): number {
  let count = 0
  for (const char of value) if (char === '\n') count += 1
  return count
}

/** Resolve section sources against their original per-plugin map URL before combo relocation. */
function comboSectionMap(resource: ComboResource, original: Record<string, unknown>): Record<string, unknown> {
  const sourcePaths = original.sources as string[]
  const sourceRoot = typeof original.sourceRoot === 'string' ? original.sourceRoot : ''
  const base = new URL(`/plugins/${resource.id}/client.js.map`, 'http://dsh.invalid')
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

/**
 * Run one producer in the first requester's microtask, not off-thread, and share its settlement. A rejected run is
 * dropped once it settles, so the next request produces again.
 */
function lazyBody(produce: () => Buffer | Promise<Buffer>): () => Promise<Buffer> {
  let result: Promise<Buffer> | undefined
  return () => {
    result ??= Promise.resolve().then(produce).catch((error: unknown) => {
      result = undefined
      throw error
    })
    return result
  }
}

/** Derive one combo revision from the ordered immutable row revisions. */
function comboRevision(resources: readonly ComboResource[]): string {
  return framedHash('combo', resources.flatMap(resource => [
    resource.id,
    resource.rev,
  ]))
}

/** Concatenate one or more factory registrations without reading or composing source maps. */
function buildComboScript(resources: readonly ComboResource[], sourceMapUrl: string): Buffer {
  let source = ''
  for (const resource of resources) source += `${prepareSource(resource).source};\n`
  return comboScript(source, sourceMapUrl)
}

/** Compose one indexed map from source-map files read only for this request. */
function buildComboSourceMap(
  resources: readonly ComboResource[],
  sourceMapOf: (clientPath: string) => Record<string, unknown> | undefined,
  fileName = 'client.js',
): Buffer {
  const sections: { offset: { line: number; column: 0 }; map: Record<string, unknown> }[] = []
  let line = 0
  for (const resource of resources) {
    const prepared = prepareSource(resource)
    const sourceMap = sourceMapOf(resource.clientPath)
    let section = identitySectionMap(prepared.source, prepared.fallbackSource)
    if (sourceMap !== undefined) {
      try {
        section = comboSectionMap(resource, sourceMap)
      } catch {
        // An invalid authored source URL is a malformed map, so the generated
        // bundle remains debuggable through the same identity fallback.
      }
    }
    sections.push({ offset: { line, column: 0 }, map: section })
    line += newlineCount(`${prepared.source};\n`)
  }
  return Buffer.from(`${JSON.stringify({ version: 3, file: fileName, sections })}\n`)
}

/** Describe one combo and defer its executable and debug payloads independently. */
function buildCombo(
  records: readonly WebPluginRecord[],
  sourceMapOf: (clientPath: string) => Record<string, unknown> | undefined,
  revision?: string,
): ComboArtifact {
  const resources = records.map(record => ({
    id: record.entry.id,
    rev: record.entry.rev,
    clientPath: record.meta.clientPath,
    fileName: 'client.js',
    bundle: record.bundle,
  }))
  const rev = revision ?? comboRevision(resources)
  const entries = resources.map(resource => resource.id)
  const url = comboUrl(entries, rev)
  const sourceMapUrl = comboUrl(entries, rev, true)
  // Trailer only: it resolves against this script's own directory, not the document.
  return {
    url,
    rev,
    entries,
    sourceMapUrl,
    scriptBody: lazyBody(() => buildComboScript(resources, comboSearch(entries, rev, true))),
    sourceMapBody: lazyBody(() => buildComboSourceMap(resources, sourceMapOf)),
  }
}

/** Add initial-load scheduling metadata to a combo artifact. */
function buildBatch(
  phase: WebBootBatchPhase,
  records: readonly WebPluginRecord[],
  sourceMapOf: (clientPath: string) => Record<string, unknown> | undefined,
): BatchArtifact {
  const artifact = buildCombo(records, sourceMapOf)
  return {
    ...artifact,
    descriptor: {
      phase,
      url: artifact.url.slice(1),
      rev: artifact.rev,
      entries: artifact.entries,
    },
  }
}

/** Graph row for one bundle rev (the reference carries the rev as its cache-busting query). */
function graphRow(id: string, rev: string, fields: WebBootRowFields): WebBootEntry {
  return {
    id,
    url: comboReference([id], rev),
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
 * + bundle and package-asset route + index injection rows. Construction runs
 * the activation scan synchronously — a malformed declaration or missing bundle among the
 * already-loaded entries aggregates into one loud throw (FAILED fiber; the
 * boot activation audit reports it).
 */
export class ClientModuleRegistry extends Service {
  static inject = ['loader']

  /**
   * Host release identity published in every graph: this package's version, which releases share
   * with the CLI, and the source commit the client build fixes into the built Host artifact.
   */
  private readonly release: WebBootRelease
  private readonly table = new Map<string, WebPluginRecord>()
  private readonly sources = new Map<string, ClientPackageSource>()
  private readonly rebuildListeners = new Set<(id: string, rev: string) => void>()
  private readonly graphListeners = new Set<() => void>()
  private readonly dirty = new Set<string>()
  private responses = new Map<string, LazyResponse>()
  private batchResponses = new Map<string, LazyResponse>()
  /** One prior graph generation covers a request racing the HMR recomposition that replaced its URL. */
  private previousBatchResponses = new Map<string, LazyResponse>()
  private flushQueued = false
  private composed: WebBootGraph

  /**
   * Build the service: subscribe, seed, and run the activation flush.
   * Bundle routes follow the optional Web carrier's injected lifecycle.
   * @param ctx - plugin context carrying Loader and an optional Web carrier.
   */
  constructor(ctx: Context) {
    super(ctx, 'clientModules')
    const { version } = createRequire(import.meta.url)('../package.json') as { version: string }
    // The client build fixes this read into the built Host artifact.
    const commit = process.env.DSH_CLIENT_COMMIT_HASH
    this.release = commit === undefined ? { version } : { version, commit }
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
        () => webCtx.webServer.register({ kind: 'prefix', path: PLUGIN_ROUTE, resource: request => this.fetchBundle(request) }),
        'client-modules: bundle route',
      )
    }
    ctx.inject(['webServer'], registerWebCarrier)
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
   * Serve an advertised revisioned bundle, source map, chunk, or package asset
   * without a Web server. Unknown URLs return 404, unsupported methods return
   * 405, and `HEAD` returns the same immutable headers without materializing a
   * body. Each bundle body is built once on its first `GET`; script
   * construction never reads maps. A package asset is read on every request
   * and answers 304 without a body when `If-None-Match` equals its entity tag;
   * its body holds the file open until the caller consumes or cancels it. A
   * bundle, map, or chunk body is the held buffer itself, not a copy, so a
   * caller must not modify its bytes.
   * @param request - shell-carrier request for a `/plugins` resource.
   * @returns the exact response also exposed by the optional Web route.
   */
  async fetchBundle(request: Request): Promise<Response> {
    const resource = await this.bundleResource(request.method, request.url, request.headers.get('if-none-match') ?? undefined)
    const body = resource.body === undefined ? null
      : resource.body instanceof Readable ? transforStreamBody(resource.body) : heldBody(resource.body)
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
   * Publish one completed bundle generation (the HMR watch's registration
   * hook; an entry restart publishes through reconciliation instead).
   * Unchanged mtime, ctime and size preserve the graph without reading the bundle.
   * @param id - entry id (package name).
   * @returns the current artifact rev, or undefined for an unknown id.
   */
  rebuilt(id: string): string | undefined {
    const record = this.table.get(id)
    if (record === undefined) return undefined
    const baseline = this.captureArtifactBaseline(record.meta.clientPath)
    const rev = artifactRevision(baseline)
    if (rev === record.entry.rev) return rev
    const bundle = readFileSync(record.meta.clientPath)
    record.baseline = baseline
    record.entry = graphRow(id, rev, record.meta)
    record.bundle = bundle
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
   * Subscribe to bundle rebuilds; fires when {@link rebuilt} changes a rev. A rev an
   * entry restart publishes reaches only {@link onGraphChanged} listeners.
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
      artifacts.push(buildBatch('bootstrap', records, this.readSourceMap))
    }
    for (const records of partitionComboRecords(application)) {
      artifacts.push(buildBatch('application', records, this.readSourceMap))
    }

    const batchResponses = new Map<string, LazyResponse>()
    for (const artifact of artifacts) {
      // The table is keyed by the absolute route the request arrives on, not by
      // the document-relative reference the graph and descriptors carry.
      batchResponses.set(artifact.url, this.responses.get(artifact.url) ?? {
        body: artifact.scriptBody,
        contentType: 'text/javascript; charset=utf-8',
      })
      batchResponses.set(artifact.sourceMapUrl, this.responses.get(artifact.sourceMapUrl) ?? {
        body: artifact.sourceMapBody,
        contentType: 'application/json; charset=utf-8',
      })
    }
    const responses = new Map(batchResponses)
    for (const record of this.table.values()) {
      const artifact = buildCombo([record], this.readSourceMap, record.entry.rev)
      responses.set(artifact.url, responses.get(artifact.url) ?? this.responses.get(artifact.url) ?? {
        body: artifact.scriptBody,
        contentType: 'text/javascript; charset=utf-8',
      })
      responses.set(artifact.sourceMapUrl, responses.get(artifact.sourceMapUrl) ?? this.responses.get(artifact.sourceMapUrl) ?? {
        body: artifact.sourceMapBody,
        contentType: 'application/json; charset=utf-8',
      })
    }
    for (const [resourceUrl, response] of this.responses) {
      if (this.chunkRequest(new URL(resourceUrl, 'http://x')) !== undefined) responses.set(resourceUrl, response)
    }
    this.previousBatchResponses = this.batchResponses
    this.batchResponses = batchResponses
    this.responses = responses
    const batches = artifacts.map(artifact => artifact.descriptor)
    return {
      rev: shortHash(JSON.stringify({ entries, batches })),
      release: this.release,
      entries,
      batches,
    }
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
    const located = this.locatePkgJson(loaderName, baseUrl)
    if (located === undefined) {
      // Not a resolvable package root: loader builtins (cordis:include) and
      // subpath entries (…/gateway) land here — not a client row.
      return null
    }
    const { packageName, path: pkgPath } = located
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
    const dsh = pkg.dsh
    const decl = parseDshClient(
      packageName,
      dsh !== null && typeof dsh === 'object' ? (dsh as Record<string, unknown>).client : undefined,
    )
    if (decl === undefined || decl.platform !== 'web') return null
    const clientRel = clientExportOf(packageName, pkg.exports)
    if (clientRel === undefined) {
      throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`)
    }
    const meta: PkgMeta = {
      clientPath: join(dirname(pkgPath), clientRel),
      manifestPath: pkgPath,
      ...(decl.inject !== undefined ? { inject: decl.inject } : {}),
      external: decl.external ?? [],
      immediately: decl.immediately === true,
    }
    return { packageName, meta }
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
      // it is not a client row.
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
      ctimeMs: bundle.ctimeMs,
      size: bundle.size,
    }
  }

  /**
   * Run one filesystem read of a declared client bundle.
   * @param pkgName - package that declares the client bundle.
   * @param clientPath - absolute path of the built client artifact.
   * @param read - the stat or read of `clientPath`.
   * @returns the read's result.
   * @throws {MissingClientBundleError} when the read fails with `ENOENT`; other filesystem errors are rethrown unchanged.
   */
  private readClientBundle<T>(pkgName: string, clientPath: string, read: () => T): T {
    try {
      return read()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      throw new MissingClientBundleError(pkgName, clientPath, error)
    }
  }

  /** Treat a missing, torn, or malformed development map as an identity section. */
  private readonly readSourceMap = (clientPath: string): Record<string, unknown> | undefined => {
    try {
      return readSourceMap(clientPath)
    } catch (error) {
      this.ctx.logger.warn(error)
      return undefined
    }
  }

  /**
   * Reconcile one entry name against its sources at flush start.
   * @param entryName - Loader entry name being reconciled.
   * @param entries - same-name entries collected at flush start.
   * @param onError - receives package reconciliation failures.
   * @returns whether the table changed.
   */
  private processOne(entryName: string, entries: readonly Entry[], onError: (err: Error) => void): boolean {
    const nextSources = new Map<string, ClientPackageSource>()
    for (const entry of entries) {
      if (entry.fiber === undefined || entry.disabled) continue
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
    const { clientPath } = source.meta
    // Startup and HMR share revisions so unchanged artifacts survive a server restart.
    const baseline = this.readClientBundle(packageName, clientPath, () => this.captureArtifactBaseline(clientPath))
    const entry = graphRow(packageName, artifactRevision(baseline), source.meta)
    const current = this.table.get(packageName)
    // A restart that finds the same manifest and bundle metadata leaves the published graph as it is, unread.
    const unchanged = current?.sourceKey === source.sourceKey
      && isDeepStrictEqual(current.meta, source.meta) && isDeepStrictEqual(current.entry, entry)
    if (unchanged) return false
    this.table.set(packageName, {
      entry,
      loaderName: source.loaderName,
      sourceKey: source.sourceKey,
      meta: source.meta,
      bundle: this.readClientBundle(packageName, clientPath, () => readFileSync(clientPath)),
      baseline,
    })
    return true
  }

  private flush(onError: (err: Error) => void): void {
    if (this.dirty.size === 0) return
    const entriesByName = new Map<string, Entry[]>()
    try {
      for (const entry of this.ctx.loader.entries()) {
        const name = entry.options.name
        const entries = entriesByName.get(name)
        if (entries) entries.push(entry)
        else entriesByName.set(name, [entry])
      }
    } catch (error) {
      // No package state changed; consume this failed batch and retain the published graph.
      this.dirty.clear()
      onError(error instanceof Error ? error : new Error(String(error)))
      return
    }
    let changed = false
    for (const entryName of [...this.dirty]) {
      this.dirty.delete(entryName)
      try {
        if (this.processOne(entryName, entriesByName.get(entryName) ?? [], onError)) changed = true
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

  /** Match an exact current-revision package-local chunk URL without reading its file. */
  private chunkRequest(requestUrl: URL): {
    record: WebPluginRecord
    fileName: string
    sourceMap: boolean
    resourceUrl: string
  } | undefined {
    const resourceUrl = `${requestUrl.pathname}${requestUrl.search}`
    for (const record of this.table.values()) {
      const prefix = `/plugins/${record.entry.id}/`
      if (!requestUrl.pathname.startsWith(prefix)) continue
      const requested = requestUrl.pathname.slice(prefix.length)
      const sourceMap = requested.endsWith('.map')
      const fileName = sourceMap ? requested.slice(0, -'.map'.length) : requested
      // The Node Client entry and its split chunks share this directory but
      // must never be served as browser factory scripts.
      if (!CLIENT_CHUNK.test(fileName) || fileName === 'client.node.js' || fileName.startsWith('client.node.')) return undefined
      if (resourceUrl !== chunkUrl(record.entry.id, fileName, record.entry.rev, sourceMap)) return undefined
      return { record, fileName, sourceMap, resourceUrl }
    }
    return undefined
  }

  /** Build a package-local chunk response only when its URL is requested. */
  private chunkResponse(requestUrl: URL): LazyResponse | undefined {
    const request = this.chunkRequest(requestUrl)
    if (request === undefined) return undefined
    const { record, fileName, sourceMap, resourceUrl } = request
    const clientPath = join(dirname(record.meta.clientPath), fileName)
    if (!existsSync(clientPath)) return undefined
    const sourceMapUrl = chunkMapReference(fileName, record.entry.rev)
    // An on-demand chunk is read asynchronously: a host whose filesystem fetches
    // lazily requested files on first read can serve it without a blocking read.
    const resource = async (): Promise<ComboResource> => ({
      id: record.entry.id,
      rev: record.entry.rev,
      clientPath,
      fileName,
      bundle: await readFile(clientPath),
    })
    const response: LazyResponse = sourceMap
      ? {
        body: lazyBody(async () => buildComboSourceMap([await resource()], this.readSourceMap, fileName)),
        contentType: 'application/json; charset=utf-8',
      }
      : {
        body: lazyBody(async () => buildComboScript([await resource()], sourceMapUrl)),
        contentType: 'text/javascript; charset=utf-8',
      }
    this.responses.set(resourceUrl, response)
    return response
  }

  /**
   * Answer one package-asset request. Node's `require.resolve` applies the
   * package's `./assets/*` export as a self-reference, so unexported,
   * `.`/`..`, missing, and directory paths answer 404. The build writes each
   * asset's content revision into its file name, so a served path names one
   * content: the body streams from disk on every request, and the path is the
   * entity tag.
   * @param method - request method.
   * @param record - the active row of the addressed package, or undefined when it is not active.
   * @param assetPath - percent-encoded path below the package's `assets/` route segment.
   * @param ifNoneMatch - request `If-None-Match` field.
   * @returns the route answer.
   */
  private assetResponse(
    method: 'GET' | 'HEAD',
    record: WebPluginRecord | undefined,
    assetPath: string,
    ifNoneMatch: string | undefined,
  ): {
    status: number
    headers?: Record<string, string>
    body?: Readable
  } {
    if (record === undefined || assetPath === '') return { status: 404 }
    let file: string
    try {
      file = createRequire(record.meta.manifestPath)
        .resolve(`${record.entry.id}/${PACKAGE_ASSET_SEGMENT}/${decodeURIComponent(assetPath)}`)
    } catch {
      // Unresolvable or malformed paths name no asset.
      return { status: 404 }
    }
    // The resolved file decides the type: Node reads `#` and `?` in the subpath as URL syntax.
    const mediaType = packageAssetMediaType(file)
    if (mediaType === undefined) return { status: 404 }
    const headers: Record<string, string> = {
      'content-type': mediaType,
      'cache-control': IMMUTABLE_CACHE,
      etag: `"${assetPath}"`,
      'x-content-type-options': 'nosniff',
      // A directly opened SVG document runs no script.
      ...(mediaType === 'image/svg+xml' ? { 'content-security-policy': "script-src 'none'" } : {}),
    }
    if (ifNoneMatch === headers.etag) return { status: 304, headers }
    return { status: 200, headers, ...(method === 'HEAD' ? {} : { body: createReadStream(file) }) }
  }

  /**
   * Answer one `/plugins` request. A `/plugins/<package>/assets/` path is
   * answered by the package-asset route alone; any other path is an advertised
   * combo or its map, a prior startup generation, or a current-revision
   * package-local chunk, in that order, and otherwise 404.
   */
  private async bundleResource(method: string | undefined, url: string, ifNoneMatch: string | undefined): Promise<{
    status: number
    headers?: Record<string, string>
    body?: Buffer | Readable
  }> {
    if (method !== 'GET' && method !== 'HEAD') return { status: 405 }
    const requestUrl = new URL(url, 'http://x')
    const asset = PACKAGE_ASSET_PATH.exec(requestUrl.pathname)
    if (asset !== null) {
      const [, packageName = '', assetPath = ''] = asset
      return this.assetResponse(method, this.table.get(packageName), assetPath, ifNoneMatch)
    }
    const resourceUrl = `${requestUrl.pathname}${requestUrl.search}`
    const response = this.responses.get(resourceUrl)
      ?? this.previousBatchResponses.get(resourceUrl)
      ?? this.chunkResponse(requestUrl)
    if (response !== undefined) {
      return {
        status: 200,
        headers: { 'content-type': response.contentType, 'cache-control': IMMUTABLE_CACHE },
        ...(method === 'HEAD' ? {} : { body: await response.body() }),
      }
    }
    // Anything else under /plugins (including unadvertised combinations and
    // /plugins/events when the HMR row is absent) is an unknown resource.
    return { status: 404 }
  }

}

export default ClientModuleRegistry
