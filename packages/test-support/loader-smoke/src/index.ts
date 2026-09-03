/**
 * Shared subprocess harness for keyless example smokes that boot a real
 * `cordis.yml` through an app bin and Cordis Loader.
 *
 * It also owns the mode-aware launch resolver every example subprocess harness shares
 * ({@link resolveExampleLaunch}): booting an example bin from TypeScript source under `tsx` (the
 * zero-build dev path, resolving `@deepseek-ai/dsh-*` / `@cordisjs/*` through the tsconfig `paths`
 * map) or from built `lib/` under plain Node (resolving bare packages through real `exports`, as an
 * installed consumer does, while Node type-strips relative example-local TypeScript plugins).
 *
 * @module @deepseek-ai/dsh-loader-smoke
 */

import { clearedProxyEnv } from '@deepseek-ai/dsh-http-proxy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'

export {
  runFixtureTurn,
  type FixtureTurnOptions,
  type FixtureTurnResult,
} from './agent-turn.ts'

const DEFAULT_PROCESS_TIMEOUT_MS = 30_000

/** Vitest deadline that leaves room for the subprocess-owned 30-second diagnostic timeout. */
export const LOADER_SMOKE_TEST_TIMEOUT_MS = DEFAULT_PROCESS_TIMEOUT_MS + 15_000

/** Which artifact an example bin is booted from: unbuilt `src` via tsx, or built `lib` via plain Node. */
export type ExampleMode = 'src' | 'lib'

/** Environment variable selecting the mode; CI sets it to `lib`, dev leaves it unset (`src`). */
export const EXAMPLE_MODE_ENV = 'DSH_EXAMPLE_MODE'

/**
 * Parse an {@link ExampleMode} from a raw string, defaulting to `src` when absent so an unset
 * environment reproduces the dev/tsx behavior. Throws on any other value rather than silently
 * falling back, so a typo in a gate's env fails loud.
 * @param raw - the raw value; defaults to `process.env.DSH_EXAMPLE_MODE`.
 * @returns the validated mode.
 */
export function resolveExampleMode(raw: string | undefined = process.env[EXAMPLE_MODE_ENV]): ExampleMode {
  switch (raw) {
    case undefined:
    case '':
    case 'src':
      return 'src'
    case 'lib':
      return 'lib'
    default:
      throw new Error(`${EXAMPLE_MODE_ENV} must be 'src' or 'lib', got ${JSON.stringify(raw)}.`)
  }
}

/** Inputs to {@link resolveExampleLaunch}. */
export interface ExampleLaunchOptions {
  /** Absolute path to the example bin's TypeScript source entry (`<pkg>/src/bin.ts`); the `lib` bin is derived from it. */
  readonly srcBin: string
  /** Explicit plain-Node entry for `lib` mode; test fixtures may point this at Node-type-strippable TypeScript. */
  readonly libBin?: string | undefined
  /** Arguments passed after the bin — the config, positional (`[configPath]`) or flagged (`['--config', configPath]`). */
  readonly configArgs?: readonly string[]
  /** The mode to launch in; defaults to {@link resolveExampleMode} of the environment. */
  readonly mode?: ExampleMode
  /** Absolute repo tsconfig whose `paths` map resolves unbuilt workspace imports. Required in `src` mode, ignored in `lib`. */
  readonly tsconfigPath?: string
  /** Select the ESM-only tsx hook instead of the generic loader. */
  readonly sourceImport?: 'tsx/esm'
  /** Extra environment entries the mode-specific ones layer over; the caller then merges the result over `process.env`. */
  readonly env?: NodeJS.ProcessEnv
}

/** The resolved spawn: `spawn(command, args, { env: { ...process.env, ...env } })`. */
export interface ExampleLaunch {
  /** The executable to spawn — always the current Node binary. */
  readonly command: string
  /** Node flags, the resolved bin, then the caller's `configArgs`. */
  readonly args: string[]
  /** Mode-specific environment (`TSX_TSCONFIG_PATH` in `src`, nothing added in `lib`) layered over the caller's `env`. */
  readonly env: NodeJS.ProcessEnv
}

/** Derive the built-lib bin (`<pkg>/lib/<name>.js`) from a source bin (`<pkg>/src/<name>.ts`). */
function toLibBin(srcBin: string): string {
  const markerLength = '/src/'.length
  const cut = Math.max(srcBin.lastIndexOf('/src/'), srcBin.lastIndexOf('\\src\\'))
  if (cut === -1) {
    throw new Error(`resolveExampleLaunch: expected a "/src/" segment or Windows equivalent in bin path ${JSON.stringify(srcBin)}.`)
  }
  const separator = srcBin.slice(cut, cut + 1)
  const tail = srcBin.slice(cut + markerLength).replace(/\.ts$/, '.js')
  return `${srcBin.slice(0, cut)}${separator}lib${separator}${tail}`
}

/**
 * Resolve how to spawn an example bin in the selected mode.
 *
 * `src` yields `node --import <tsx> <srcBin> <configArgs>` with `TSX_TSCONFIG_PATH` set so the
 * tsconfig `paths` map resolves workspace imports to source. `lib` yields
 * `node <libBin> <configArgs>` under plain Node with no tsx and no paths map, so
 * bare package plugins resolve through real package `exports` into built `lib/`; relative example-local
 * TypeScript plugins remain source files loaded through Node's built-in type stripping. Bare resolution
 * requires the config to live below a workspace that declares its `cordis.yml` package dependencies.
 *
 * @param options - the source bin, config arguments, mode, and environment.
 * @returns the command, argument vector, and mode-specific environment to spawn with.
 */
export function resolveExampleLaunch(options: ExampleLaunchOptions): ExampleLaunch {
  const mode = options.mode ?? resolveExampleMode()
  const configArgs = options.configArgs ?? []
  // A smoke launches a real `dsh` against local fixtures, so it must not inherit the machine's
  // network policy: the harness honors the proxy environment, and a runner that exports one would
  // send a fixture-server request to a proxy that cannot resolve the fixture host. `undefined`
  // removes the name from the child rather than setting it empty.
  const env: NodeJS.ProcessEnv = { ...clearedProxyEnv(), ...options.env }

  if (mode === 'src') {
    if (options.tsconfigPath === undefined) {
      throw new Error("resolveExampleLaunch: 'src' mode needs tsconfigPath for the workspace paths map.")
    }
    const tsxLoader = options.sourceImport === 'tsx/esm'
      ? import.meta.resolve('tsx/esm')
      : import.meta.resolve('tsx')
    env.TSX_TSCONFIG_PATH = options.tsconfigPath
    return { command: process.execPath, args: ['--import', tsxLoader, options.srcBin, ...configArgs], env }
  }

  return { command: process.execPath, args: [options.libBin ?? toLibBin(options.srcBin), ...configArgs], env }
}

/** Inputs that vary between real-Loader example smokes. */
export interface LoaderSmokeOptions {
  /** Human-readable example name used in failure diagnostics. */
  readonly label: string
  /** Prefix for the isolated temporary process cwd. */
  readonly tempDirPrefix: string
  /** Existing parent for the generated cwd; defaults to the platform temporary directory. */
  readonly tempDirParent?: string
  /** Absolute app-bin source path (`<pkg>/src/bin.ts`); the `lib` bin is derived from it. */
  readonly binScript: string
  /** Explicit plain-Node entry for `lib` mode; intended for test fixtures outside a package `src/` tree. */
  readonly libBinScript?: string | undefined
  /** Absolute real Loader config path, passed as the sole bin argument by default. */
  readonly configPath: string
  /** Complete argv after the bin path; overrides the default `[configPath]`. */
  readonly binArgs?: readonly string[]
  /** Absolute repo tsconfig path used for unbuilt workspace-package resolution (required in `src` mode). */
  readonly tsconfigPath: string
  /** Boot from source via tsx (`src`) or built lib via plain Node (`lib`); defaults to the environment's mode. */
  readonly mode?: ExampleMode
  /** Environment overrides layered over the parent and isolated DSH homes. */
  readonly env?: Readonly<NodeJS.ProcessEnv>
  /** Process deadline override for harness tests. */
  readonly processTimeoutMs?: number
  /** Optional world-state setup run in the isolated cwd before process start. */
  readonly prepare?: (cwd: string) => Promise<void> | void
  /** Optional world-state assertion run in the isolated cwd before cleanup. */
  readonly inspect?: (cwd: string) => Promise<void> | void
  /**
   * Exact process exit code this smoke expects; defaults to `0`. Scenarios
   * pinning a designed failure surface (a one-shot turn ending in an error
   * result) declare its nonzero exit here, and a run that exits any other
   * way — including succeeding — still fails the smoke.
   */
  readonly expectedExitCode?: number
}

/** Captured output from a Loader smoke that exited successfully. */
export interface LoaderSmokeResult {
  /** Complete stdout after clean exit. */
  readonly stdout: string
  /** Complete stderr after clean exit. */
  readonly stderr: string
}

/**
 * Boot one real Loader tree from an isolated cwd, close stdin immediately, and
 * await a clean exit. The helper owns process kill and temp-directory cleanup on
 * every outcome, and picks src/lib via {@link resolveExampleLaunch}.
 * @param options - example paths, mode, environment, and diagnostic identity.
 * @returns captured stdout and stderr after a zero exit.
 */
export async function runLoaderSmoke(options: LoaderSmokeOptions): Promise<LoaderSmokeResult> {
  const cwd = await mkdtemp(join(options.tempDirParent ?? tmpdir(), options.tempDirPrefix))
  const processTimeoutMs = options.processTimeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS
  try {
    await options.prepare?.(cwd)
    const launch = resolveExampleLaunch({
      srcBin: options.binScript,
      libBin: options.libBinScript,
      configArgs: options.binArgs ?? [options.configPath],
      ...options.mode !== undefined ? { mode: options.mode } : {},
      tsconfigPath: options.tsconfigPath,
      env: {
        DSH_HOME: join(cwd, '.dsh'),
        DSH_AGENTS_HOME: join(cwd, '.agents'),
        ...options.env,
      },
    })
    // `input: ''` writes nothing and closes stdin — the fixture-visible
    // stdin-close contract. `reject: false` folds spawn errors, the SIGKILL
    // deadline, and nonzero exits into independent result fields, so the
    // diagnostics below embed both streams on every failure.
    const result = await execa(launch.command, launch.args, {
      cwd,
      env: launch.env,
      input: '',
      timeout: processTimeoutMs,
      killSignal: 'SIGKILL',
      reject: false,
      stripFinalNewline: false,
    })
    if (result.timedOut) {
      throw new Error(`${options.label} did not exit within ${processTimeoutMs / 1_000}s. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }
    const expectedExitCode = options.expectedExitCode ?? 0
    if (result.exitCode !== expectedExitCode) {
      throw new Error(`${options.label} exited ${String(result.exitCode)} (expected ${expectedExitCode}). stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }
    await options.inspect?.(cwd)
    return { stdout: result.stdout, stderr: result.stderr }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}
