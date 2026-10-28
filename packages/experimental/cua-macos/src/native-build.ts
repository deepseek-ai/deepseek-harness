/** Source-checkout preparation and installed macOS application resolution. */
import { constants } from 'node:fs'
import { access, mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { SubprocessOutcome, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'

const NativeApplication = z.object({ bundle: z.string().regex(/^[a-f0-9]{64}$/) }).strict()

/** Architecture names used by the platform-specific native payload. */
export type NativeArchitecture = 'arm64' | 'x64'

/**
 * Validate the host before preparing a platform-specific application.
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
 * Resolve the immutable application selected by a packaged or source-build receipt.
 * @param directory - Architecture-specific directory containing current.json and application generations.
 * @returns Executable inside the selected application bundle.
 * @throws When the receipt is invalid or the application executable is missing.
 */
export async function nativeExecutablePath(directory: string): Promise<string> {
  const receipt = NativeApplication.parse(JSON.parse(await readFile(join(directory, 'current.json'), 'utf8')))
  const executable = join(directory, receipt.bundle, 'DSH Computer Use.app', 'Contents', 'MacOS', 'dsh-cua-native')
  await access(executable, constants.X_OK)
  return executable
}

/**
 * Recognize the repository-owned package location before allowing local compilation.
 * @param packageRoot - Real directory containing the CUA package manifest.
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
 * Build and sign an immutable helper application with the selected Apple developer tools.
 * @param spec - Checkout, target, managed process provider and cancellation/deadline limits.
 * @returns Executable inside the prepared application, after complete compiler cleanup.
 * @throws When preparation, cancellation, resource cleanup or receipt validation fails.
 */
export async function buildNativeExecutable(spec: NativeBuildSpec): Promise<string> {
  spec.signal.throwIfAborted()
  const nativeRoot = join(spec.packageRoot, 'native')
  const directory = join(nativeRoot, '.build', 'prepared', spec.architecture)
  const signal = AbortSignal.any([spec.signal, AbortSignal.timeout(spec.timeoutMs)])
  await mkdir(join(nativeRoot, '.build'), { recursive: true })
  return withFileLock(join(nativeRoot, '.build', 'application-build'), async () => {
    const handle = spec.subprocess.spawn({
      argv: ['/usr/bin/xcrun', 'python3', join(nativeRoot, 'build_app.py'),
        '--scratch-path', join(nativeRoot, '.build', `runtime-${spec.architecture}`),
        '--output-directory', directory, '--arch', spec.architecture === 'x64' ? 'x86_64' : 'arm64'],
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
      throw new Error(`Computer use native preparation failed (${String(outcome.exitCode)}, ${String(outcome.signal)}): ${diagnostics}`)
    }
    return nativeExecutablePath(directory)
  }, { waitMs: spec.timeoutMs, signal })
}

/**
 * Prepare source builds on activation; installed packages carry their signed application.
 * @param spec - Native preparation inputs for this host.
 * @returns Executable inside a ready application without compiling or re-signing an installed package.
 */
export async function prepareNativeExecutable(spec: NativeBuildSpec): Promise<string> {
  if (await isSourcePackage(spec.packageRoot)) return buildNativeExecutable(spec)
  const executable = await nativeExecutablePath(join(spec.packageRoot, 'native', 'bin', `darwin-${spec.architecture}`))
  spec.signal.throwIfAborted()
  return executable
}
