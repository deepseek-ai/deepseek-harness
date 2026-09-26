/** Load the POSIX flock entry on first use so packaging entry scripts start on a checkout that has not built `native/system`. */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

type FlockEntry = typeof import('@deepseek-ai/node-addon-system/flock')

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..', '..')
/** Root package script that compiles the host addon, then the `native/system` script that emits the entry's JavaScript. */
const BUILD_COMMANDS: readonly (readonly string[])[] = [
  ['run', 'build:native-system'],
  ['--dir', 'native/system', 'run', 'build:ts'],
]
const BUILD_COMMAND_TEXT = BUILD_COMMANDS.map(args => `pnpm ${args.join(' ')}`).join(' && ')

/** Loader steps; tests replace the module import, the addon probe, and the build. */
export interface FlockEntryLoaderSteps {
  /** Import `@deepseek-ai/node-addon-system/flock`; rejects with `ERR_MODULE_NOT_FOUND` while its `lib/` is unbuilt. */
  readonly importEntry: () => Promise<FlockEntry>
  /** Whether every binary the host platform package declares in `prebuilds.json` exists. */
  readonly hostAddonBuilt: () => boolean
  /** Compile the host addon and emit the entry's JavaScript; rejects when a build fails. */
  readonly build: () => Promise<void>
}

function isModuleNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ERR_MODULE_NOT_FOUND'
}

/**
 * Create a memoized loader that imports the flock entry, building `native/system` once when its entry or host addon is missing.
 * @param steps - Module import, addon probe, and build used by the loader.
 * @returns Loader that resolves the same entry on every call; a failed load is retried by the next call.
 */
export function createFlockEntryLoader(steps: FlockEntryLoaderSteps): () => Promise<FlockEntry> {
  let loading: Promise<FlockEntry> | undefined
  const load = async (): Promise<FlockEntry> => {
    let entry: FlockEntry | undefined
    try {
      entry = await steps.importEntry()
    } catch (error) {
      if (!isModuleNotFound(error)) throw error
    }
    if (entry !== undefined && steps.hostAddonBuilt()) return entry
    process.stderr.write(`desktop package: flock addon is not built; running ${BUILD_COMMAND_TEXT}\n`)
    await steps.build()
    return steps.importEntry()
  }
  return () => {
    loading ??= load().catch((error: unknown) => { loading = undefined; throw error })
    return loading
  }
}

function hostAddonBuilt(): boolean {
  const { platform, arch } = process
  // flock itself rejects other platforms; the probe only reports missing builds for supported ones.
  if (platform !== 'darwin' && platform !== 'linux') return true
  const entryManifest = createRequire(import.meta.url).resolve('@deepseek-ai/node-addon-system/package.json')
  let prebuilds: string
  try {
    prebuilds = createRequire(entryManifest).resolve(`@deepseek-ai/node-addon-system-${platform}-${arch}/prebuilds.json`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error
    return false
  }
  const manifest = JSON.parse(readFileSync(prebuilds, 'utf8')) as { readonly binaries: readonly { readonly path: string }[] }
  return manifest.binaries.every(binary => existsSync(join(dirname(prebuilds), binary.path)))
}

async function buildNativeSystem(): Promise<void> {
  const pnpmEntry = process.env.npm_execpath
  if (pnpmEntry === undefined || pnpmEntry === '') {
    throw new Error(`desktop package: flock addon is not built; run ${BUILD_COMMAND_TEXT} or invoke this script through a pnpm package command`)
  }
  for (const args of BUILD_COMMANDS) {
    const child = spawn(process.execPath, [pnpmEntry, ...args], { cwd: REPOSITORY_ROOT, stdio: 'inherit' })
    const [code, signal] = await once(child, 'close') as [number | null, NodeJS.Signals | null]
    if (code !== 0) throw new Error(`desktop package: pnpm ${args.join(' ')} exited with ${String(code ?? signal)}`)
  }
}

/**
 * Load `@deepseek-ai/node-addon-system/flock`, building the host addon and the entry's JavaScript through pnpm when either is missing.
 * @returns The flock entry; rejects when a build fails or the script did not run under pnpm.
 */
export const loadFlockEntry = createFlockEntryLoader({
  importEntry: () => import('@deepseek-ai/node-addon-system/flock'),
  hostAddonBuilt,
  build: buildNativeSystem,
})
