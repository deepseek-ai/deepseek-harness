/** Expire Node's cached package configuration for package directories whose manifest changed. */
import { isUtf8 } from 'node:buffer'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { basename, dirname, join, sep, toNamespacedPath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Package fields Node's resolver consumes; exports and imports hold JSON values. */
interface PackageConfig {
  name?: string
  main?: string
  type: string
  exports?: unknown
  imports?: unknown
}

/** Serialized fields returned by the native modules binding: name, main, type, imports, exports, manifest path. */
type PackageTuple = [string | undefined, string | undefined, string, string | undefined, string | undefined, string]

/**
 * Methods of `internalBinding('modules')` that read package configuration through Node's native cache. Node's
 * package reader, CommonJS loader, and ESM resolver and format detection look them up at each call.
 */
interface PackageBinding {
  readPackageJSON(this: void, path: string, isEsm?: boolean, base?: string, specifier?: string): PackageTuple | undefined
  getPackageScopeConfig(this: void, url: string): PackageTuple | string
  getPackageType(this: void, url: string): string | undefined
}

/**
 * `internal/modules/package_json_reader` export that keeps its own nearest-manifest cache; the CommonJS loader calls it
 * through the module object, so it is the only caller of the binding's nearest-manifest lookup.
 */
interface PackageReader {
  getNearestParentPackageJSON(this: void, path: string): { data: PackageConfig; exists: boolean; path: string } | undefined
}

/** Node's ESM resolution cache: a Map from parent URL to the serialized request keys resolved from it. */
interface ResolveCacheClass {
  prototype: { get: (this: Map<string, unknown>, key: string, parent: string) => unknown }
}

interface CommonJsModule {
  _pathCache: Record<string, string>
  _resolveFilename(request: string, parent: NodeJS.Module | null | undefined, isMain?: boolean): string
  _load(request: string, parent: NodeJS.Module | null | undefined, isMain?: boolean, ...options: unknown[]): unknown
}

interface NativeAccess {
  binding: PackageBinding
  reader: PackageReader
  ResolveCache: ResolveCacheClass
  cjs: CommonJsModule
  esmLoader: { resolveSync(...args: unknown[]): unknown }
}

/** Snapshot own methods; each disposer restores its method only while its replacement is still installed. */
function createReplaceHelper<T extends { [K in keyof T]: (...args: never[]) => unknown }>(target: T) {
  const rawImpl = { ...target }
  return {
    rawImpl,
    replaceMethod<K extends keyof T>(key: K, replacement: T[K]): () => void {
      target[key] = replacement
      return () => { if (target[key] === replacement) target[key] = rawImpl[key] }
    },
  }
}

/** Same lookup as the vendored Loader's `requireInternal`: `--expose-internals` first, then the builtin addon. */
function requireInternal(id: string): unknown {
  const require = createRequire(import.meta.url)
  if (process.execArgv.includes('--expose-internals')) {
    try {
      return require(id)
    } catch (_error) {
      // Some internals, such as internal/bootstrap/realm, stay private under --expose-internals.
    }
  }
  try {
    return (require('node-addon-require-builtin') as { requireBuiltin(id: string): unknown }).requireBuiltin(id)
  } catch (_error) {
    // Without the addon, the caller reports the missing interface.
  }
}

function loadNodeInternals(): NativeAccess {
  const realm = requireInternal('internal/bootstrap/realm') as { internalBinding(id: 'modules'): PackageBinding }
  const esm = requireInternal('internal/modules/esm/loader') as {
    getOrInitializeCascadedLoader(): NativeAccess['esmLoader']
  }
  return {
    binding: realm.internalBinding('modules'),
    reader: requireInternal('internal/modules/package_json_reader') as PackageReader,
    ResolveCache: (requireInternal('internal/modules/esm/module_map') as { ResolveCache: ResolveCacheClass }).ResolveCache,
    cjs: (requireInternal('internal/modules/cjs/loader') as { Module: CommonJsModule }).Module,
    esmLoader: esm.getOrInitializeCascadedLoader(),
  }
}

/**
 * Read the ESM loader's resolution cache by observing one lookup through its prototype.
 * The prototype method is restored before this returns.
 */
function captureEsmResolveCache(native: NativeAccess, parentURL: string): Map<string, unknown> | undefined {
  const prototype = native.ResolveCache.prototype
  const original = prototype.get
  const seen = new Set<Map<string, unknown>>()
  prototype.get = function (this: Map<string, unknown>, key: string, parent: string): unknown {
    seen.add(this)
    return Reflect.apply(original, this, [key, parent])
  }
  try {
    const loader = native.esmLoader
    /* v8 ignore else -- CI coverage runs the Node 24 loader; the Node 22 matrix exercises the v1 signature */
    if ('getOrCreateModuleJob' in loader) loader.resolveSync(parentURL, { specifier: 'node:path', attributes: {} })
    else loader.resolveSync('node:path', parentURL, {})
  } finally {
    prototype.get = original
  }
  return [...seen][0]
}

interface Configuration {
  data: PackageConfig
  serialized: PackageTuple
}

interface ImportContext {
  base: string
  specifier: string | undefined
}

/** Package directories whose manifests are read from disk instead of Node's native cache. */
export class PackageManifests {
  private readonly directories = new Set<string>()
  private readonly configurations = new Map<string, Configuration | undefined>()
  /** Real directory of each directory a lookup reached; linked consumers name a package by its link path. */
  private readonly realDirectories = new Map<string, string>()
  private native: NativeAccess | undefined
  private rawBinding!: PackageBinding
  private rawReader!: PackageReader
  private rawCommonJs!: Pick<CommonJsModule, '_load'>
  private readonly restorers: Array<() => void> = []

  /**
   * Expire cached configuration for one package directory. Loaded modules stay evaluated; later resolutions and
   * format checks read the manifest on disk.
   * @param manifest - absolute path of the changed `package.json`.
   */
  invalidate(manifest: string): void {
    const native = this.installPackageHooks()
    const directory = dirname(manifest)
    this.directories.add(directory)
    this.configurations.clear()
    this.realDirectories.clear()
    // A package's entry may resolve outside its directory; cache keys do not record the manifests they consulted.
    for (const key of Object.keys(native.cjs._pathCache)) Reflect.deleteProperty(native.cjs._pathCache, key)
    const directoryURL = pathToFileURL(directory).href + '/'
    const cache = captureEsmResolveCache(native, directoryURL)
    /* v8 ignore else -- asynchronous loader hooks own a separate cache; loader-thread invalidation is deferred */
    if (cache !== undefined) Map.prototype.clear.call(cache)
  }

  /** Restore every replaced Node method this instance installed. */
  dispose(): void {
    for (const restore of this.restorers.splice(0).reverse()) restore()
    this.native = undefined
    this.realDirectories.clear()
  }

  private isPathWithinDirectory(path: string, directory: string): boolean {
    return path === directory || path.startsWith(join(directory, sep))
  }

  private isPathInInvalidatedDirectory(path: string): boolean {
    const parent = dirname(path)
    let real = this.realDirectories.get(parent)
    if (real === undefined) {
      try { real = realpathSync(parent) } catch (_error) {
        // A missing directory keeps its configured spelling; it has no manifest to read through a link.
        real = parent
      }
      this.realDirectories.set(parent, real)
    }
    const target = join(real, basename(path))
    for (const directory of this.directories) if (this.isPathWithinDirectory(target, directory)) return true
    return false
  }

  private isUrlInInvalidatedDirectory(url: string): boolean {
    try { return this.isPathInInvalidatedDirectory(fileURLToPath(url)) } catch (_error) {
      // Only file URLs can name an invalidated package directory.
      return false
    }
  }

  private installPackageHooks(): NativeAccess {
    if (this.native !== undefined) return this.native
    const native = loadNodeInternals()
    this.native = native
    const binding = createReplaceHelper(native.binding)
    const reader = createReplaceHelper(native.reader)
    const commonJs = createReplaceHelper<Pick<CommonJsModule, '_load'>>(native.cjs)
    this.rawBinding = binding.rawImpl
    this.rawReader = reader.rawImpl
    this.rawCommonJs = commonJs.rawImpl
    this.restorers.push(
      binding.replaceMethod('readPackageJSON', this.hookBindingReadPackageJSON.bind(this)),
      binding.replaceMethod('getPackageScopeConfig', this.hookBindingGetPackageScopeConfig.bind(this)),
      binding.replaceMethod('getPackageType', this.hookBindingGetPackageType.bind(this)),
      reader.replaceMethod('getNearestParentPackageJSON', this.hookReaderGetNearestParentPackageJSON.bind(this)),
      commonJs.replaceMethod('_load', this.hookCommonJsLoad.bind(this)),
    )
    return native
  }

  private hookCommonJsLoad(...[request, parent, isMain, ...options]: Parameters<CommonJsModule['_load']>) {
    const native = this.installPackageHooks()
    // Absolute filenames bypass Node's private request cache without evicting evaluated modules.
    const filename = request.startsWith('node:') || isBuiltin(request)
      ? request : native.cjs._resolveFilename(request, parent, isMain)
    return this.rawCommonJs._load.call(native.cjs, filename, parent, isMain, ...options)
  }

  private hookBindingReadPackageJSON(path: string, isEsm?: boolean, base?: string, specifier?: string) {
    return this.isPathInInvalidatedDirectory(path)
      ? this.readCachedPackageConfig(
        path,
        isEsm && base !== undefined ? { base, specifier } : undefined,
      )?.serialized
      : this.rawBinding.readPackageJSON(path, isEsm, base, specifier)
  }

  private hookBindingGetPackageScopeConfig(url: string) {
    if (!this.isUrlInInvalidatedDirectory(url)) return this.rawBinding.getPackageScopeConfig(url)
    const found = this.findNearestPackageConfig(fileURLToPath(url), true)
    if (typeof found === 'string') return this.rawBinding.getPackageScopeConfig(pathToFileURL(found).href)
    return found.configuration?.serialized ?? found.path
  }

  private hookBindingGetPackageType(url: string) {
    if (!this.isUrlInInvalidatedDirectory(url)) return this.rawBinding.getPackageType(url)
    const found = this.findNearestPackageConfig(fileURLToPath(url), true)
    return typeof found === 'string'
      ? this.rawBinding.getPackageType(pathToFileURL(found).href)
      : found.configuration?.data.type
  }

  private hookReaderGetNearestParentPackageJSON(path: string) {
    if (!this.isPathInInvalidatedDirectory(path)) return this.rawReader.getNearestParentPackageJSON(path)
    const found = this.findNearestPackageConfig(path, false)
    if (typeof found === 'string') return this.rawReader.getNearestParentPackageJSON(found)
    // A lookup that stops without a manifest keeps the running Node version's own absent result.
    if (found.configuration === undefined) return this.rawReader.getNearestParentPackageJSON(path)
    return { data: found.configuration.data, exists: true, path: found.path }
  }

  private readCachedPackageConfig(path: string, context?: ImportContext): Configuration | undefined {
    if (!this.configurations.has(path)) this.configurations.set(path, this.readPackageConfigFromDisk(path, context))
    return this.configurations.get(path)
  }

  /** A string names the first manifest outside the invalidated directories; Node answers for it. */
  private findNearestPackageConfig(path: string, includeRoot: boolean): { path: string; configuration?: Configuration } | string {
    let directory = dirname(path)
    while (true) {
      const manifest = join(directory, 'package.json')
      const parent = dirname(directory)
      if (basename(directory) === 'node_modules' || (!includeRoot && parent === directory)) return { path: manifest }
      if (!this.isPathInInvalidatedDirectory(manifest)) return manifest
      const configuration = this.readCachedPackageConfig(manifest)
      if (configuration !== undefined) return { path: toNamespacedPath(manifest), configuration }
      /* v8 ignore next -- root-scope queries run in an isolated child to contain non-termination */
      if (parent === directory) return { path: manifest }
      directory = parent
    }
  }

  /** @param context - optional ESM import details used only when reporting invalid package configuration. */
  private readPackageConfigFromDisk(path: string, context?: ImportContext): Configuration | undefined {
    let bytes: Buffer
    try { bytes = readFileSync(path) } catch (_error) {
      // Node reports a missing manifest as absent configuration.
      return undefined
    }
    const throwInvalidPackageConfig = (): never => {
      // The native reader throws a plain Error carrying only this code.
      const base = context?.base
      const importing = base === undefined ? ''
        : ` while importing "${context?.specifier}" from ${base.startsWith('file:') ? fileURLToPath(base) : base}`
      throw Object.assign(new Error(`Invalid package config ${toNamespacedPath(path)}${importing}.`), { code: 'ERR_INVALID_PACKAGE_CONFIG' })
    }
    if (!isUtf8(bytes)) return throwInvalidPackageConfig()
    const source = bytes.toString('utf8')
    let parsed: unknown
    try { parsed = JSON.parse(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source) } catch (_error) {
      return throwInvalidPackageConfig()
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return throwInvalidPackageConfig()
    const fields = parsed as Record<string, unknown>
    if (fields.name !== undefined && typeof fields.name !== 'string') return throwInvalidPackageConfig()
    if (fields.type !== undefined && typeof fields.type !== 'string') return throwInvalidPackageConfig()
    for (const key of ['name', 'type', 'exports', 'imports']) {
      const value = fields[key]
      if (typeof value === 'string' && !value.isWellFormed()) return throwInvalidPackageConfig()
    }
    const normalizePackageJsonField = (value: unknown): unknown =>
      value !== null && (typeof value === 'string' || typeof value === 'object') ? value : undefined
    const data: PackageConfig = {
      ...typeof fields.name === 'string' ? { name: fields.name } : {},
      ...typeof fields.main === 'string' && fields.main.isWellFormed() ? { main: fields.main } : {},
      type: fields.type === 'module' || fields.type === 'commonjs' ? fields.type : 'none',
      exports: normalizePackageJsonField(fields.exports),
      imports: normalizePackageJsonField(fields.imports),
    }
    const serializePackageJsonField = (value: unknown): string | undefined =>
      value === undefined ? undefined : typeof value === 'string' ? value : JSON.stringify(value)
    return {
      data,
      serialized: [
        data.name,
        data.main,
        data.type,
        serializePackageJsonField(data.imports),
        serializePackageJsonField(data.exports),
        toNamespacedPath(path),
      ],
    }
  }
}
