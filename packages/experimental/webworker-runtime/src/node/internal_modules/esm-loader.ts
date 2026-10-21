/**
 * `internal/modules/esm/loader` cascaded loader for the Worker. {@link createCascadedLoader} builds the object with
 * the Node v24.18.0 (v2) loader members this repository calls: `resolveSync` and `import` over one Worker module
 * loader, and an empty `loadCache`. ES module jobs are unavailable on this platform.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/node/internal_modules/esm-loader
 */
import { notAvailableError } from '../notImplementedFail.ts'
import { LoadCache } from './module-map.ts'

/** One module request in Node's v2 loader signature. */
export interface ModuleRequest {
  readonly specifier: string
  readonly attributes?: Readonly<Record<string, string>>
}

/** Worker module-loader operations a cascaded loader delegates to, in Node's v1 argument order. */
export interface CascadedLoaderSource {
  import(specifier: string, parentURL?: string): Promise<unknown>
  resolveSync(specifier: string, parentURL?: string): { readonly url: string; readonly format: string }
}

/** The cascaded loader members provided in the Worker. */
export interface CascadedLoader {
  /** Always empty: the Worker creates no ES module jobs. */
  readonly loadCache: LoadCache
  /**
   * Resolve one request for this repository's Node-loader callers.
   * @param parentURL - URL of the requesting module; undefined resolves from the image root.
   * @param request - Requested module.
   * @returns The resolved URL and module format.
   * @throws Error with `ERR_MODULE_NOT_FOUND` or `ERR_PACKAGE_PATH_NOT_EXPORTED` when the request does not resolve.
   */
  resolveSync(parentURL: string | undefined, request: ModuleRequest): { url: string; format: string }
  /**
   * Load one module through the Worker loader.
   * @param specifier - Requested module.
   * @param parentURL - URL of the requesting module.
   * @param _importAttributes - Import attributes; the Worker loads CommonJS bodies and ignores them.
   * @returns The module's exports.
   */
  import(specifier: string, parentURL: string | undefined, _importAttributes?: Readonly<Record<string, string>>): Promise<unknown>
  /**
   * Refuse: the Worker creates no ES module jobs.
   * @returns Never; always throws.
   */
  getOrCreateModuleJob(): never
}

/**
 * Translate a Worker resolution failure into the code Node's ESM resolver reports.
 * @param error - Failure thrown by the Worker module loader.
 * @returns The same failure with an ESM resolution code.
 */
function esmResolutionError(error: unknown): unknown {
  if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
    return Object.assign(error, { code: 'ERR_MODULE_NOT_FOUND' })
  }
  return error
}

/**
 * Build the cascaded loader for one Worker module loader.
 * @param source - The Worker module loader's resolution and loading operations.
 * @returns A cascaded loader delegating to `source`.
 */
export function createCascadedLoader(source: CascadedLoaderSource): CascadedLoader {
  return {
    loadCache: new LoadCache(),
    resolveSync(parentURL, request) {
      try {
        const { url, format } = source.resolveSync(request.specifier, parentURL)
        return { url, format }
      } catch (error) {
        throw esmResolutionError(error)
      }
    },
    import(specifier, parentURL) {
      return source.import(specifier, parentURL)
    },
    getOrCreateModuleJob() {
      throw notAvailableError('internal/modules/esm/loader', 'getOrCreateModuleJob')
    },
  }
}
