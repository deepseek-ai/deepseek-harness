/** Source-checkout compilation and installed Windows helper resolution. */
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { buildNativeExecutable as compileExecutable, sourceNativePackage } from '@deepseek-ai/dsh-cua/native-build'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** Architectures supported by the Windows helper payload. */
export type NativeArchitecture = 'arm64' | 'x64'

/** Package location, architecture and managed source-build lifetime. */
export interface NativeBuildSpec {
  packageRoot: string
  architecture: NativeArchitecture
  subprocess: Pick<SubprocessRuntime, 'spawn'>
  timeoutMs: number
  graceMs: number
  signal: AbortSignal
}

/**
 * Validate the native Windows runtime host.
 * @param platform Node host platform.
 * @param architecture Node process architecture.
 * @returns Supported Windows architecture.
 */
export function nativeHostArchitecture(platform: string, architecture: string): NativeArchitecture {
  if (platform !== 'win32' || (architecture !== 'arm64' && architecture !== 'x64'))
    throw new Error('The Windows Computer Use provider requires Windows on x64 or ARM64')
  return architecture
}

/**
 * Locate an installed package's helper, using Electron's unpacked payload when applicable.
 * @param packageRoot Directory containing the Windows provider manifest.
 * @param architecture Architecture of the process running the helper.
 * @returns Absolute payload path.
 */
export function nativeExecutablePath(packageRoot: string, architecture: NativeArchitecture): string {
  // TODO: Installed-package paths are placeholders until the Windows package layout is finalized.
  const root = packageRoot.replace(/([\\/])app\.asar(?=[\\/])/u, '$1app.asar.unpacked')
  return join(root, 'native', 'bin', `win-${architecture}`, 'dsh-cua-windows.exe')
}

async function checkedExecutable(executable: string, signal: AbortSignal): Promise<string> {
  await access(executable, constants.X_OK)
  signal.throwIfAborted()
  return executable
}

/**
 * Publish the source helper with dotnet from PATH under the shared compiler lock.
 * @param spec Checkout, target architecture and managed process limits.
 * @returns Published executable after compiler cleanup; build or output validation failures reject.
 */
export async function buildNativeExecutable(spec: NativeBuildSpec): Promise<string> {
  const nativeRoot = join(spec.packageRoot, 'native')
  const runtime = `win-${spec.architecture}`
  const directory = join(nativeRoot, 'bin', runtime)
  return compileExecutable({
    ...spec,
    lockPath: join(nativeRoot, '.build', 'compiler'),
    argv: ['dotnet', 'publish', join(nativeRoot, 'entry', 'CuaWindows.csproj'),
      '--configuration', 'Release', '--runtime', runtime, '--self-contained', 'true',
      '--output', directory, '-p:EnableWindowsTargeting=true'],
    resolveExecutable: () => checkedExecutable(join(directory, 'dsh-cua-windows.exe'), spec.signal),
  })
}

/**
 * Build source helpers on activation; installed packages only resolve their payload.
 * @param spec Package location, architecture and cancellation/deadline limits.
 * @returns Existing executable after preparation; failures reject without fallback to another payload.
 */
export async function prepareNativeExecutable(spec: NativeBuildSpec): Promise<string> {
  spec.signal.throwIfAborted()
  if (await sourceNativePackage(spec.packageRoot, 'packages/experimental/cua-windows')) return buildNativeExecutable(spec)
  return checkedExecutable(nativeExecutablePath(spec.packageRoot, spec.architecture), spec.signal)
}
