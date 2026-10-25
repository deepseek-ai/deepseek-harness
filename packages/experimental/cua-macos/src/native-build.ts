/** Source-checkout preparation and installed native executable resolution. */
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { SubprocessOutcome, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** Architecture names used by the platform-specific native payload. */
export type NativeArchitecture = 'arm64' | 'x64'

/**
 * Validate the host before preparing a platform-specific executable.
 * @param platform - Node host platform.
 * @param architecture - Node host architecture.
 * @returns Supported macOS architecture.
 * @throws When the current host has no native implementation.
 */
export function nativeHostArchitecture(platform: string, architecture: string): NativeArchitecture {
  if (platform !== 'darwin' || (architecture !== 'arm64' && architecture !== 'x64')) throw new Error('Computer use currently requires macOS on Apple silicon or Intel. Windows support is in development')
  return architecture
}

/** Explicit compiler ownership and resource limits for one preparation. */
export interface NativeBuildSpec {
  packageRoot: string
  architecture: NativeArchitecture
  subprocess: Pick<SubprocessRuntime, 'spawn'>
  signal: AbortSignal
  timeoutMs: number
  graceMs: number
}

/**
 * Locate the platform-specific executable owned by the CUA package.
 * @param packageRoot - Directory containing the CUA package manifest.
 * @param architecture - Architecture of the process that will execute the helper.
 * @returns Absolute executable path.
 */
export function nativeExecutablePath(packageRoot: string, architecture: NativeArchitecture): string {
  return join(packageRoot, 'native', 'bin', `darwin-${architecture}`, 'dsh-cua-native')
}

/**
 * Recognize the repository-owned package location before allowing local compilation.
 * @param packageRoot - Real directory containing this package.
 * @returns True only for a CUA package in a DSH source checkout.
 */
export async function isSourcePackage(packageRoot: string): Promise<boolean> {
  const root = resolve(packageRoot, '../../..')
  if (join(root, 'packages/experimental/cua-macos') !== packageRoot) return false
  try {
    const manifest: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    return typeof manifest === 'object' && manifest !== null && 'name' in manifest && manifest.name === '@deepseek-ai/dsh-root'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Build the package payload and retain an immutable executable for source-runtime processes.
 * @param spec - Checkout, target, managed process provider and cancellation/deadline limits.
 * @returns Content-addressed runtime path after compilation and complete process cleanup.
 * @throws When compilation, cancellation, resource cleanup or artifact publication fails.
 */
export async function buildNativeExecutable(spec: NativeBuildSpec): Promise<string> {
  spec.signal.throwIfAborted()
  const executable = nativeExecutablePath(spec.packageRoot, spec.architecture)
  await mkdir(dirname(executable), { recursive: true })
  const signal = AbortSignal.any([spec.signal, AbortSignal.timeout(spec.timeoutMs)])
  return withFileLock(executable, () => compileNative(spec, signal, executable), { waitMs: spec.timeoutMs, signal })
}

async function compileNative(spec: NativeBuildSpec, signal: AbortSignal, executable: string): Promise<string> {
  const nativeRoot = join(spec.packageRoot, 'native')
  const scratch = join(nativeRoot, '.build', `runtime-${spec.architecture}`)
  const handle = spec.subprocess.spawn({
    argv: ['/usr/bin/xcrun', 'swift', 'build', '--package-path', nativeRoot,
      '--scratch-path', scratch, '--configuration', 'release', '--product', 'dsh-cua-native',
      '--arch', spec.architecture === 'x64' ? 'x86_64' : 'arm64'],
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
    throw new Error(`Computer use native preparation failed (${String(outcome.exitCode)}, ${String(outcome.signal)}): ${diagnostics}`)
  }
  const built = await readFile(join(scratch, 'release', 'dsh-cua-native'))
  let previous: Buffer | undefined
  try { previous = await readFile(executable) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  signal.throwIfAborted()
  if (!previous?.equals(built)) await writeFileAtomic(executable, built, { mode: 0o755 })
  const digest = createHash('sha256').update(built).digest('hex')
  const runtime = join(nativeRoot, '.build', 'prepared', spec.architecture, digest, 'dsh-cua-native')
  await mkdir(dirname(runtime), { recursive: true })
  let retained: Buffer | undefined
  try { retained = await readFile(runtime) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (retained && !retained.equals(built)) throw new Error('Computer use retained executable does not match its content digest')
  signal.throwIfAborted()
  if (!retained) await writeFileAtomic(runtime, built, { mode: 0o755 })
  await access(runtime, constants.X_OK)
  return runtime
}

/**
 * Prepare source builds on activation; installed packages must already carry their native payload.
 * @param spec - Native preparation inputs for this host.
 * @returns Ready native executable without requiring a compiler for an installed package.
 */
export async function prepareNativeExecutable(spec: NativeBuildSpec): Promise<string> {
  if (await isSourcePackage(spec.packageRoot)) return buildNativeExecutable(spec)
  const executable = nativeExecutablePath(spec.packageRoot, spec.architecture)
  await access(executable, constants.X_OK)
  spec.signal.throwIfAborted()
  return executable
}
