/** Managed native compilation and platform-owned executable resolution. */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { SubprocessOutcome, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** Compiler invocation and lock shared by preparations using the same scratch files. */
interface NativeCompilerBuild {
  packageRoot: string
  subprocess: Pick<SubprocessRuntime, 'spawn'>
  signal: AbortSignal
  timeoutMs: number
  graceMs: number
  argv: string[]
  /** Compiler lock target; shared across outputs that write the same intermediate build files. */
  lockPath: string
}

/**
 * Recognize a declared package directory inside a DSH source checkout.
 * @param packageRoot - Real directory containing the platform package.
 * @param directory - Repository-relative source directory owned by that provider.
 * @returns Whether source compilation is permitted at this location.
 */
export async function sourceNativePackage(packageRoot: string, directory: string): Promise<boolean> {
  const root = resolve(packageRoot, '../../..')
  if (join(root, directory) !== packageRoot) return false
  try {
    const manifest: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    return typeof manifest === 'object' && manifest !== null && 'name' in manifest && manifest.name === '@deepseek-ai/dsh-root'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Run the compiler under its build lock, then resolve the platform-owned executable.
 * @param spec - Compiler and resource limits, with a callback locating the built executable.
 * @returns Platform executable path after managed process cleanup.
 */
export async function buildNativeExecutable(
  spec: NativeCompilerBuild & { resolveExecutable: () => Promise<string> },
): Promise<string> {
  spec.signal.throwIfAborted()
  await mkdir(dirname(spec.lockPath), { recursive: true })
  const signal = AbortSignal.any([spec.signal, AbortSignal.timeout(spec.timeoutMs)])
  return withFileLock(spec.lockPath, async () => {
    await compileNative(spec, signal)
    return spec.resolveExecutable()
  }, { waitMs: spec.timeoutMs, signal })
}

async function compileNative(spec: NativeCompilerBuild, signal: AbortSignal): Promise<void> {
  const handle = spec.subprocess.spawn({
    argv: spec.argv,
    cwd: spec.packageRoot, signal, graceMs: spec.graceMs,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 65_536 }, stderr: { maxBytes: 65_536 } },
  })
  let outcome: SubprocessOutcome
  try { outcome = await handle.done } finally {
    try { handle.terminate() } finally {
      if (!await handle.waitForExit()) throw new Error('Computer use preparation did not release its managed process range')
    }
  }
  signal.throwIfAborted()
  if (outcome.exitCode !== 0 || outcome.signal !== null) {
    const diagnostics = `${handle.collected.stdout?.readFrom(0).text ?? ''}${handle.collected.stderr?.readFrom(0).text ?? ''}`
    throw new Error(`Computer Use native preparation failed (${String(outcome.exitCode)}, ${String(outcome.signal)}): ${diagnostics}`)
  }
}
