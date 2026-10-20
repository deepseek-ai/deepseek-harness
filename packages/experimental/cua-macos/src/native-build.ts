/** Source-checkout preparation and installed native executable resolution. */
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { buildNativeExecutable as compileExecutable, sourceNativePackage } from '@deepseek-ai/dsh-cua/native-build'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

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
  if (platform !== 'darwin' || (architecture !== 'arm64' && architecture !== 'x64')) throw new Error('The macOS Computer Use provider requires macOS on Apple silicon or Intel')
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
  return sourceNativePackage(packageRoot, 'packages/experimental/cua-macos')
}

/**
 * Build the package payload and retain an immutable executable for source-runtime processes.
 * @param spec - Checkout, target, managed process provider and cancellation/deadline limits.
 * @returns Content-addressed runtime path after compilation and complete process cleanup.
 * @throws When compilation, cancellation, resource cleanup or artifact publication fails.
 */
export async function buildNativeExecutable(spec: NativeBuildSpec): Promise<string> {
  const nativeRoot = join(spec.packageRoot, 'native')
  const scratch = join(nativeRoot, '.build', `runtime-${spec.architecture}`)
  return compileExecutable({ ...spec,
    argv: ['/usr/bin/xcrun', 'swift', 'build', '--package-path', nativeRoot,
      '--scratch-path', scratch, '--configuration', 'release', '--product', 'dsh-cua-native',
      '--arch', spec.architecture === 'x64' ? 'x86_64' : 'arm64'],
    outputPath: join(scratch, 'release', 'dsh-cua-native'), executablePath: nativeExecutablePath(spec.packageRoot, spec.architecture),
    lockPath: nativeExecutablePath(spec.packageRoot, spec.architecture),
    retainedDirectory: join(nativeRoot, '.build', 'prepared', spec.architecture), binaryName: 'dsh-cua-native',
  })
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
