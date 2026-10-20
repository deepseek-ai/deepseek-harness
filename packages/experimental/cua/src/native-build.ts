/** Managed native compilation and immutable executable publication shared by platform providers. */
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { SubprocessOutcome, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** Fully resolved compiler invocation and executable publication locations. */
export interface NativeExecutableBuild {
  packageRoot: string
  subprocess: Pick<SubprocessRuntime, 'spawn'>
  signal: AbortSignal
  timeoutMs: number
  graceMs: number
  argv: string[]
  outputPath: string
  executablePath: string
  lockPath: string
  retainedDirectory: string
  binaryName: string
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
 * Compile, publish, and retain an immutable executable after the compiler exits.
 * @param spec - Compiler, resource limits, and source/payload locations resolved by the platform provider.
 * @returns Content-addressed runtime path after managed process cleanup.
 */
export async function buildNativeExecutable(spec: NativeExecutableBuild): Promise<string> {
  spec.signal.throwIfAborted()
  const executable = spec.executablePath
  await mkdir(dirname(executable), { recursive: true })
  await mkdir(dirname(spec.lockPath), { recursive: true })
  const signal = AbortSignal.any([spec.signal, AbortSignal.timeout(spec.timeoutMs)])
  return withFileLock(spec.lockPath, () => compileNative(spec, signal, executable), { waitMs: spec.timeoutMs, signal })
}

async function compileNative(spec: NativeExecutableBuild, signal: AbortSignal, executable: string): Promise<string> {
  const handle = spec.subprocess.spawn({
    argv: spec.argv,
    cwd: spec.packageRoot, signal, graceMs: spec.graceMs,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 65_536 }, stderr: { maxBytes: 65_536 } },
  })
  let outcome: SubprocessOutcome
  try { outcome = await handle.done } finally {
    try { handle.terminate() } finally {
      await handle.waitForExit()
    }
  }
  signal.throwIfAborted()
  if (outcome.exitCode !== 0 || outcome.signal !== null) {
    const diagnostics = `${handle.collected.stdout?.readFrom(0).text ?? ''}${handle.collected.stderr?.readFrom(0).text ?? ''}`
    throw new Error(`Computer Use native preparation failed (${String(outcome.exitCode)}, ${String(outcome.signal)}): ${diagnostics}`)
  }
  const built = await readFile(spec.outputPath)
  let previous: Buffer | undefined
  try { previous = await readFile(executable) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  signal.throwIfAborted()
  if (!previous?.equals(built)) await writeFileAtomic(executable, built, { mode: 0o755 })
  const digest = createHash('sha256').update(built).digest('hex')
  const runtime = join(spec.retainedDirectory, digest, spec.binaryName)
  await mkdir(dirname(runtime), { recursive: true })
  let retained: Buffer | undefined
  try { retained = await readFile(runtime) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (retained && !retained.equals(built)) throw new Error('Computer Use retained executable does not match its content digest')
  signal.throwIfAborted()
  if (!retained) await writeFileAtomic(runtime, built, { mode: 0o755 })
  await access(runtime, constants.X_OK)
  return runtime
}
