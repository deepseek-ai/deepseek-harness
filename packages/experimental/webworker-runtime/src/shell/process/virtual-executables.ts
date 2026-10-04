/** Virtual executable registry used by the Worker process launcher. */
import { basename } from '../../module-system/posix-path.ts'
import type { ShellFileSystem } from '../types.ts'
import { LANDLOCK_EXECUTABLE } from './landlock.ts'
import { XDG_OPEN_EXECUTABLE } from './xdg-open.ts'

/** Completed virtual executable invocation. */
export interface VirtualExecutableExit {
  readonly kind: 'exit'
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Invocation delegated to the normal Worker command runner after preparation. */
export interface VirtualExecutableDelegate {
  readonly kind: 'delegate'
  readonly argv: readonly string[]
  readonly filesystem: ShellFileSystem
  readonly missingExecutable: VirtualExecutableExit
}

/** Result of preparing an asynchronous virtual executable invocation. */
export type VirtualExecutablePreparation = VirtualExecutableExit | VirtualExecutableDelegate

/** Result available to the synchronous child-process face. */
export type VirtualExecutableSyncResult = VirtualExecutableExit | { readonly kind: 'asynchronous' }

/** One executable implemented by the Worker instead of an operating-system binary. */
export interface VirtualExecutable {
  /** Platform executable name, independent of package-manager installation path. */
  readonly name: string
  /**
   * Prepare an invocation or complete it without entering the command runner.
   * @param args - Arguments after the executable path.
   * @param context - Working directory and ambient Worker filesystem.
   * @returns The completed result or delegated command and filesystem.
   */
  prepare(
    args: readonly string[],
    context: { readonly cwd: string; readonly filesystem: ShellFileSystem },
  ): Promise<VirtualExecutablePreparation>
  /**
   * Handle the subset that can complete synchronously.
   * @param args - Arguments after the executable path.
   * @returns A completed result or the asynchronous marker.
   */
  runSync(args: readonly string[]): VirtualExecutableSyncResult
}

const EXECUTABLES: ReadonlyMap<string, VirtualExecutable> = new Map([
  [LANDLOCK_EXECUTABLE.name, LANDLOCK_EXECUTABLE],
  [XDG_OPEN_EXECUTABLE.name, XDG_OPEN_EXECUTABLE],
])

/**
 * Resolve a Worker platform executable by logical name.
 * @param path - Bare name or executable path passed to `spawn`.
 * @returns Its implementation, or undefined for the normal command table.
 */
export function virtualExecutable(path: string): VirtualExecutable | undefined {
  return EXECUTABLES.get(basename(path))
}
