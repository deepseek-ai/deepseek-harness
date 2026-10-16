/**
 * `node-addon-require-builtin` for the Worker. Without `--expose-internals`, the vendored Loader, app-boot, and HMR
 * read Node internal modules through this package's `requireBuiltin(id)`; the Worker answers the ids those callers
 * read with members that follow Node v24.18.0 and refuses every other id with Node's platform code.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/node/external_packages/node-addon-require-builtin
 */
import { notAvailableError } from '../notImplementedFail.ts'
import { requireActiveModuleLoader } from '../../module-system/module-loader.ts'
import { LoadCache, ResolveCache } from '../internal_modules/module-map.ts'
import { Module, packageJsonReader, realm } from '../internal_modules/package-surfaces.ts'

/** Mutable module objects: HMR replaces members on them and restores the originals. */
const INTERNAL_MODULES: ReadonlyMap<string, object> = new Map<string, object>([
  // Node keeps one cascaded loader per process; the Worker keeps one per mounted module loader.
  ['internal/modules/esm/loader', { getOrInitializeCascadedLoader: () => requireActiveModuleLoader().cascadedLoader() }],
  ['internal/modules/esm/module_map', { LoadCache, ResolveCache }],
  ['internal/modules/cjs/loader', { Module }],
  ['internal/modules/package_json_reader', packageJsonReader],
  ['internal/bootstrap/realm', realm],
])

/**
 * Answer one Node internal module.
 * @param moduleId - Node internal module id.
 * @returns The Worker's module object for that id.
 * @throws Error with `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` for an id the Worker does not provide.
 */
export function requireBuiltin(moduleId: string): object {
  const module = INTERNAL_MODULES.get(moduleId)
  if (module === undefined) throw notAvailableError('node-addon-require-builtin', `requireBuiltin(${JSON.stringify(moduleId)})`)
  return module
}
