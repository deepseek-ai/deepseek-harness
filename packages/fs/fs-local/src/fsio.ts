/**
 * Cordis-free local filesystem mechanics. This provider layer returns validated UTF-8 text,
 * streams large files, and rejects binary data; line windows belong to `dsh-tool-fs`. Writes
 * stage an exclusive owner-only file in a private sibling directory and atomically publish it.
 * @module @deepseek-ai/dsh-fs-local/fsio
 */

import { randomUUID } from 'node:crypto'
import { createReadStream, realpath as realpathCallback } from 'node:fs'
import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import type { BigIntStats, Dirent, Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { TextDecoder, promisify } from 'node:util'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { copyFileDaclWin32, replaceFileWin32 } from './win32.ts'

const BINARY_SAMPLE_BYTES = 8192
const realpath = promisify(realpathCallback.native)
// Bound one non-abortable FileHandle.read so cancellation is observed between chunks.
const DIFF_BASIS_READ_CHUNK_BYTES = 64 * 1024

function isENOENT(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isEEXIST(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

/**
 * A path component that is expected to be a directory is a regular file (e.g.
 * resolving `afile/child.txt` when `afile` is a file). Like `ENOENT`, the target
 * cannot exist — so the resolution/probe paths treat it as "absent" rather than
 * letting a raw Node error escape without the structured `FsError` taxonomy.
 */
function isENOTDIR(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOTDIR'
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/* v8 ignore start -- composes secondary cleanup-failure messages, which require a filesystem/kernel fault after the primary failure. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
/* v8 ignore stop */

function isPermissionError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'EACCES' || error.code === 'EPERM')
}

function throwIfAborted(signal: AbortSignal | undefined, verb: string): void {
  if (signal?.aborted) throw new FsError(`${verb} aborted`, 'FS_ABORTED')
}

/**
 * `readFile` with the supplied signal, translating a mid-read `AbortError` into
 * the seam's structured `FsError('FS_ABORTED')` (Node rejects an aborted
 * `readFile` with a bare `AbortError`, which would otherwise escape the seam's
 * error taxonomy — the streaming/write paths translate it the same way).
 */
async function readFileAbortable(absolutePath: string, verb: 'read' | 'edit', signal?: AbortSignal): Promise<Buffer> {
  try {
    return await readFile(absolutePath, signal ? { signal } : {})
  } catch (error: unknown) {
    /* v8 ignore next 2 -- a non-abort readFile rejection needs a permission/IO fault racing an open file. */
    if (!isAbortError(error)) throw error
    throw new FsError(`${verb} aborted`, 'FS_ABORTED')
  }
}

/** Opaque version token from high-resolution identity and freshness metadata. */
function versionOf(info: BigIntStats): FsVersion {
  return FsVersion(`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`)
}

/**
 * Test hook: lets specs pin the atomic-write temp names (to prove exclusive-open behavior without
 * a name race), override native boundaries, and observe the staged temp file before publication.
 */
export interface FsIoInternals {
  /** Override the host platform for native-publication unit coverage. */
  platform?: NodeJS.Platform
  /** Override the generated private staging-dir name (relative to the target dir). */
  tempDirName?: (writePath: string) => string
  /** Override the generated temp-file name (relative to the private staging dir). */
  tempName?: (writePath: string) => string
  /** Override the Win32 DACL copy boundary. */
  copyFileDacl?: (source: string, destination: string) => Promise<void>
  /** Override the Win32 security-preserving replacement boundary. */
  replaceFile?: (replaced: string, replacement: string) => Promise<void>
  /** Override the hard-link no-replace publication boundary. */
  linkFile?: (existingPath: string, newPath: string) => Promise<void>
  /** Override target inspection after guarded publication fails. */
  inspectPublicationTarget?: (path: string) => Promise<BigIntStats>
  /** Override staging-directory removal for commit-point failure coverage. */
  removeStagingDir?: (stagingDir: string) => Promise<void>
  /** Test hook after the temp file is written/synced but before final chmod+publication. */
  inspectTemp?: (paths: { stagingDir: string; tempPath: string }) => void | Promise<void>
  /** Test hook after raw-read stat preflight and before bounded content I/O. */
  inspectReadBytesAfterStat?: (target: LocalTarget) => void | Promise<void>
}

/** A resolved local path: the absolute path shown to callers and its realpath identity. */
export interface LocalTarget {
  /** Absolute path (symlinks not resolved) — used for display. */
  displayPath: string
  /** Realpath identity — used as the stable target key and the I/O path. */
  targetKey: FsTargetKey
}

/** Result of probing a path: null when it does not exist. */
export interface PathInfo {
  version: FsVersion
  mode: number
  type: 'file' | 'directory' | 'other'
  size: number
}

/** Result of probing a path without following the final symlink component. */
export interface PathLinkInfo {
  version: FsVersion
  mode: number
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
}

/** One local directory child with a resolved target and cheap metadata. */
export interface LocalDirEntry {
  name: string
  type: 'file' | 'directory' | 'other'
  target: LocalTarget
  version?: FsVersion
  size?: number
}

/**
 * Anchor a path using native drive semantics and POSIX physical parent traversal.
 * @param cwd - provider base directory for relative paths.
 * @param path - non-empty requested path.
 * @returns absolute display spelling shared by target resolution and no-follow metadata.
 */
export function localDisplayPath(cwd: string, path: string): string {
  const absoluteCwd = isAbsolute(cwd) ? cwd : `${process.cwd()}${sep}${cwd}`
  const raw = isAbsolute(path) ? path : `${absoluteCwd}${sep}${path}`
  const physicalSpelling = /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(raw) ? raw : resolve(cwd, path)
  /* v8 ignore next -- Native Windows tests cover DOS drive-relative resolution; POSIX preserves physical traversal. */
  return process.platform === 'win32' ? resolve(cwd, path) : physicalSpelling
}

/**
 * Resolve a path to its absolute display path and realpath identity. For a missing target,
 * realpath the nearest existing ancestor and append the missing suffix, preserving identity
 * across symlinked ancestors before and after creation.
 * @param cwd - base directory a relative `path` resolves against.
 * @param path - absolute or relative path; empty/whitespace-only throws `FS_NOT_FOUND`.
 * @returns the absolute display path plus the realpath-derived stable target key.
 */
export async function resolveLocalTarget(cwd: string, path: string): Promise<LocalTarget> {
  if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
  const displayPath = localDisplayPath(cwd, path)
  try {
    // Prefer the file's own realpath (resolves a symlinked file to its target).
    return { displayPath, targetKey: FsTargetKey(await realpath(displayPath)) }
  } catch (error: unknown) {
    // A path component is a file, not a directory (e.g. "afile/child.txt" where
    // "afile" is a regular file): the target can neither exist nor be created,
    // so surface the structured taxonomy instead of a raw Node ENOTDIR.
    /* v8 ignore next -- Windows reports this case as ENOENT and repairs it in the ancestor walk below. */
    if (isENOTDIR(error)) throw new FsError(`cannot resolve "${displayPath}": a parent path segment is not a directory`, 'FS_NOT_FOUND')
    /* v8 ignore next -- non-ENOENT realpath failure needs a permission/IO fault; ENOENT falls through to ancestor resolution. */
    if (!isENOENT(error)) throw error
  }
  // File absent: realpath the nearest existing ancestor and re-append the
  // missing suffix (the file basename plus any not-yet-created intermediate
  // dirs), so the key is stable across creation of those dirs.
  const missing = [basename(displayPath)]
  let ancestor = dirname(displayPath)
  while (true) {
    try {
      const realAncestor = await realpath(ancestor)
      /* v8 ignore next -- POSIX rejects this traversal; Windows normalizes parent segments before filesystem lookup. */
      if (missing.includes('..')) throw new FsError(`cannot resolve "${displayPath}": parent traversal crosses a missing directory`, 'FS_NOT_FOUND')
      // On Windows, realpath of a regular file succeeds where POSIX returns
      // ENOTDIR (the OS reports ENOENT for `regular-file/child`, not ENOTDIR).
      // Stat the ancestor to restore the semantic distinction: a non-directory
      // ancestor means the target passes through a file and can never be created.
      /* v8 ignore start -- native Windows coverage exercises this repair; POSIX reports ENOTDIR before this point. */
      if (process.platform === 'win32') {
        const parentInfo = await stat(realAncestor)
        if (!parentInfo.isDirectory()) {
          throw new FsError(`cannot resolve "${displayPath}": a parent path segment is not a directory`, 'FS_NOT_FOUND')
        }
      }
      /* v8 ignore stop */
      return { displayPath, targetKey: FsTargetKey(join(realAncestor, ...missing)) }
    } catch (error: unknown) {
      /* v8 ignore next -- native Windows coverage exercises the FsError raised by the repair above. */
      if (error instanceof FsError) throw error
      /* v8 ignore next -- a non-ENOENT realpath failure needs a permission/IO fault. */
      if (!isENOENT(error)) throw error
      const parent = dirname(ancestor)
      /* v8 ignore next -- the filesystem root always realpaths, so the walk terminates before parent === ancestor. */
      if (parent === ancestor) return { displayPath, targetKey: FsTargetKey(displayPath) }
      missing.unshift(basename(ancestor))
      ancestor = parent
    }
  }
}

function pathType(info: Stats | BigIntStats): PathInfo['type'] {
  if (info.isFile()) return 'file'
  /* v8 ignore else -- Windows has no special-entry fixture for the non-directory branch. */
  if (info.isDirectory()) return 'directory'
  /* v8 ignore next -- the corresponding special-entry return is covered on POSIX. */
  return 'other'
}

function pathLinkType(info: Stats | BigIntStats): PathLinkInfo['type'] {
  if (info.isSymbolicLink()) return 'symlink'
  return pathType(info)
}

async function probeStats<T extends Stats | BigIntStats>(
  absolutePath: string,
  readStats: (path: string) => Promise<T>,
): Promise<T | null> {
  try {
    return await readStats(absolutePath)
  } catch (error: unknown) {
    // ENOENT (no such file) and ENOTDIR (a parent segment is a file) both mean
    // the target is absent; any other metadata failure is a real permission/IO
    // fault.
    /* v8 ignore next -- a non-ENOENT/ENOTDIR metadata failure needs a permission/IO fault; surface it. */
    if (!isENOENT(error) && !isENOTDIR(error)) throw error
    return null
  }
}

/**
 * Probe a path for its version, mode, type, and size. Null if absent.
 * @param absolutePath - the path to stat (typically a target key; symlinks are followed).
 * @returns the metadata, or null when the path — or a parent segment — does not exist.
 */
export async function probe(absolutePath: string): Promise<PathInfo | null> {
  const info = await probeStats(absolutePath, path => stat(path, { bigint: true }))
  if (!info) return null
  return {
    version: versionOf(info),
    mode: Number(info.mode & 0o777n),
    type: pathType(info),
    size: Number(info.size),
  }
}

/**
 * Probe a path without following the final symlink component.
 * @param absolutePath - the path entry to inspect with `lstat` semantics.
 * @returns path-entry metadata, or null when the entry is absent.
 */
export async function probeNoFollow(absolutePath: string): Promise<PathLinkInfo | null> {
  const info = await probeStats(absolutePath, path => lstat(path, { bigint: true }))
  if (!info) return null
  return {
    version: versionOf(info),
    mode: Number(info.mode & 0o777n),
    type: pathLinkType(info),
    size: Number(info.size),
  }
}

// --- Directory listing ---

function listingIoError(displayPath: string, error: unknown): FsError {
  /* v8 ignore next -- defensive pass-through for races where a child resolver has already produced a structured FsError. */
  if (error instanceof FsError) return error
  /* v8 ignore next -- requires the listed target/parent to disappear between successful preflight and listing/child resolution. */
  if (isENOENT(error) || isENOTDIR(error)) return new FsError(`cannot list "${displayPath}": not found`, 'FS_NOT_FOUND', { cause: error })
  /* v8 ignore next -- Windows chmod does not deny directory listing; POSIX covers permission translation. */
  if (isPermissionError(error)) return new FsError(`cannot list "${displayPath}": permission denied`, 'FS_PERMISSION_DENIED', { cause: error })
  return new FsError(`cannot list "${displayPath}": ${errorMessage(error)}`, 'FS_IO_ERROR', { cause: error })
}

async function resolveListedChildTarget(parent: LocalTarget, name: string): Promise<LocalTarget> {
  const identity = await resolveLocalTarget(parent.targetKey, name)
  return { displayPath: localDisplayPath(parent.displayPath, name), targetKey: identity.targetKey }
}

/**
 * List direct children of a directory in stable name order. Each child includes
 * a resolved target plus stat metadata when still available; file contents are
 * never read.
 * @param target - the resolved directory to list; a missing or non-directory target throws.
 * @param signal - aborts the listing, checked between children (`FS_ABORTED`).
 * @returns one entry per direct child, sorted by name.
 */
export async function listDirectory(target: LocalTarget, signal?: AbortSignal): Promise<LocalDirEntry[]> {
  throwIfAborted(signal, 'list')
  let info: PathInfo | null
  try {
    info = await probe(target.targetKey)
  } catch (error: unknown) {
    throw listingIoError(target.displayPath, error)
  }
  if (!info) throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
  if (info.type !== 'directory') throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')

  let entries: Dirent[]
  try {
    entries = await readdir(target.targetKey, { withFileTypes: true, encoding: 'utf8' })
  } catch (error: unknown) {
    /* v8 ignore next -- requires permission/kernel failure from readdir after a successful directory stat. */
    throw listingIoError(target.displayPath, error)
  }
  throwIfAborted(signal, 'list')

  const result: LocalDirEntry[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    throwIfAborted(signal, 'list')
    try {
      const childTarget = await resolveListedChildTarget(target, entry.name)
      const childInfo = await probe(childTarget.targetKey)
      result.push({
        name: entry.name,
        type: childInfo?.type ?? 'other',
        target: childTarget,
        ...(childInfo ? { version: childInfo.version } : {}),
        ...(childInfo?.type === 'file' ? { size: childInfo.size } : {}),
      })
    } catch (error: unknown) {
      throw listingIoError(localDisplayPath(target.displayPath, entry.name), error)
    }
    throwIfAborted(signal, 'list')
  }
  return result
}

// --- Reading ---

function notTextError(verb: 'read' | 'edit', displayPath: string): FsError {
  return new FsError(`cannot ${verb} "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT')
}

function decodeUtf8(buffer: Uint8Array, verb: 'read' | 'edit', displayPath: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch (error: unknown) {
    /* v8 ignore next 2 -- TextDecoder({fatal}) only throws TypeError on invalid bytes; any other throw is an unreachable runtime fault. */
    if (!(error instanceof TypeError)) throw error
    throw notTextError(verb, displayPath)
  }
}

function decodeUtf8Stream(
  decoder: TextDecoder,
  chunk: Uint8Array | undefined,
  verb: 'read' | 'edit',
  displayPath: string,
): string {
  try {
    return chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode()
  } catch (error: unknown) {
    /* v8 ignore next 2 -- TextDecoder({fatal}) only throws TypeError on invalid bytes; any other throw is an unreachable runtime fault. */
    if (!(error instanceof TypeError)) throw error
    throw notTextError(verb, displayPath)
  }
}

async function statRegularFile(target: LocalTarget, verb: 'read', signal?: AbortSignal): Promise<Stats> {
  throwIfAborted(signal, verb)
  let info: Stats
  try {
    info = await stat(target.targetKey)
  } catch (error: unknown) {
    /* v8 ignore next 2 -- a non-ENOENT stat failure needs a permission/IO fault; only the not-found path is reachable in tests. */
    if (!isENOENT(error)) throw error
    throw new FsError(`cannot ${verb} "${target.displayPath}": not found`, 'FS_NOT_FOUND')
  }
  if (!info.isFile()) throw new FsError(`cannot ${verb} "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  return info
}

/**
 * Read a whole regular UTF-8 text file into a single decoded string. Rejects
 * non-regular files, invalid UTF-8, and NUL-byte binary samples.
 * @param target - the resolved file to read.
 * @param signal - aborts the read (`FS_ABORTED`).
 * @returns the full decoded text, byte-for-byte (no normalization).
 */
export async function readWholeText(target: LocalTarget, signal?: AbortSignal): Promise<string> {
  await statRegularFile(target, 'read', signal)
  const raw = await readFileAbortable(target.targetKey, 'read', signal)
  throwIfAborted(signal, 'read')
  if (raw.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
    throw new FsError(`cannot read "${target.displayPath}": binary file`, 'FS_NOT_TEXT')
  }
  return decodeUtf8(raw, 'read', target.displayPath)
}

/**
 * Read a whole regular file as raw bytes with no decoding or binary rejection.
 * `maxBytes` bounds the complete content: the stat size short-circuits an
 * oversized file before any content I/O, and the stream reads at most one byte
 * beyond the cap so a file growing after stat cannot cause unbounded buffering.
 * @param target - the resolved file to read.
 * @param signal - aborts the read (`FS_ABORTED`).
 * @param maxBytes - inclusive byte cap on the complete content (`FS_TOO_LARGE`).
 * @param internals - test seam for a deterministic post-stat growth race.
 * @returns the full raw content, at most `maxBytes` long.
 */
export async function readWholeBytes(
  target: LocalTarget,
  signal: AbortSignal | undefined,
  maxBytes: number,
  internals: FsIoInternals = {},
): Promise<Uint8Array> {
  const info = await statRegularFile(target, 'read', signal)
  if (info.size > maxBytes) {
    throw new FsError(`cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
  }
  await internals.inspectReadBytesAfterStat?.(target)
  const stream = createReadStream(target.targetKey, {
    end: maxBytes,
    ...signal ? { signal } : {},
  })
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      bytes += chunk.length
      if (bytes > maxBytes) {
        throw new FsError(`cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
      }
      chunks.push(chunk)
    }
  } catch (error: unknown) {
    /* v8 ignore next 2 -- a mid-stream abort needs cancellation racing an active read; pre-abort is deterministic. */
    if (isAbortError(error)) throw new FsError('read aborted', 'FS_ABORTED')
    throw error
  }
  return Buffer.concat(chunks, bytes)
}

/**
 * Read the bytes at `[offset, offset + length)` of a regular file with no
 * decoding or binary rejection. The window is the bound: the stream opens at
 * `offset` and closes after `length` bytes, so no more than the window is ever
 * buffered whatever the file's size; a window at or past the end is empty.
 * @param target - the resolved file to read.
 * @param range - `offset`, the 0-based first byte, and `length`, the largest byte count.
 * @param signal - aborts the read (`FS_ABORTED`).
 * @returns the window's bytes, at most `length` long.
 */
export async function readByteWindow(
  target: LocalTarget,
  range: { offset: number; length: number },
  signal?: AbortSignal,
): Promise<Uint8Array> {
  await statRegularFile(target, 'read', signal)
  if (range.length === 0) return new Uint8Array(0)
  const stream = createReadStream(target.targetKey, {
    start: range.offset,
    end: range.offset + range.length - 1,
    ...signal ? { signal } : {},
  })
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      chunks.push(chunk)
      bytes += chunk.length
    }
  } catch (error: unknown) {
    /* v8 ignore next 2 -- a mid-stream abort needs cancellation racing an active read; pre-abort is deterministic. */
    if (isAbortError(error)) throw new FsError('read aborted', 'FS_ABORTED')
    /* v8 ignore next -- any other stream failure needs an I/O fault after a successful stat. */
    throw error
  }
  return Buffer.concat(chunks, bytes)
}

/**
 * Stream a whole regular UTF-8 text file as decoded text chunks. Same text
 * semantics as {@link readWholeText} (regular-file check, binary/NUL rejection,
 * cross-chunk UTF-8 decoding), but never holds the whole file in memory.
 * @param target - the resolved file to stream.
 * @param signal - aborts the stream, including between chunks (`FS_ABORTED`).
 * @returns decoded text chunks in file order; chunk boundaries carry no meaning.
 */
export async function* streamWholeText(target: LocalTarget, signal?: AbortSignal): AsyncIterable<string> {
  await statRegularFile(target, 'read', signal)
  const stream = createReadStream(target.targetKey, signal ? { signal } : {})
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let sampledBytes = 0

  function scanBinarySample(chunk: Buffer): void {
    if (sampledBytes >= BINARY_SAMPLE_BYTES) return
    const sample = chunk.subarray(0, Math.min(chunk.length, BINARY_SAMPLE_BYTES - sampledBytes))
    if (sample.includes(0)) {
      throw new FsError(`cannot read "${target.displayPath}": binary file`, 'FS_NOT_TEXT')
    }
    sampledBytes += sample.length
  }

  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      scanBinarySample(chunk)
      yield decodeUtf8Stream(decoder, chunk, 'read', target.displayPath)
    }
    yield decodeUtf8Stream(decoder, undefined, 'read', target.displayPath)
  } catch (error: unknown) {
    /* v8 ignore next 4 -- mid-stream errors need an abort/IO fault racing the loop; pre-abort is caught by throwIfAborted. */
    if (isAbortError(error)) throw new FsError('read aborted', 'FS_ABORTED')
    throw error
  }
}

// --- Writing ---

async function removeStagingDirOrThrow(
  stagingDir: string,
  originalError: unknown,
  removeStagingDir: (path: string) => Promise<void>,
): Promise<never> {
  try {
    await removeStagingDir(stagingDir)
  } catch (cleanupError: unknown) {
    /* v8 ignore next 1 -- cleanup failure here needs a second filesystem fault after the primary write failure. */
    throw new FsError(`write failed (${errorMessage(originalError)}) and temp cleanup failed (${errorMessage(cleanupError)})`, 'FS_NOT_FOUND', { cause: originalError })
  }
  throw originalError
}

async function throwGuardedCreateFailure(
  error: unknown,
  absolutePath: string,
  displayPath: string,
  inspectPublicationTarget: (path: string) => Promise<BigIntStats>,
): Promise<never> {
  let existing: BigIntStats | undefined
  try {
    existing = await inspectPublicationTarget(absolutePath)
  } catch (metadataError: unknown) {
    if (!isENOENT(metadataError) && !isENOTDIR(metadataError)) {
      throw new FsError(`cannot write "${displayPath}": ${errorMessage(metadataError)}`, 'FS_IO_ERROR', { cause: metadataError })
    }
  }

  // Link errno values vary by platform and filesystem. Inspect the target entry
  // after failure so a collision is not confused with missing hard-link support.
  if (existing !== undefined) {
    if (!existing.isFile()) {
      throw new FsError(`cannot write "${displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE', { cause: error })
    }
    throw new FsError(
      `cannot overwrite existing "${displayPath}" without reading it first`,
      'FS_NOT_OBSERVED',
      { cause: error },
    )
  }
  if (isEEXIST(error)) {
    throw new FsError(
      `cannot overwrite existing "${displayPath}" without reading it first`,
      'FS_NOT_OBSERVED',
      { cause: error },
    )
  }
  throw new FsError(`cannot write "${displayPath}": ${errorMessage(error)}`, 'FS_IO_ERROR', { cause: error })
}

/**
 * Atomically replace a file through a private, synced staging file in the same directory.
 * POSIX protects the staging directory and file with `0o700` and `0o600`. A new Windows file
 * inherits the destination directory's DACL; a replacement copies the existing target's DACL
 * onto the empty temp before writing and preserves the target descriptor at publication.
 * @param absolutePath - destination; missing parent directories are created.
 * @param content - the full UTF-8 text to write.
 * @param mode - existing destination's POSIX mode to preserve, or `undefined` for a new file;
 * inert as a mode on Windows but identifies replacement security semantics.
 * @param signal - cancellation checked before final publication.
 * @param internals - Test hook for pinning temp names and observing the staged file.
 * @param createIfAbsent - when provided, publish with a hard-link no-replace
 * primitive; a concurrent creator's file is preserved and this write is
 * rejected with `FS_NOT_OBSERVED` using the supplied display path.
 */
export async function writeFileAtomic(
  absolutePath: string,
  content: string,
  mode: number | undefined,
  signal: AbortSignal | undefined,
  internals: FsIoInternals = {},
  createIfAbsent?: { displayPath: string },
): Promise<void> {
  throwIfAborted(signal, 'write')
  const directory = dirname(absolutePath)
  await mkdir(directory, { recursive: true })

  throwIfAborted(signal, 'write')
  const stagingDirName = internals.tempDirName?.(absolutePath) ?? `.${basename(absolutePath)}.${process.pid}.${randomUUID()}.tmpdir`
  const stagingDir = join(directory, stagingDirName)
  const tempName = internals.tempName?.(absolutePath) ?? `${basename(absolutePath)}.tmp`
  const tempPath = join(stagingDir, tempName)
  const platform = internals.platform ?? process.platform
  const copyFileDacl = internals.copyFileDacl ?? copyFileDaclWin32
  const replaceFile = internals.replaceFile ?? replaceFileWin32
  const linkFile = internals.linkFile ?? link
  const inspectPublicationTarget = internals.inspectPublicationTarget
    ?? (path => lstat(path, { bigint: true }))
  const removeStagingDir = internals.removeStagingDir
    ?? (path => rm(path, { recursive: true, force: true }))
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let stagingCreated = false
  try {
    await mkdir(stagingDir, { mode: 0o700 })
    stagingCreated = true
    await chmod(stagingDir, 0o700)

    handle = await open(tempPath, 'wx', 0o600)
    await handle.chmod(0o600)
    if (platform === 'win32' && mode !== undefined) {
      await copyFileDacl(absolutePath, tempPath)
    }
    await handle.writeFile(content, { encoding: 'utf8', ...signal ? { signal } : {} })
    await handle.sync()
    await internals.inspectTemp?.({ stagingDir, tempPath })
    if (mode !== undefined) await handle.chmod(mode)
    await handle.close()
    handle = undefined

    throwIfAborted(signal, 'write')
    if (createIfAbsent !== undefined) {
      try {
        await linkFile(tempPath, absolutePath)
      } catch (error: unknown) {
        await throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget)
      }
    } else if (platform === 'win32' && mode !== undefined) {
      try {
        await replaceFile(absolutePath, tempPath)
      } catch (error: unknown) {
        // If the observed target disappears during staging, the protected DACL
        // already copied to the temp remains authoritative for recreation.
        if (!isENOENT(error)) throw error
        await rename(tempPath, absolutePath)
      }
    } else {
      await rename(tempPath, absolutePath)
    }
    try {
      await removeStagingDir(stagingDir)
    } catch (_committedStagingCleanupFailure) {
      // The target is committed; owner-only staging residue cannot turn that write into a failure.
    }
  } catch (error: unknown) {
    /* v8 ignore next -- abort-mid-write needs a writeFile/signal race; the non-abort (rename/open) side is tested. */
    let failure: unknown = isAbortError(error) ? new FsError('write aborted', 'FS_ABORTED') : error
    /* v8 ignore next 8 -- reached only if writeFile/sync throws with the handle open (IO fault); close-failure is a double fault. */
    if (handle) {
      try {
        await handle.close()
      } catch (closeError: unknown) {
        failure = new FsError(`write failed (${errorMessage(failure)}) and temp close failed (${errorMessage(closeError)})`, 'FS_NOT_FOUND', { cause: failure })
      }
    }
    if (!stagingCreated) throw failure
    return removeStagingDirOrThrow(stagingDir, failure, removeStagingDir)
  }
}

// --- Editing ---

/** Line ending style detected before LF normalization. */
export type LineEndings = 'LF' | 'CRLF'

/**
 * Collapse CRLF to LF — the canonical in-memory form every edit/diff basis
 * uses. Lone `\r` bytes (not followed by `\n`) are left untouched.
 * @param content - decoded text in whatever line-ending style the file had.
 * @returns the text with every `\r\n` pair replaced by `\n`.
 */
function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n')
}

function detectLineEndings(raw: string): LineEndings {
  const sample = raw.slice(0, 4096)
  const crlfCount = sample.split('\r\n').length - 1
  const lfCount = sample.split('\n').length - 1 - crlfCount
  return crlfCount > lfCount ? 'CRLF' : 'LF'
}

/**
 * Convert LF-normalized content back to the line-ending style detected at read
 * time, for write-back. `LF` returns the content unchanged; `CRLF` re-normalizes
 * first so an already-CRLF sequence is never doubled to `\r\r\n`.
 * @param content - the LF-normalized (edited) text.
 * @param lineEndings - the original file's style, as detected by {@link readForEdit}.
 * @returns the text in the original file's line-ending style.
 */
function restoreLineEndings(content: string, lineEndings: LineEndings): string {
  return lineEndings === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n')
}

function countOccurrences(content: string, needle: string): number {
  let count = 0
  let index = 0
  while (true) {
    const found = content.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

/**
 * Read and decode a file for editing: rejects binaries, returns LF-normalized
 * content plus the original line-ending style for write-back.
 * @param absolutePath - the file to read (typically a target key).
 * @param displayPath - the caller-facing path used in error messages.
 * @param signal - aborts the read (`FS_ABORTED`).
 * @returns the LF-normalized content and the detected style to restore on write-back.
 */
export async function readForEdit(
  absolutePath: string,
  displayPath: string,
  signal?: AbortSignal,
): Promise<{ content: string; lineEndings: LineEndings }> {
  throwIfAborted(signal, 'edit')
  const buffer = await readFileAbortable(absolutePath, 'edit', signal)
  throwIfAborted(signal, 'edit')
  if (buffer.includes(0)) throw new FsError(`cannot edit "${displayPath}": binary file`, 'FS_NOT_TEXT')
  const raw = decodeUtf8(buffer, 'edit', displayPath)
  return { content: normalizeLineEndings(raw), lineEndings: detectLineEndings(raw) }
}

/**
 * Best-effort overwrite diff basis. Binary, invalid UTF-8, a file at/above the byte limit,
 * or a file deleted/made unreadable after the caller's preflight returns `null` so the write
 * still succeeds and presentation falls back to a whole-file diff. The bound is enforced on
 * the opened descriptor rather than a prior path stat, so concurrent external replacement or
 * size changes cannot make this helper buffer more than `maxBytes`.
 * @param absolutePath - the file to read (typically a target key).
 * @param maxBytes - exclusive upper bound for bytes held as the contextual-diff basis.
 * @param signal - aborts the read (`FS_ABORTED`); cancellation propagates, unlike I/O failure.
 * @returns the LF-normalized text, or null for a non-regular, at/above-limit, binary, non-UTF-8,
 * descriptor-size-changed, or unreadable file.
 */
export async function readTextForDiff(
  absolutePath: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string | null> {
  throwIfAborted(signal, 'read')
  try {
    const handle = await open(absolutePath, 'r')
    let buffer: Buffer
    let total = 0
    let openedSize = 0
    try {
      throwIfAborted(signal, 'read')
      const info = await handle.stat()
      throwIfAborted(signal, 'read')
      if (!info.isFile()) return null
      if (info.size >= maxBytes) return null
      openedSize = info.size
      // One extra byte detects growth after stat without retaining per-read backing buffers.
      buffer = Buffer.allocUnsafe(openedSize + 1)
      while (total < buffer.length) {
        throwIfAborted(signal, 'read')
        const length = Math.min(buffer.length - total, DIFF_BASIS_READ_CHUNK_BYTES)
        const { bytesRead } = await handle.read(buffer, total, length, null)
        if (bytesRead === 0) break
        total += bytesRead
      }
    } finally {
      await handle.close()
    }
    throwIfAborted(signal, 'read')
    if (total !== openedSize) return null
    const basis = buffer.subarray(0, total)
    if (basis.includes(0)) return null
    try {
      return normalizeLineEndings(new TextDecoder('utf-8', { fatal: true }).decode(basis))
    } catch (error: unknown) {
      /* v8 ignore next 2 -- TextDecoder({fatal}) only throws TypeError on invalid bytes;
       * any other throw is an unreachable runtime fault. */
      if (!(error instanceof TypeError)) throw error
      return null
    }
  } catch (error: unknown) {
    // Cancellation is the caller's intent and still propagates.
    if (error instanceof FsError) throw error
    // A descriptor-phase errno — deleted or made unreadable after the caller's
    // preflight, or a faulted read — costs only the optional basis: a committed
    // write must not fail for a presentation-only pre-read.
    if (error instanceof Error && 'code' in error) return null
    throw error
  }
}

/**
 * Apply a literal replacement to LF-normalized content. Empty or missing search text throws
 * `FS_EDIT_NOT_FOUND`; multiple matches throw `FS_AMBIGUOUS_EDIT` unless `replaceAll` is true.
 * @param content - the current file content, already LF-normalized.
 * @param oldString - literal text to find; CRLF inside it is normalized to LF before
 *   matching.
 * @param newString - literal replacement text, normalized the same way.
 * @param replaceAll - replace every match instead of requiring exactly one.
 * @param displayPath - the caller-facing path used in error messages.
 * @returns the edited LF-normalized content plus how many occurrences were replaced.
 */
export function applyLiteralEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  displayPath: string,
): { content: string; replacements: number } {
  const oldNorm = normalizeLineEndings(oldString)
  if (oldNorm.length === 0) {
    throw new FsError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND')
  }
  const newNorm = normalizeLineEndings(newString)
  const replacements = countOccurrences(content, oldNorm)
  if (replacements === 0) {
    throw new FsError(`old_string was not found in "${displayPath}"`, 'FS_EDIT_NOT_FOUND')
  }
  if (!replaceAll && replacements > 1) {
    throw new FsError(`old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`, 'FS_AMBIGUOUS_EDIT')
  }
  return { content: content.split(oldNorm).join(newNorm), replacements }
}

export { normalizeLineEndings, restoreLineEndings }
