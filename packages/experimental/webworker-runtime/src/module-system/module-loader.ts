/**
 * CommonJS module loader over the worker VFS. It backs the Node internal ESM
 * loader that `node-addon-require-builtin` answers, which Cordis's Loader uses
 * for every entry import, and the `node:module` `createRequire` proxy that
 * `typert-loader`, `client-modules`, and the plugin package inventory resolve
 * package metadata through.
 *
 * Resolution is a narrowed Node `require` algorithm: `exports` walk with a
 * fixed condition order, extension probing, and one cache keyed by resolved
 * absolute path. Module bodies are wrapped as the image holds them: lowering is
 * the packer's job, so nothing here parses JavaScript.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/module-system/module-loader
 */
import { createAlsRuntime, type AlsCausality, type AlsRuntime } from '../polyfill/async-context/als-runtime.ts'
import { createCascadedLoader, type CascadedLoader } from '../node/internal_modules/esm-loader.ts'
import { dirname, fileUrlToPath, isAbsolute, join, pathToFileUrl, resolve as resolvePath } from './posix-path.ts'
import { WRAPPER_PARAMS } from '../image-layout.ts'
import type { MemoryVfs } from '../storage/memory.ts'

/** Condition keys honoured in `exports`, in order; `node` is deliberately absent. */
export const DEFAULT_CONDITIONS = ['browser', 'require', 'import', 'default'] as const

/** Extensions probed when a specifier has no usable one. */
const EXTENSIONS = ['.js', '.json', '.mjs', '.cjs'] as const

type ExportsField = string | null | readonly ExportsField[] | { readonly [key: string]: ExportsField }

interface PackageManifest {
  readonly name?: string
  readonly main?: string
  readonly exports?: ExportsField
}

/**
 * One entry of the static-module table. The loader calls it when a `require`
 * names that specifier and never before, so resolution alone — `require.resolve`
 * or `import.meta.resolve` — evaluates nothing. Repeated requires of one
 * specifier must answer the same module instance: callers depend on class
 * identity across requires (`instanceof EventEmitter`, `Buffer.isBuffer`), so a
 * factory that builds its value has to memoize it.
 * @returns The module object served for that specifier.
 */
export type StaticModuleFactory = () => unknown

/** Where a specifier resolved to. */
export type Resolution =
  | { readonly kind: 'static'; readonly specifier: string; readonly factory: StaticModuleFactory }
  | { readonly kind: 'file'; readonly path: string }

/** Node-loader-compatible resolution returned through the Cordis internal seam. */
export interface WorkerInternalResolution {
  readonly format: 'builtin' | 'commonjs' | 'json'
  /** File URL for VFS modules; the original bare specifier for builtins. */
  readonly url: string
}

interface ModuleRecord {
  readonly module: { exports: unknown }
}

/** Resolution helpers carried by a Worker-backed CommonJS require. */
export interface WorkerRequireResolve {
  /**
   * Resolve one specifier without evaluating its module.
   * @param specifier - Module request relative to the require base.
   * @returns Static or VFS-backed module identity.
   */
  (specifier: string): string
  /**
   * Return the directories this loader's Node-style package discovery searches.
   * @param specifier - Module request whose lookup roots are requested.
   * @returns Search roots, or null for a Worker-provided module.
   */
  paths(specifier: string): string[] | null
}

/** The `require` function shape the roster consumes through `createRequire`. */
export interface WorkerRequire {
  (specifier: string): unknown
  readonly resolve: WorkerRequireResolve
}

/** Construction inputs for {@link WorkerModuleLoader}. */
export interface WorkerModuleLoaderOptions {
  /** Filesystem holding package metadata and module sources. */
  readonly vfs: MemoryVfs
  /** Virtual root whose `node_modules` bare specifiers resolve against. */
  readonly root?: string
  /**
   * Modules served from the worker bundle instead of the VFS: `node:*` proxies
   * and the loud stubs for excluded npm packages, each behind a
   * {@link StaticModuleFactory}.
   */
  readonly staticModules: Readonly<Record<string, StaticModuleFactory>>
  /**
   * Prefix-matched proxies for packages whose subpaths are open-ended: a
   * specifier starting with the key resolves to its module. Exact keys win, and
   * the longest matching prefix wins among prefixes.
   */
  readonly staticModulePrefixes?: Readonly<Record<string, StaticModuleFactory>>
  /** Overrides {@link DEFAULT_CONDITIONS}. */
  readonly conditions?: readonly string[]
  /**
   * Ambient-store snapshot face for the suspended `rewrite-await` route; it is
   * read only when that route is the configured {@link lowering}.
   */
  readonly alsCausality?: AlsCausality
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Loader for one VFS mount; construct once per worker. */
export class WorkerModuleLoader {
  private readonly vfs: MemoryVfs
  private readonly root: string
  private readonly staticModules: ReadonlyMap<string, StaticModuleFactory>
  private readonly staticPrefixes: ReadonlyArray<readonly [string, StaticModuleFactory]>
  private readonly conditions: ReadonlySet<string>
  private readonly als: AlsRuntime
  private readonly modules = new Map<string, ModuleRecord>()
  private readonly manifests = new Map<string, PackageManifest>()
  private readonly stack: string[] = []
  private cascaded: CascadedLoader | undefined

  /**
   * Resolution and loading over this mount, in Node's v1 argument order. The cascaded ESM loader
   * ({@link cascadedLoader}) and the packer call it; `parentURL` positions relative specifiers and import attributes
   * are ignored.
   */
  readonly internal: {
    readonly version: 'worker'
    import(specifier: string, parentURL?: string, attributes?: unknown): Promise<unknown>
    resolve(specifier: string, parentURL?: string, attributes?: unknown): Promise<WorkerInternalResolution>
    resolveSync(specifier: string, parentURL?: string, attributes?: unknown): WorkerInternalResolution
  }

  constructor(options: WorkerModuleLoaderOptions) {
    this.vfs = options.vfs
    this.root = options.root ?? '/dsh'
    // A Map, not the record itself: a specifier that names an Object prototype
    // member must miss the table the way any other unregistered name does.
    this.staticModules = new Map(Object.entries(options.staticModules))
    this.staticPrefixes = Object.entries(options.staticModulePrefixes ?? {})
      .sort(([left], [right]) => right.length - left.length)
    this.conditions = new Set(options.conditions ?? DEFAULT_CONDITIONS)
    this.als = createAlsRuntime(options.alsCausality)
    const resolveInternal = (specifier: string, parentURL?: string): WorkerInternalResolution => {
      const from = parentURL === undefined ? this.root : this.baseDirectoryOf(parentURL)
      const resolution = this.resolve(specifier, from)
      if (resolution.kind === 'static') return { format: 'builtin', url: resolution.specifier }
      return {
        format: resolution.path.endsWith('.json') ? 'json' : 'commonjs',
        url: pathToFileUrl(resolution.path),
      }
    }
    this.internal = {
      version: 'worker',
      import: async (specifier: string, parentURL?: string): Promise<unknown> => {
        const from = parentURL === undefined ? this.root : this.baseDirectoryOf(parentURL)
        return this.load(this.resolve(specifier, from))
      },
      resolve: async (specifier: string, parentURL?: string) => resolveInternal(specifier, parentURL),
      resolveSync: resolveInternal,
    }
  }

  /**
   * The `internal/modules/esm/loader` cascaded loader over this mount, created on first use.
   * @returns This loader's one cascaded loader.
   */
  cascadedLoader(): CascadedLoader {
    return this.cascaded ??= createCascadedLoader(this.internal)
  }

  /**
   * Throw this loader's diagnostic.
   * @param detail - What failed.
   * @param code - Node error code for a resolution failure Node also reports by code.
   */
  private fail(detail: string, code?: 'MODULE_NOT_FOUND' | 'ERR_PACKAGE_PATH_NOT_EXPORTED'): never {
    const chain = this.stack.length === 0 ? '' : ` (importer chain: ${this.stack.join(' -> ')})`
    const error = new Error(`webworker modules: ${detail}${chain}`)
    throw code === undefined ? error : Object.assign(error, { code })
  }

  /** @returns Directory a base path or URL resolves specifiers from. */
  private baseDirectoryOf(base: string | URL): string {
    const text = typeof base === 'string' ? base : base.href
    const path = text.startsWith('file://') ? fileUrlToPath(text) : text
    if (path.endsWith('/')) return resolvePath(path)
    return this.vfs.existsSync(path) && this.vfs.statSync(path).isDirectory() ? resolvePath(path) : dirname(path)
  }

  private manifestOf(directory: string): PackageManifest {
    const cached = this.manifests.get(directory)
    if (cached !== undefined) return cached
    const path = join(directory, 'package.json')
    const text = this.vfs.readFileSync(path, 'utf8') as string
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (reason) {
      this.fail(`${path} is not valid JSON: ${(reason as Error).message}`)
    }
    if (!isRecord(parsed)) this.fail(`${path} does not hold an object`)
    const manifest = parsed as PackageManifest
    this.manifests.set(directory, manifest)
    return manifest
  }

  /** Walk one `exports` value against the condition set and requested subpath. */
  private selectExport(field: ExportsField, subpath: string, packageName: string): string | undefined {
    if (field === null) return undefined
    if (typeof field === 'string') return subpath === '.' ? field : undefined
    if (Array.isArray(field)) {
      for (const candidate of field as readonly ExportsField[]) {
        const picked = this.selectExport(candidate, subpath, packageName)
        if (picked !== undefined) return picked
      }
      return undefined
    }
    const entries = Object.entries(field as { [key: string]: ExportsField })
    const isSubpathMap = entries.some(([key]) => key === '.' || key.startsWith('./'))
    if (!isSubpathMap) {
      if (subpath !== '.') return undefined
      return this.selectCondition(field, packageName)
    }
    for (const [key, value] of entries) {
      if (key === subpath) {
        return typeof value === 'string' ? value : this.selectCondition(value, packageName, subpath)
      }
    }
    for (const [key, value] of entries) {
      const star = key.indexOf('*')
      if (star < 0) continue
      const prefix = key.slice(0, star)
      const suffix = key.slice(star + 1)
      if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue
      const captured = subpath.slice(prefix.length, subpath.length - suffix.length)
      const target = typeof value === 'string' ? value : this.selectCondition(value, packageName, subpath)
      if (target !== undefined) return target.replaceAll('*', captured)
    }
    return undefined
  }

  /** Pick the first condition branch this runtime satisfies. */
  private selectCondition(field: ExportsField, packageName: string, subpath = '.'): string | undefined {
    if (field === null) return undefined
    if (typeof field === 'string') return field
    if (Array.isArray(field)) {
      for (const candidate of field as readonly ExportsField[]) {
        const picked = this.selectCondition(candidate, packageName, subpath)
        if (picked !== undefined) return picked
      }
      return undefined
    }
    for (const [key, value] of Object.entries(field as { [key: string]: ExportsField })) {
      if (!this.conditions.has(key)) continue
      const picked = this.selectCondition(value, packageName, subpath)
      if (picked !== undefined) return picked
    }
    return undefined
  }

  /** Extension and directory probing for a concrete path. */
  private probe(path: string, specifier: string): string {
    const candidates: string[] = [path, ...EXTENSIONS.map(extension => path + extension)]
    for (const candidate of candidates) {
      if (this.vfs.existsSync(candidate) && this.vfs.statSync(candidate).isFile()) return candidate
    }
    if (this.vfs.existsSync(path) && this.vfs.statSync(path).isDirectory()) {
      if (this.vfs.existsSync(join(path, 'package.json'))) {
        const main = this.manifestOf(path).main
        if (main !== undefined) return this.probe(join(path, main), specifier)
      }
      return this.probe(join(path, 'index'), specifier)
    }
    return this.fail(`cannot resolve "${specifier}": no file at ${candidates.join(', ')}`, 'MODULE_NOT_FOUND')
  }

  /** @returns The Worker-provided implementation of a static specifier. */
  private staticModule(specifier: string): StaticModuleFactory | undefined {
    const exact = this.staticModules.get(specifier)
    if (exact !== undefined) return exact
    for (const [prefix, factory] of this.staticPrefixes) {
      if (specifier.startsWith(prefix)) return factory
    }
    return this.staticModules.get(`node:${specifier}`)
  }

  /**
   * Resolve a specifier the way the module that requested it would.
   * @param specifier - Bare name, relative path, absolute path, or file URL.
   * @param fromDirectory - Directory of the requesting module.
   * @returns Static module or the resolved VFS path.
   */
  resolve(specifier: string, fromDirectory: string): Resolution {
    const staticModule = this.staticModule(specifier)
    if (staticModule !== undefined) return { kind: 'static', specifier, factory: staticModule }
    if (specifier.startsWith('cordis:') || specifier.startsWith('node:')) {
      return this.fail(`no static module is registered for "${specifier}"`)
    }
    if (specifier.startsWith('file://')) {
      return { kind: 'file', path: this.probe(fileUrlToPath(specifier), specifier) }
    }
    if (specifier.startsWith('.')) {
      return { kind: 'file', path: this.probe(join(fromDirectory, specifier), specifier) }
    }
    if (isAbsolute(specifier)) {
      return { kind: 'file', path: this.probe(specifier, specifier) }
    }
    const segments = specifier.split('/')
    const packageName = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0] ?? specifier
    const rest = specifier.slice(packageName.length).replace(/^\//, '')
    const packageDirectory = join(this.root, 'node_modules', packageName)
    if (!this.vfs.existsSync(join(packageDirectory, 'package.json'))) {
      return this.fail(`cannot resolve "${specifier}": ${packageDirectory}/package.json is not in the image`, 'MODULE_NOT_FOUND')
    }
    const manifest = this.manifestOf(packageDirectory)
    const subpath = rest === '' ? '.' : `./${rest}`
    if (manifest.exports !== undefined) {
      const target = this.selectExport(manifest.exports, subpath, packageName)
      if (target === undefined) {
        return this.fail(
          `"${packageName}" does not export "${subpath}" under conditions [${[...this.conditions].join(', ')}]`,
          'ERR_PACKAGE_PATH_NOT_EXPORTED',
        )
      }
      return { kind: 'file', path: this.probe(join(packageDirectory, target), specifier) }
    }
    const legacy = subpath === '.' ? manifest.main ?? 'index.js' : rest
    return { kind: 'file', path: this.probe(join(packageDirectory, legacy), specifier) }
  }

  /**
   * Load a resolved module, reusing the cache and tolerating cycles with
   * CommonJS partial-export semantics.
   * @param resolution - Result of {@link resolve}.
   * @returns The module's exports.
   */
  load(resolution: Resolution): unknown {
    if (resolution.kind === 'static') return resolution.factory()
    const path = resolution.path
    const cached = this.modules.get(path)
    if (cached !== undefined) return cached.module.exports
    if (path.endsWith('.json')) {
      const parsed: unknown = JSON.parse(this.vfs.readFileSync(path, 'utf8') as string)
      this.modules.set(path, { module: { exports: parsed } })
      return parsed
    }
    const exports: Record<string, unknown> = {}
    const record: ModuleRecord = { module: { exports } }
    this.modules.set(path, record)
    this.stack.push(path)
    try {
      const source = this.vfs.readFileSync(path, 'utf8') as string
      const factory = this.compile(source, path)
      const directory = dirname(path)
      factory(
        record.module.exports,
        this.requireFrom(directory),
        record.module,
        path,
        directory,
        {
          url: pathToFileUrl(path),
          // Node parity for the lowered `import.meta` face: a path resolution
          // answers a file URL; a static (built-in or proxied) module answers
          // its own specifier, the way Node echoes `node:*` back.
          resolve: (specifier: string): string => {
            const resolution = this.resolve(specifier, directory)
            return resolution.kind === 'static' ? resolution.specifier : pathToFileUrl(resolution.path)
          },
        },
        this.als,
      )
      return record.module.exports
    } catch (reason) {
      this.modules.delete(path)
      throw reason
    } finally {
      this.stack.pop()
    }
  }

  /**
   * Compile a body the image already lowered.
   *
   * Module syntax reaching here means the image was packed by something other
   * than the packer, or its collector missed the entry. The worker carries no
   * transform to recover with, so it names the image as the thing to rebuild.
   * @param code - Module body as the image holds it.
   * @param path - Resolved VFS path.
   * @returns The wrapper factory.
   */
  private compile(code: string, path: string): (...args: unknown[]) => void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval -- wrapping an image body is this loader's job
      return new Function(...WRAPPER_PARAMS, code) as (...args: unknown[]) => void
    } catch (reason) {
      if (reason instanceof SyntaxError && /await/i.test(reason.message)) {
        this.fail(`${path} uses top-level await, which cannot run as CommonJS in the worker: ${reason.message}`)
      }
      if (reason instanceof SyntaxError && /import|export/i.test(reason.message)) {
        this.fail(`${path} still carries module syntax, so the image was not lowered by the packer `
          + `(${reason.message}); rebuild the image`)
      }
      this.fail(`${path} failed to compile: ${(reason as Error).message}`)
    }
  }

  /**
   * Build a `require` bound to a directory.
   * @param fromDirectory - Directory relative specifiers resolve against.
   * @returns Callable require with `resolve`.
   */
  requireFrom(fromDirectory: string): WorkerRequire {
    const require = (specifier: string): unknown => this.load(this.resolve(specifier, fromDirectory))
    const resolve = ((specifier: string): string => {
      const resolution = this.resolve(specifier, fromDirectory)
      if (resolution.kind === 'static') {
        return this.fail(`"${specifier}" is a worker-provided module and has no VFS path`)
      }
      return resolution.path
    }) as WorkerRequireResolve
    resolve.paths = (specifier: string): string[] | null => {
      if (this.staticModule(specifier) !== undefined || specifier.startsWith('node:')) return null
      if (specifier.startsWith('.')) return [resolvePath(fromDirectory, '.')]
      return [join(this.root, 'node_modules')]
    }
    return Object.assign(require, { resolve })
  }

  /**
   * `node:module` `createRequire` for the VFS.
   * @param base - Module path, directory path, or `file:` URL.
   * @returns Require bound to that base.
   */
  createRequire(base: string | URL): WorkerRequire {
    return this.requireFrom(this.baseDirectoryOf(base))
  }

  /**
   * Report what this loader has done, for the host's boot diagnostics.
   * @returns How many module bodies it has run.
   */
  usage(): { modules: number } {
    return { modules: this.modules.size }
  }
}

let active: WorkerModuleLoader | undefined

/**
 * Publish the loader the `node:module` proxy resolves through.
 * @param loader - Loader built by the worker entry.
 */
export function setActiveModuleLoader(loader: WorkerModuleLoader): void {
  active = loader
}

/**
 * Read the published loader.
 * @returns The active loader.
 */
export function requireActiveModuleLoader(): WorkerModuleLoader {
  if (active === undefined) {
    throw new Error('webworker modules: no loader is mounted; the worker entry must call setActiveModuleLoader before any createRequire use')
  }
  return active
}
