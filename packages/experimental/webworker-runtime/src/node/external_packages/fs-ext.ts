/**
 * `fs-ext` stub: the kernel file-lock bridge the JSONL session backend uses
 * for cross-process write exclusion. The worker is a single-process
 * deployment whose in-process write claim already excludes every writer, so
 * both flock faces succeed immediately; every other entry is loud because
 * nothing in the worker reaches it.
 */
import { notImplementedFail } from '../notImplementedFail.ts'

const MODULE = 'fs-ext'

/**
 * Asynchronous flock face; the single-process worker grants every lock.
 * @param _fd - file descriptor (unused).
 * @param _flags - lock flags (unused).
 * @param callback - completion callback, invoked with no error.
 */
export function flock(_fd: number, _flags: unknown, callback: (error: null) => void): void {
  queueMicrotask(() => { callback(null) })
}

/**
 * Synchronous flock face; the single-process worker grants every lock.
 */
export function flockSync(): void {}

/** Unreached in the worker; loud refusal. */
export const fcntl = notImplementedFail(MODULE, 'fcntl')
/** Unreached in the worker; loud refusal. */
export const fcntlSync = notImplementedFail(MODULE, 'fcntlSync')
/** Unreached in the worker; loud refusal. */
export const seek = notImplementedFail(MODULE, 'seek')
/** Unreached in the worker; loud refusal. */
export const seekSync = notImplementedFail(MODULE, 'seekSync')
/** Unreached in the worker; loud refusal. */
export const statVFS = notImplementedFail(MODULE, 'statVFS')

/** CommonJS interop marker: the worker loader hands `default` to default imports (see ./builtins.ts). */
export const __esModule = true

/** The fs-ext face its consumers read. */
export default { flock, flockSync, fcntl, fcntlSync, seek, seekSync, statVFS }
