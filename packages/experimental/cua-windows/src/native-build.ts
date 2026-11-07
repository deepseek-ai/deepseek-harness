/** Source compilation and installed Windows C# helper resolution. */
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { buildNativeExecutable as compileExecutable, sourceNativePackage } from '@deepseek-ai/dsh-cua/native-build'

/** Architectures supported by the Windows helper payload. */
export type NativeArchitecture = 'arm64' | 'x64'

/** Compiler invocation and resource ownership for one Windows payload. */
export interface NativeBuildSpec {
  packageRoot: string
  architecture: NativeArchitecture
  dotnetPath: string
  subprocess: Pick<SubprocessRuntime, 'spawn'>
  signal: AbortSignal
  timeoutMs: number
  graceMs: number
}

/**
 * Validate the runtime host before preparing Windows native code.
 * @param platform - Node host platform.
 * @param architecture - Node process architecture.
 * @returns Supported Windows architecture.
 */
export function nativeHostArchitecture(platform: string, architecture: string): NativeArchitecture {
  if (platform !== 'win32' || (architecture !== 'arm64' && architecture !== 'x64'))
    throw new Error('The Windows Computer Use provider requires Windows on x64 or ARM64')
  return architecture
}

/**
 * Locate the package-owned Windows executable.
 * @param packageRoot - Directory containing the Windows provider manifest.
 * @param architecture - Architecture of the process running the helper.
 * @returns Absolute payload path.
 */
export function nativeExecutablePath(packageRoot: string, architecture: NativeArchitecture): string {
  return join(packageRoot, 'native', 'bin', `win-${architecture}`, 'dsh-cua-windows.exe')
}

/**
 * Publish the self-contained C# application directly into the package payload directory.
 * @param spec - SDK command, target, compiler ownership, and deadlines.
 * @returns Package executable path after compiler cleanup; existing output files can be overwritten.
 */
export function buildNativeExecutable(spec: NativeBuildSpec): Promise<string> {
  const native = join(spec.packageRoot, 'native')
  const executable = nativeExecutablePath(spec.packageRoot, spec.architecture)
  return compileExecutable({ ...spec,
    argv: [spec.dotnetPath, 'publish', join(native, 'entry', 'CuaWindows.csproj'), '--configuration', 'Release',
      '--runtime', `win-${spec.architecture}`, '--self-contained', 'true', '--output', dirname(executable),
      '-p:EnableWindowsTargeting=true'],
    lockPath: join(native, '.build', 'publish'),
    resolveExecutable: async () => {
      await access(executable, constants.X_OK)
      return executable
    },
  })
}

/**
 * Compile only source checkouts; installed packages require their packaged native payload.
 * @param spec - Source build and runtime target inputs.
 * @returns The ready executable path.
 */
export async function prepareNativeExecutable(spec: NativeBuildSpec): Promise<string> {
  if (await sourceNativePackage(spec.packageRoot, 'packages/experimental/cua-windows')) return buildNativeExecutable(spec)
  const executable = nativeExecutablePath(spec.packageRoot, spec.architecture)
  await access(executable, constants.X_OK)
  spec.signal.throwIfAborted()
  return executable
}
