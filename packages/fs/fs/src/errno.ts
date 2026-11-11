/**
 * Classification of host errno failures into the shared filesystem codes.
 * @module @deepseek-ai/dsh-fs/errno
 */

import { FsError } from './types.ts'

/**
 * Classify a host filesystem rejection by its errno `code`: ENOENT and ENOTDIR become `FS_NOT_FOUND`,
 * EACCES and EPERM `FS_PERMISSION_DENIED`, EISDIR (a directory where a file is required)
 * `FS_NOT_REGULAR_FILE`, and any other errno `FS_IO_ERROR`, each with the original error as `cause`.
 * Callers that give an errno a narrower meaning, such as absence during a probe, test for it first.
 * @param operation - verb shown in the diagnostic, such as `read`, `stat`, or `list`.
 * @param displayPath - caller-facing path shown in the diagnostic.
 * @param error - the caught value.
 * @returns the classified error; an `FsError` and a value without a string errno `code` (a defect) are returned unchanged.
 */
export function fsErrorFromErrno(operation: string, displayPath: string, error: unknown): unknown {
  if (error instanceof FsError || !(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') return error
  const failure = `cannot ${operation} "${displayPath}"`
  switch (error.code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return new FsError(`${failure}: not found`, 'FS_NOT_FOUND', { cause: error })
    case 'EACCES':
    case 'EPERM':
      return new FsError(`${failure}: permission denied`, 'FS_PERMISSION_DENIED', { cause: error })
    case 'EISDIR':
      return new FsError(`${failure}: not a regular file`, 'FS_NOT_REGULAR_FILE', { cause: error })
    default:
      return new FsError(`${failure}: ${error.message}`, 'FS_IO_ERROR', { cause: error })
  }
}
