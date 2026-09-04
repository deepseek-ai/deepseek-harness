/**
 * The Node-compatibility table, in one place. Two consumers share it, and they
 * must resolve to the same module instances:
 *   - the worker vite build aliases these specifiers for code bundled statically
 *     into the worker (vendored loader, Connection, …);
 *   - the worker module loader answers `require('node:fs')` from VFS-loaded
 *     modules out of this table, before bare-name resolution.
 * Anything absent here fails loudly at resolution instead of resolving to an
 * empty module. `process` is deliberately absent: the worker host installs that
 * global itself and fills it into this table at assembly time.
 *
 * Import paths carry the classification: `./implemented/<module>.ts` backs the
 * module's real semantics over a worker data source, while `./mock/<module>.ts`
 * is a structural placeholder whose calls report the missing capability. File
 * names match their Node module specifiers exactly, nesting included.
 *
 * Every value is a {@link StaticModuleFactory}, so the loader reads a table
 * entry only when a `require` names that specifier. What a factory defers is the
 * table read, not module evaluation: each one answers a namespace object of the
 * static ESM graph below, which the worker bundle evaluates at load like any
 * other import. Deferring a shim's own start-up cost therefore belongs inside
 * that shim, on the path that first needs it.
 */
import * as nodeAsyncHooks from './builtin_modules/implemented/async_hooks.ts'
import * as nodeBuffer from './builtin_modules/implemented/buffer.ts'
import * as nodeCrypto from './builtin_modules/implemented/crypto.ts'
import * as nodeDnsPromises from './builtin_modules/mock/dns/promises.ts'
import * as nodeEvents from './builtin_modules/implemented/events.ts'
import * as nodeFs from './builtin_modules/implemented/fs.ts'
import * as nodeFsPromises from './builtin_modules/implemented/fs/promises.ts'
import * as nodeHttp from './builtin_modules/implemented/http.ts'
import * as nodeModule from './builtin_modules/implemented/module.ts'
import * as nodeOs from './builtin_modules/implemented/os.ts'
import * as nodePath from './builtin_modules/implemented/path.ts'
import * as nodePerfHooks from './builtin_modules/implemented/perf_hooks.ts'
import * as nodeStream from './builtin_modules/implemented/stream.ts'
import * as nodeTimersPromises from './builtin_modules/implemented/timers/promises.ts'
import * as nodeTty from './builtin_modules/implemented/tty.ts'
import * as nodeUrl from './builtin_modules/implemented/url.ts'
import * as nodeUtil from './builtin_modules/implemented/util.ts'
import * as nodeUtilTypes from './builtin_modules/implemented/util/types.ts'
import * as nodeZlib from './builtin_modules/implemented/zlib.ts'
import * as nodeChildProcess from './builtin_modules/implemented/child_process.ts'
import * as nodeNet from './builtin_modules/mock/net.ts'
import * as nodeSqlite from './builtin_modules/mock/sqlite.ts'
import * as nodeVm from './builtin_modules/mock/vm.ts'
import * as nodeWorkerThreads from './builtin_modules/mock/worker_threads.ts'
import * as fsExt from './external_packages/fs-ext.ts'
import * as koffi from './external_packages/koffi.ts'
import * as nodePty from './external_packages/node-pty.ts'
import * as piAi from './external_packages/pi-ai.ts'
import * as ripgrep from './external_packages/ripgrep.ts'
import * as sharp from './external_packages/sharp.ts'
import * as ws from './external_packages/ws.ts'
import { REPLACED_EXTERNAL_PACKAGES } from './external_packages/replaced-externals.ts'
import type { StaticModuleFactory } from '../module-system/module-loader.ts'

/** Builtin modules, keyed with and without the `node:` prefix. */
const BUILTINS: Record<string, StaticModuleFactory> = {
  async_hooks: () => nodeAsyncHooks,
  buffer: () => nodeBuffer,
  child_process: () => nodeChildProcess,
  crypto: () => nodeCrypto,
  'dns/promises': () => nodeDnsPromises,
  events: () => nodeEvents,
  fs: () => nodeFs,
  'fs/promises': () => nodeFsPromises,
  http: () => nodeHttp,
  module: () => nodeModule,
  net: () => nodeNet,
  os: () => nodeOs,
  path: () => nodePath,
  'path/posix': () => nodePath,
  perf_hooks: () => nodePerfHooks,
  sqlite: () => nodeSqlite,
  stream: () => nodeStream,
  'timers/promises': () => nodeTimersPromises,
  tty: () => nodeTty,
  url: () => nodeUrl,
  util: () => nodeUtil,
  'util/types': () => nodeUtilTypes,
  vm: () => nodeVm,
  worker_threads: () => nodeWorkerThreads,
  zlib: () => nodeZlib,
}

/** External npm packages replaced wholesale (structural not-implemented stubs and fakes). */
const EXTERNALS: Record<string, StaticModuleFactory> = {
  'fs-ext': () => fsExt,
  'koffi': () => koffi,
  'sharp': () => sharp,
  'node-pty': () => nodePty,
  'ws': () => ws,
  '@vscode/ripgrep': () => ripgrep,
  '@earendil-works/pi-ai': () => piAi,
}

/**
 * Prefixes whose every subpath resolves to one replacement module. The loader
 * matches the longest prefix after its exact table misses, so pi-ai's
 * `/providers/*` and `/api/*.lazy` entries need no enumeration.
 */
export const REPLACED_PREFIXES: Record<string, StaticModuleFactory> = {
  '@earendil-works/pi-ai/': () => piAi,
}

// One list, two consumers: a package replaced here must also be kept out of the
// VFS image, so any divergence fails at worker start rather than at first require.
const declared = [...REPLACED_EXTERNAL_PACKAGES].sort().join(',')
const wired = Object.keys(EXTERNALS).sort().join(',')
if (declared !== wired) {
  throw new Error(`web-preview: replaced-external lists diverge — declared [${declared}] vs wired [${wired}]`)
}

/**
 * Build the specifier → factory table the worker module loader consults first.
 * @returns every replaced specifier, including its `node:`-prefixed alias.
 */
export function createNodeBuiltins(): Record<string, StaticModuleFactory> {
  const table: Record<string, StaticModuleFactory> = { ...EXTERNALS }
  for (const [name, factory] of Object.entries(BUILTINS)) {
    table[name] = factory
    table[`node:${name}`] = factory
  }
  return table
}
