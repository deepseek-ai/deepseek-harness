/**
 * The `process` global the worker needs before any VFS module runs. Cordis
 * reads `process.env` and `process.versions.node` while the Loader is
 * constructed, and `cordis.yml` keeps its `!!js process.*` expressions, so the
 * configuration bytes stay identical to the Node deployment. Third-party Node
 * packages use the presence of `process.title` to avoid browser-only globals.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/node/globals/process
 */
import { requireActiveModuleLoader } from '../../module-system/module-loader.ts'
import { processAlive, signalProcess } from '../process-table.ts'

/** Construction inputs for {@link installProcessGlobal}. */
export interface ProcessShimOptions {
  /** Virtual root reported by `cwd()`. */
  readonly cwd: string
  /** Environment the tree reads; `DSH_HOME` belongs here. */
  readonly env: Readonly<Record<string, string>>
  /** Argument vector reported to the tree. */
  readonly argv?: readonly string[]
}

/** The members this shim publishes. */
export interface ProcessShim {
  readonly env: Record<string, string>
  readonly argv: string[]
  readonly execArgv: string[]
  /** Virtual host identity; spawning this path reports ENOENT because Node execution is unavailable. */
  readonly execPath: string
  /** Node process identity used by dependencies for environment detection. */
  readonly title: string
  /**
   * Node 22 `process.getBuiltinModule`: the worker's module proxy for a
   * builtin id (`fs`, `node:fs`), or undefined for anything else — it never
   * resolves image modules.
   * @param id - Builtin module id, with or without the `node:` prefix.
   * @returns the proxied builtin, or undefined.
   */
  getBuiltinModule(id: string): unknown
  readonly platform: string
  readonly arch: string
  readonly pid: number
  readonly version: string
  readonly versions: Record<string, string>
  cwd(): string
  /**
   * Signal one command started through the `node:child_process` shim. Signal
   * `0` is the liveness probe the subprocess service polls a process tree
   * with; a negative pid addresses the group, which here holds exactly the one
   * command that leads it.
   * @param pid - the target pid, negative for its group.
   * @param signal - signal name, or `0` to probe without delivering one.
   * @returns true once the signal is recorded.
   * @throws Error with `code: 'ESRCH'` when no such command is running.
   */
  kill(pid: number, signal?: NodeJS.Signals | 0): boolean
  nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]): void
  readonly stdout: { write(chunk: string): boolean }
  readonly stderr: { write(chunk: string): boolean }
  on(): ProcessShim
  off(): ProcessShim
  once(): ProcessShim
  prependListener(): ProcessShim
  prependOnceListener(): ProcessShim
  removeListener(): ProcessShim
  removeAllListeners(): ProcessShim
  listeners(): unknown[]
  listenerCount(): number
  setMaxListeners(): ProcessShim
  emit(): boolean
  readonly hrtime: { bigint(): bigint }
  uptime(): number
  exit(code?: number): void
}

/**
 * Publish `globalThis.process`.
 *
 * `versions.node` is `0.0.0` on purpose: it makes Cordis's
 * `ModuleLoader.fromInternal()` return undefined instead of reaching for Node
 * internals, which is what lets the worker install its own module seam.
 * @param options - Root, environment, and argument vector.
 * @returns The published object, for the module proxy table.
 */
export function installProcessGlobal(options: ProcessShimOptions): ProcessShim {
  const start = performance.now()
  const write = (target: 'log' | 'error') => (chunk: string): boolean => {
    console[target](chunk.replace(/\n$/, ''))
    return true
  }
  const shim: ProcessShim = {
    env: { ...options.env },
    argv: [...(options.argv ?? ['node', 'dsh-webworker'])],
    execArgv: [],
    execPath: '/dsh/bin/node',
    title: 'dsh-webworker',
    platform: 'linux',
    arch: 'x64',
    pid: 1,
    version: 'v0.0.0',
    versions: { node: '0.0.0' },
    cwd: () => options.cwd,
    getBuiltinModule: (id: string): unknown => {
      let resolution
      try {
        resolution = requireActiveModuleLoader().resolve(id, '/')
      } catch {
        // No loader mounted yet, or an id that resolves nowhere: Node answers
        // undefined for non-builtins instead of throwing.
        return undefined
      }
      return resolution.kind === 'static' ? resolution.factory() : undefined
    },
    kill: (pid: number, signal: NodeJS.Signals | 0 = 'SIGTERM'): boolean => {
      if (signal === 0) {
        if (processAlive(pid)) return true
        const error = new Error('kill ESRCH') as NodeJS.ErrnoException
        error.code = 'ESRCH'
        error.syscall = 'kill'
        throw error
      }
      return signalProcess(pid, signal)
    },
    nextTick: (callback, ...args) => { queueMicrotask(() => { callback(...args) }) },
    stdout: { write: write('log') },
    stderr: { write: write('error') },
    on: () => shim,
    off: () => shim,
    once: () => shim,
    prependListener: () => shim,
    prependOnceListener: () => shim,
    removeListener: () => shim,
    removeAllListeners: () => shim,
    listeners: () => [],
    listenerCount: () => 0,
    setMaxListeners: () => shim,
    emit: () => false,
    hrtime: { bigint: () => BigInt(Math.round((performance.now() - start) * 1e6)) },
    uptime: () => (performance.now() - start) / 1000,
    exit: (code?: number) => { console.warn(`webworker process: exit(${String(code ?? 0)}) requested; the worker keeps running`) },
  }
  ;(globalThis as { process?: unknown }).process = shim
  return shim
}
