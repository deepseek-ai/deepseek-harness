/**
 * Node internal members HMR reads and replaces while expiring package configuration:
 * `internal/modules/cjs/loader`'s `Module` caches and loaders, `internal/modules/package_json_reader`, and the
 * `modules` binding from `internal/bootstrap/realm`. The Worker's own `require` does not route through them, so
 * they keep Node's member names for replacement and refuse when called.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/node/internal_modules/package-surfaces
 */
import { notAvailableError, notImplementedFail } from '../notImplementedFail.ts'

const CJS_LOADER = 'internal/modules/cjs/loader'

/** `Module` with the static members HMR reads and replaces. */
export const Module = Object.assign(
  function Module(): never { throw notAvailableError(CJS_LOADER, 'Module') },
  {
    /** Empty: the Worker loader keeps its own resolution cache. */
    _pathCache: Object.create(null) as Record<string, string>,
    _resolveFilename: notImplementedFail(CJS_LOADER, 'Module._resolveFilename'),
    _load: notImplementedFail(CJS_LOADER, 'Module._load'),
  },
)

/** `internal/modules/package_json_reader` with the member HMR replaces. */
export const packageJsonReader = {
  getNearestParentPackageJSON: notImplementedFail('internal/modules/package_json_reader', 'getNearestParentPackageJSON'),
}

/** `internalBinding('modules')` with the members HMR replaces. */
const modulesBinding = {
  readPackageJSON: notImplementedFail('internalBinding("modules")', 'readPackageJSON'),
  getPackageScopeConfig: notImplementedFail('internalBinding("modules")', 'getPackageScopeConfig'),
  getPackageType: notImplementedFail('internalBinding("modules")', 'getPackageType'),
}

/** `internal/bootstrap/realm`: only the `modules` binding is provided. */
export const realm = {
  /**
   * Answer one internal binding.
   * @param name - Binding name.
   * @returns The `modules` binding.
   * @throws Error with `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` for any other binding.
   */
  internalBinding(name: string): typeof modulesBinding {
    if (name === 'modules') return modulesBinding
    throw notAvailableError('internal/bootstrap/realm', `internalBinding(${JSON.stringify(name)})`)
  },
}
