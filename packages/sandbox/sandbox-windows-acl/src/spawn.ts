/** Restricted-token adapters over the shared Win32 process owner. */

import {
  spawnInheritedJobProcess,
  spawnPipedProcess,
  waitForProcessExit,
} from '@deepseek-ai/dsh-win32-process'
import type {
  NativePtr,
  SpawnedJobProcess,
  SpawnedPipedProcess,
} from '@deepseek-ai/dsh-win32-process'
import type { Win32Bindings } from './ffi.ts'

export { drainPipe } from '@deepseek-ai/dsh-win32-process'

/** Restricted-token child with piped stdio resources. */
export interface SpawnedNative extends SpawnedPipedProcess {}
/** Restricted-token child assigned to a kill-on-close Job. */
export interface SpawnedInherited extends SpawnedJobProcess {}

/**
 * Spawn a restricted-token child with piped stdout/stderr.
 * @param api - ACL/token binding table.
 * @param token - restricted primary token.
 * @param options - command, args, and working directory.
 * @returns process and caller-owned pipe handles.
 */
export function spawnSandboxed(
  api: Win32Bindings,
  token: NativePtr,
  options: { command: string; args: readonly string[]; cwd: string },
): SpawnedNative {
  return spawnPipedProcess(api, { ...options, token })
}

/**
 * Spawn a restricted-token child in a kill-on-close Job with inherited stdio.
 * @param api - ACL/token binding table.
 * @param token - restricted primary token.
 * @param options - command, args, and working directory.
 * @returns process and Job handles after assignment and resume.
 */
export function spawnSandboxedInherited(
  api: Win32Bindings,
  token: NativePtr,
  options: { command: string; args: readonly string[]; cwd: string; controlFileDescriptor?: 7 },
): SpawnedInherited {
  return spawnInheritedJobProcess(api, { ...options, token })
}

/**
 * Wait for a restricted child and close its process handle.
 * @param api - ACL/token binding table.
 * @param process - caller-owned process handle.
 * @returns direct process exit code.
 */
export function waitForExit(api: Win32Bindings, process: NativePtr): number {
  return waitForProcessExit(api, process)
}
