/**
 * `node:module` for the worker: `createRequire` hands out the worker module
 * loader's synchronous require. Typert can resolve package exports, and package
 * inventory can discover manifests through `require.resolve.paths()` without
 * either consumer changing for the Worker.
 */
import { requireActiveModuleLoader, type WorkerRequire } from '../../../module-system/module-loader.ts'

/** Node `require` face the harness consumes. */
export type NodeRequire = WorkerRequire

/**
 * Build a `require` bound to a base path or file URL.
 * @param base - directory, file path, or file URL the resolution starts from.
 * @returns the synchronous require face, including `resolve()` and `resolve.paths()`.
 */
export function createRequire(base: string | URL): NodeRequire {
  return requireActiveModuleLoader().createRequire(base)
}

/** Builtin specifiers the module proxy table answers (without the `node:` prefix). */
export const builtinModules = [
  'assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'crypto', 'events', 'fs', 'http', 'module',
  'net', 'os', 'path', 'process', 'stream', 'tty', 'url', 'util', 'worker_threads',
]

/**
 * Whether a specifier names a Node builtin.
 * @param specifier - the module specifier.
 * @returns true for builtin names, with or without the `node:` prefix.
 */
export function isBuiltin(specifier: string): boolean {
  return builtinModules.includes(specifier.replace(/^node:/, ''))
}

/**
 * TypeScript stripping is a Node 22+ loader feature with no worker counterpart.
 * @returns Never — it throws naming the unavailable member.
 */
export function stripTypeScriptTypes(): never {
  throw new Error('web-preview: node:module.stripTypeScriptTypes is not available in the worker host')
}

/**
 * Loader hooks have no meaning here: the worker loader owns resolution.
 * @returns Never — it throws naming the unavailable member.
 */
export function register(): never {
  throw new Error('web-preview: node:module.register is not available in the worker host')
}

/** ESM/CJS export syncing is a no-op: the worker loader materializes CommonJS only. */
export function syncBuiltinESMExports(): void {
  // Nothing to sync: every builtin is a plain module object from the proxy table.
}

/** Erased type peer for the vendored loader's type-only LoadHookContext import. */
export type LoadHookContext = never

/** CommonJS interop marker: the worker loader hands `default` to default imports (see ./builtins.ts). */
export const __esModule = true

/**
 * The `node:module` declarations this module stands in for. `createRequire`
 * keeps this module's own face: the loader's require carries the call and
 * `resolve` the harness uses, not Node's `cache`, `extensions`, and `main`,
 * which describe a CommonJS module registry the worker has no counterpart for.
 */
type NodeFace = Partial<Omit<typeof import('node:module'), 'createRequire'>> & Record<'createRequire', unknown>

/** CommonJS default export: the members `require()` hands a caller of this module. */
export default {
  createRequire, builtinModules, isBuiltin, register, syncBuiltinESMExports, stripTypeScriptTypes,
} satisfies NodeFace
