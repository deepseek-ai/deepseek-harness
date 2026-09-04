/**
 * Durable whole-generation publication for JSONL Session artifacts.
 *
 * Format packages transform parsed JSON values. This module owns the physical
 * encoding, exact source identity, immutable generation files, and exclusive
 * current-generation publication for both configured JSONL suffixes.
 * @module @deepseek-ai/dsh-session-persistence-jsonl/generation
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  link as fsLink,
  lstat as fsLstat,
  open as fsOpen,
  readFile as fsReadFile,
  readdir as fsReaddir,
  rm as fsRm,
  stat as fsStat,
  type FileHandle,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { JsonlCompression } from './format.ts'
import { generationLogFilename, logSuffix } from './format.ts'
import { publishNewFileWin32 } from './win32.ts'
import {
  compressZstdFrame,
  createZstdFrameDecoder,
  decompressZstdFrame,
  decompressZstdPrefix,
  scanZstdFrames,
} from './zstd.ts'

/** Parsed JSONL values supplied to the format catalog. */
export interface JsonlDecodedGeneration {
  readonly header: Record<string, unknown>
  readonly rows: readonly unknown[]
}

/** Current JSONL values returned by the format catalog for physical encoding. */
export interface JsonlCurrentGeneration extends JsonlDecodedGeneration {}

/** Pure adapter between backend-owned JSONL framing and the format catalog. */
export interface JsonlGenerationFormatAdapter {
  readonly currentVersion: number
  /** Convert one detached historical generation to exact current JSON values. */
  migrate(source: JsonlDecodedGeneration): JsonlCurrentGeneration
  /** Validate one decoded current generation, including after committed reopen. */
  validateCurrent(candidate: JsonlCurrentGeneration): void
  /** Classify a supported-version artifact that policy refuses to migrate. */
  isUnsupportedMigrationError?(error: unknown): error is Error
}

/** Inputs for ensuring one already-resolved generation has a current successor. */
export interface EnsureJsonlGenerationOptions {
  /** Immutable generation selected by the backend resolver. */
  readonly sourcePath: string
  /** Version selected from the source filename and independently checked against its header. */
  readonly sourceVersion: number
  /** Canonical filename for `format.currentVersion` in the same Session directory. */
  readonly currentPath: string
  readonly compression: JsonlCompression
  readonly format: JsonlGenerationFormatAdapter
  /** Validate one selected historical header's identity before any migration write. */
  readonly validateHistoricalHeader?: (
    header: Readonly<Record<string, unknown>>,
  ) => void | Promise<void>
  readonly signal?: AbortSignal
}

/** Result of current classification or exclusive publication. */
export type EnsureJsonlGenerationResult =
  | {
    readonly status: 'current'
    readonly version: number
    readonly path: string
    readonly snapshot: JsonlPhysicalSnapshot
  }
  | {
    readonly status: 'migrated'
    readonly fromVersion: number
    readonly toVersion: number
    readonly path: string
    readonly sourcePath: string
    readonly snapshot: JsonlPhysicalSnapshot
  }

/** A future physical header was readable, but this writer cannot interpret it. */
export class JsonlGenerationNewerVersionError extends Error {
  override readonly name = 'JsonlGenerationNewerVersionError'

  /**
   * @param storedVersion - version read from the highest stored generation.
   * @param currentVersion - version this build writes.
   * @param storedId - minimally decoded identity used in the refusal diagnostic.
   */
  constructor(
    readonly storedVersion: number,
    readonly currentVersion: number,
    readonly storedId: string,
  ) {
    super(`session log format v${storedVersion} is newer than current v${currentVersion}`)
  }
}

/** A historical artifact is intact, but the format edge refuses its contents. */
export class JsonlGenerationUnsupportedMigrationError extends Error {
  override readonly name = 'JsonlGenerationUnsupportedMigrationError'

  /**
   * @param fromVersion - unchanged source generation version.
   * @param reason - format-edge refusal.
   */
  constructor(
    readonly fromVersion: number,
    readonly reason: Error,
  ) {
    super(reason.message, { cause: reason })
  }
}

/** A current-generation filename already names different or invalid bytes. */
export class JsonlGenerationTargetConflictError extends Error {
  override readonly name = 'JsonlGenerationTargetConflictError'

  /**
   * @param path - immutable target that prevented exclusive publication.
   * @param reason - why the existing target cannot be accepted.
   */
  constructor(
    readonly path: string,
    readonly reason: Error,
  ) {
    super(`current session generation already exists at "${path}": ${reason.message}`, { cause: reason })
  }
}

/** Stat identity captured together with exact generation bytes. */
export interface JsonlPhysicalIdentity {
  readonly dev: bigint
  readonly ino: bigint
  readonly size: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
}

/** One revision-stable physical artifact read reusable by the immediate backend hook. */
export interface JsonlPhysicalSnapshot {
  readonly bytes: Buffer
  readonly identity: JsonlPhysicalIdentity
  readonly headerValue: Record<string, unknown>
  readonly headerRecord: Buffer
}

/** Exact bytes of one stable file revision together with the stat identity that proved it stable. */
export interface StablePhysicalFile {
  readonly bytes: Buffer
  readonly identity: JsonlPhysicalIdentity
}

interface JsonlPhysicalHeader {
  readonly value: Record<string, unknown>
  readonly record: Buffer
}

interface DecodedPhysicalJsonl {
  readonly bytes: Buffer
  readonly torn: boolean
}

interface GenerationFileSystem {
  open(path: string, flags: string, mode?: number): Promise<FileHandle>
  readFile(path: string, signal?: AbortSignal): Promise<Buffer>
  readdir(path: string): Promise<string[]>
  stat(path: string): Promise<JsonlPhysicalIdentity>
  lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>
  link(existingPath: string, newPath: string): Promise<void>
  rm(path: string): Promise<void>
}

type GenerationBarrierPhase =
  | 'before-source-check'
  | 'after-publication'

interface JsonlGenerationInternals {
  readonly fs: GenerationFileSystem
  readonly randomToken: () => string
  readonly platform: NodeJS.Platform
  readonly publishNewWin32: typeof publishNewFileWin32
  readonly barrier: (phase: GenerationBarrierPhase, attempt: number) => void | Promise<void>
}

type JsonlGenerationTestOverrides = Partial<Omit<JsonlGenerationInternals, 'fs'>> & {
  readonly fs?: Partial<GenerationFileSystem>
}

const defaultFileSystem: GenerationFileSystem = {
  open: (path, flags, mode) => fsOpen(path, flags, mode),
  readFile: (path, signal) => fsReadFile(path, signal === undefined ? undefined : { signal }),
  readdir: path => fsReaddir(path),
  stat: path => fsStat(path, { bigint: true }),
  lstat: path => fsLstat(path),
  link: fsLink,
  rm: path => fsRm(path, { force: true }),
}

const defaultInternals: JsonlGenerationInternals = {
  fs: defaultFileSystem,
  randomToken: () => randomBytes(8).toString('hex'),
  platform: process.platform,
  publishNewWin32: publishNewFileWin32,
  barrier: () => {},
}

function isEEXIST(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
}

/** Whether a filesystem-owned failure should retain its original errno and path. */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof (error as NodeJS.ErrnoException | null)?.code === 'string'
}

function identity(value: JsonlPhysicalIdentity): string {
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':')
}

function fingerprint(value: JsonlPhysicalIdentity, bytes: Buffer): string {
  return `${identity(value)}:${createHash('sha256').update(bytes).digest('hex')}`
}

/**
 * Read one stable revision of a JSONL file with a single retry. If an append
 * overlaps both reads, return the second read's committed pre-read prefix
 * instead of starving behind a continuous writer.
 * @param path - the generation file to read.
 * @param signal - optional cancellation for the stat/read work.
 * @returns the stable bytes (or the committed prefix) and their stat identity.
 */
export async function readStableJsonlFile(
  path: string,
  signal?: AbortSignal,
): Promise<StablePhysicalFile> {
  return readStableSnapshot(path, signal, defaultFileSystem)
}

async function readStableSnapshot(
  path: string,
  signal: AbortSignal | undefined,
  fs: GenerationFileSystem,
): Promise<StablePhysicalFile> {
  signal?.throwIfAborted()
  let before = await fs.stat(path)
  for (let attempt = 0; ; attempt += 1) {
    const bytes = await fs.readFile(path, signal)
    signal?.throwIfAborted()
    const after = await fs.stat(path)
    if (identity(before) === identity(after)) {
      signal?.throwIfAborted()
      return { bytes, identity: after }
    }
    if (attempt === 1) {
      return { bytes: bytes.subarray(0, Number(before.size)), identity: before }
    }
    before = after
  }
}

/** Parse the version discriminator without validating any version-specific field. */
function storedVersion(header: unknown): number {
  if (typeof header !== 'object' || header === null || Array.isArray(header)) {
    throw new Error('corrupt session log: first line is not a JSON object')
  }
  const version = (header as { version?: unknown }).version
  if (!Number.isSafeInteger(version) || (version as number) < 0 || Object.is(version, -0)) {
    throw new Error('corrupt session log: header version is not a non-negative safe integer')
  }
  return version as number
}

function storedId(header: unknown): string {
  return String((header as { id?: unknown }).id)
}

function parseJson(text: string, subject: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`corrupt session log: ${subject} is not valid JSON`, { cause: error })
  }
}

function parseGeneration(bytes: Buffer, recoverSuffix = false): JsonlDecodedGeneration {
  /* v8 ignore next -- decodePhysicalJsonl supplies a non-empty newline-terminated prefix. */
  if (bytes.length === 0 || bytes.at(-1) !== 0x0A) {
    throw new Error('empty or header-less session log')
  }
  const records = bytes.toString('utf8').slice(0, -1).split('\n')
  const parsedHeader = parseJson(records[0] as string, 'header line')
  storedVersion(parsedHeader)
  const rows: unknown[] = []
  let issue: Error | undefined
  for (const [index, record] of records.slice(1).entries()) {
    let row: unknown
    try {
      row = parseJson(record, `row ${index + 1}`)
    } catch (error) {
      if (!recoverSuffix) throw error
      issue ??= error as Error
      continue
    }
    if (issue !== undefined) {
      if (typeof row === 'object' && row !== null
        && (row as { type?: unknown }).type === 'turn/end') throw issue
      continue
    }
    rows.push(row)
  }
  return { header: parsedHeader as Record<string, unknown>, rows }
}

function stringifyJson(value: unknown, subject: string): string {
  let text: unknown
  try {
    text = JSON.stringify(value)
  } catch (error) {
    throw new Error(`${subject} is not lossless JSON`, { cause: error })
  }
  if (typeof text !== 'string') throw new Error(`${subject} is not lossless JSON`)
  return text
}

function encodeLogicalJsonl(generation: JsonlCurrentGeneration): Buffer {
  const records = [
    stringifyJson(generation.header, 'migrated session header'),
    ...generation.rows.map((row, index) => stringifyJson(row, `migrated session row ${index + 1}`)),
  ]
  return Buffer.from(`${records.join('\n')}\n`)
}

function assertIndependentHeaderFrame(plaintext: Buffer): void {
  if (plaintext.length === 0 || plaintext.indexOf(0x0A) !== plaintext.length - 1) {
    throw new Error('corrupt Zstandard session log: first frame is not exactly one header line')
  }
}

async function decodeZstdJsonl(bytes: Buffer, signal?: AbortSignal): Promise<DecodedPhysicalJsonl> {
  signal?.throwIfAborted()
  const { frames, tornStart } = scanZstdFrames(bytes)
  /* v8 ignore next -- the independent header probe already established the first frame. */
  if (frames.length === 0) throw new Error('empty or header-less Zstandard session log')
  const complete: Buffer[] = []
  for (const [index, frame] of frames.entries()) {
    signal?.throwIfAborted()
    const plaintext = await decompressZstdFrame(bytes.subarray(frame.start, frame.end))
    if (index === 0) assertIndependentHeaderFrame(plaintext)
    complete.push(plaintext)
  }
  const completeBytes = Buffer.concat(complete)
  if (completeBytes.at(-1) !== 0x0A) {
    throw new Error('corrupt Zstandard session log: complete frame contains a torn JSONL record')
  }
  if (tornStart === undefined) return { bytes: completeBytes, torn: false }

  let recovered = Buffer.alloc(0)
  try {
    recovered = Buffer.from(await decompressZstdPrefix(bytes.subarray(tornStart)))
  } catch {
    /* v8 ignore next -- an abort racing decoder failure is timing-dependent */
    if (signal?.aborted) signal.throwIfAborted()
    // A structurally torn frame may produce no plaintext; prior frames remain valid.
  }
  signal?.throwIfAborted()
  const newline = recovered.lastIndexOf(0x0A)
  return {
    bytes: newline === -1
      ? completeBytes
      : Buffer.concat([completeBytes, recovered.subarray(0, newline + 1)]),
    torn: true,
  }
}

async function decodePhysicalJsonl(
  bytes: Buffer,
  compression: JsonlCompression,
  signal?: AbortSignal,
): Promise<DecodedPhysicalJsonl> {
  if (compression === 'zstd') return decodeZstdJsonl(bytes, signal)
  signal?.throwIfAborted()
  const newline = bytes.lastIndexOf(0x0A)
  /* v8 ignore next -- physical header classification already found a newline in the same stable bytes. */
  if (newline === -1) throw new Error('empty or header-less session log')
  return { bytes: bytes.subarray(0, newline + 1), torn: newline + 1 !== bytes.length }
}

async function encodePhysicalJsonl(
  logical: Buffer,
  generation: JsonlCurrentGeneration,
  compression: JsonlCompression,
): Promise<Buffer> {
  if (compression === 'none') return logical
  const header = Buffer.from(`${stringifyJson(generation.header, 'migrated session header')}\n`)
  const headerFrame = await compressZstdFrame(header)
  if (generation.rows.length === 0) return headerFrame
  const body = logical.subarray(header.length)
  return Buffer.concat([headerFrame, await compressZstdFrame(body)])
}

function readRawHeader(bytes: Buffer): JsonlPhysicalHeader {
  const newline = bytes.indexOf(0x0A)
  if (newline === -1) throw new Error('empty or header-less session log')
  const record = bytes.subarray(0, newline + 1)
  const value = parseJson(record.subarray(0, -1).toString('utf8'), 'header line')
  storedVersion(value)
  return { value: value as Record<string, unknown>, record }
}

function readZstdHeader(bytes: Buffer, signal?: AbortSignal): JsonlPhysicalHeader {
  signal?.throwIfAborted()
  const first = scanZstdFrames(bytes, 1).frames[0]
  if (first === undefined) throw new Error('empty or header-less Zstandard session log')
  const decoder = createZstdFrameDecoder()
  const decodedFrames = decoder.decode(bytes, [first])
  try {
    const decoded = decodedFrames.next()
    /* v8 ignore next -- one complete frame yields once or the decoder throws. */
    if (decoded.done) throw new Error('empty or header-less Zstandard session log')
    signal?.throwIfAborted()
    assertIndependentHeaderFrame(decoded.value)
    const record = Buffer.from(decoded.value)
    const value = parseJson(record.subarray(0, -1).toString('utf8'), 'header line')
    storedVersion(value)
    return { value: value as Record<string, unknown>, record }
  } finally {
    decodedFrames.return()
    decoder.close()
  }
}

function readPhysicalHeader(
  bytes: Buffer,
  compression: JsonlCompression,
  signal: AbortSignal | undefined,
): JsonlPhysicalHeader {
  if (compression === 'zstd') return readZstdHeader(bytes, signal)
  return readRawHeader(bytes)
}

function assertGenerationPaths(
  sourcePath: string,
  sourceVersion: number,
  currentPath: string,
  currentVersion: number,
  compression: JsonlCompression,
): string {
  const expectedSource = generationLogFilename(sourceVersion, compression)
  const expectedCurrent = generationLogFilename(currentVersion, compression)
  if (basename(sourcePath) !== expectedSource) {
    throw new Error(`resolved JSONL source path must end with "${expectedSource}": ${sourcePath}`)
  }
  if (basename(currentPath) !== expectedCurrent) {
    throw new Error(`current JSONL generation path must end with "${expectedCurrent}": ${currentPath}`)
  }
  if (dirname(sourcePath) !== dirname(currentPath)) {
    throw new Error('source and current JSONL generations must share one Session directory')
  }
  return logSuffix(compression)
}

async function syncDirectory(path: string, internals: JsonlGenerationInternals): Promise<void> {
  /* v8 ignore next -- Windows namespace operations request write-through directly. */
  if (internals.platform === 'win32') return
  const handle = await internals.fs.open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeSyncedTemp(
  currentPath: string,
  suffix: string,
  bytes: Buffer,
  internals: JsonlGenerationInternals,
): Promise<string> {
  for (;;) {
    const path = join(dirname(currentPath), `session.migration.${internals.randomToken()}${suffix}.tmp`)
    let handle: FileHandle
    try {
      handle = await internals.fs.open(path, 'wx', 0o600)
    } catch (error) {
      if (isEEXIST(error)) continue
      throw error
    }
    let failure: unknown
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } catch (error: unknown) {
      failure = error
    }
    try {
      await handle.close()
    } catch (error: unknown) {
      failure = failure === undefined
        ? error
        : new AggregateError([failure, error], `failed to write and close migration stage "${path}"`)
    }
    if (failure !== undefined) {
      const writeError = failure instanceof Error
        ? failure
        : new Error('migration stage write failed with a non-Error rejection', { cause: failure })
      try {
        await internals.fs.rm(path)
      } catch (cleanupError: unknown) {
        throw new AggregateError([writeError, cleanupError], `failed to clean migration stage "${path}"`)
      }
      throw writeError
    }
    return path
  }
}

/** Remove one temporary file without hiding the operation failure that made it disposable. */
async function removeTemporary(
  path: string,
  primaryFailure: unknown,
  internals: JsonlGenerationInternals,
): Promise<void> {
  try {
    await internals.fs.rm(path)
  } catch (cleanupFailure: unknown) {
    if (primaryFailure === undefined) throw cleanupFailure
    throw new AggregateError(
      [primaryFailure, cleanupFailure],
      `failed to clean migration temporary "${path}" after an earlier failure`,
    )
  }
}

/** Remove a redundant stage after the target has been validated as committed. */
async function removeCommittedTemporary(
  path: string,
  internals: JsonlGenerationInternals,
): Promise<void> {
  try {
    await internals.fs.rm(path)
  } catch {
    // The validated target owns the committed bytes; a redundant link cannot turn success into failure.
  }
}

async function validatePhysicalCurrent(
  path: string,
  compression: JsonlCompression,
  format: JsonlGenerationFormatAdapter,
  signal: AbortSignal | undefined,
  internals: JsonlGenerationInternals,
): Promise<JsonlPhysicalSnapshot> {
  const snapshot = await readStableSnapshot(path, signal, internals.fs)
  const decoded = await decodePhysicalJsonl(snapshot.bytes, compression, signal)
  if (decoded.torn) throw new Error('staged current session generation has a torn physical tail')
  const generation = parseGeneration(decoded.bytes)
  if (storedVersion(generation.header) !== format.currentVersion) {
    throw new Error(`staged session generation is not current v${format.currentVersion}`)
  }
  format.validateCurrent(generation)
  const headerEnd = decoded.bytes.indexOf(0x0A)
  /* v8 ignore next -- parseGeneration already required the header newline. */
  if (headerEnd === -1) throw new Error('empty or header-less session log')
  return {
    ...snapshot,
    headerValue: generation.header,
    headerRecord: Buffer.from(decoded.bytes.subarray(0, headerEnd + 1)),
  }
}

async function publishCurrentExclusive(
  staged: string,
  currentPath: string,
  internals: JsonlGenerationInternals,
): Promise<boolean> {
  if (internals.platform === 'win32') {
    try {
      await internals.publishNewWin32(staged, currentPath)
      return true
    } catch (error) {
      /* v8 ignore else -- native helper tests own non-collision Win32 failures. */
      if (isEEXIST(error)) return false
      /* v8 ignore next -- the filesystem error is already complete. */
      throw error
    }
  }
  try {
    await internals.fs.link(staged, currentPath)
  } catch (error) {
    /* v8 ignore else -- a non-collision filesystem error propagates unchanged. */
    if (isEEXIST(error)) return false
    /* v8 ignore next -- the filesystem error is already complete. */
    throw error
  }
  await syncDirectory(dirname(currentPath), internals)
  return true
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('current-generation validation failed with a non-Error rejection', {
    cause: error,
  })
}

async function reopenExpectedCurrent(
  currentPath: string,
  expectedBytes: Buffer,
  compression: JsonlCompression,
  format: JsonlGenerationFormatAdapter,
  signal: AbortSignal | undefined,
  checkCanonicalTargetName: boolean,
  internals: JsonlGenerationInternals,
): Promise<JsonlPhysicalSnapshot> {
  try {
    if (checkCanonicalTargetName) {
      const expectedName = basename(currentPath)
      const names = await internals.fs.readdir(dirname(currentPath))
      if (!names.includes(expectedName)) {
        const noncanonical = names.find(name => name.toLowerCase() === expectedName.toLowerCase())
        if (noncanonical !== undefined) {
          throw new Error(`target resolves to noncanonical directory entry "${noncanonical}"`)
        }
      }
    }
    const info = await internals.fs.lstat(currentPath)
    if (info.isSymbolicLink() || !info.isFile()) {
      const kind = info.isSymbolicLink() ? 'symbolic link' : 'non-regular file'
      throw new Error(`target is a ${kind}`)
    }
    const snapshot = await validatePhysicalCurrent(currentPath, compression, format, signal, internals)
    if (snapshot.bytes.length < expectedBytes.length
      || !snapshot.bytes.subarray(0, expectedBytes.length).equals(expectedBytes)) {
      throw new Error('target bytes do not begin with the migrated generation')
    }
    return snapshot
  } catch (error: unknown) {
    if (signal?.aborted) signal.throwIfAborted()
    if (isErrnoException(error)) throw error
    throw new JsonlGenerationTargetConflictError(currentPath, asError(error))
  }
}

function withOverrides(overrides: JsonlGenerationTestOverrides): JsonlGenerationInternals {
  return {
    ...defaultInternals,
    ...overrides,
    fs: { ...defaultFileSystem, ...overrides.fs },
  }
}

async function ensureCurrent(
  options: EnsureJsonlGenerationOptions,
  internals: JsonlGenerationInternals,
): Promise<EnsureJsonlGenerationResult> {
  const { sourcePath, sourceVersion, currentPath, compression, format, signal } = options
  const suffix = assertGenerationPaths(
    sourcePath,
    sourceVersion,
    currentPath,
    format.currentVersion,
    compression,
  )
  let attempt = 0
  for (;;) {
    attempt += 1
    signal?.throwIfAborted()
    const source = await readStableSnapshot(sourcePath, signal, internals.fs)
    const quickHeader = readPhysicalHeader(source.bytes, compression, signal)
    const quickVersion = storedVersion(quickHeader.value)
    if (quickVersion !== sourceVersion) {
      throw new Error(
        `resolved JSONL source filename identifies v${sourceVersion}, but its header identifies v${quickVersion}: `
        + sourcePath,
      )
    }
    if (sourceVersion > format.currentVersion) {
      throw new JsonlGenerationNewerVersionError(sourceVersion, format.currentVersion, storedId(quickHeader.value))
    }
    if (sourceVersion === format.currentVersion) {
      return {
        status: 'current',
        version: quickVersion,
        path: sourcePath,
        snapshot: { ...source, headerValue: quickHeader.value, headerRecord: quickHeader.record },
      }
    }
    const validation = options.validateHistoricalHeader?.(quickHeader.value)
    if (validation !== undefined) await validation

    const decodedSource = await decodePhysicalJsonl(source.bytes, compression, signal)
    const parsedSource = parseGeneration(decodedSource.bytes, true)
    const fromVersion = storedVersion(parsedSource.header)
    /* v8 ignore next -- both headers come from the same stable physical snapshot. */
    if (fromVersion !== quickVersion) throw new Error('session format changed within one stable physical snapshot')
    const sourceFingerprint = fingerprint(source.identity, source.bytes)

    let migrated: JsonlCurrentGeneration
    try {
      migrated = format.migrate(parsedSource)
    } catch (error: unknown) {
      if (format.isUnsupportedMigrationError?.(error) === true) {
        throw new JsonlGenerationUnsupportedMigrationError(fromVersion, error)
      }
      throw error
    }
    if (storedVersion(migrated.header) !== format.currentVersion) {
      throw new Error(`format migration returned v${storedVersion(migrated.header)}, expected v${format.currentVersion}`)
    }
    const logical = encodeLogicalJsonl(migrated)
    const physical = await encodePhysicalJsonl(logical, migrated, compression)
    let staged = await writeSyncedTemp(currentPath, suffix, physical, internals)
    let failure: unknown
    try {
      await validatePhysicalCurrent(staged, compression, format, signal, internals)
      await internals.barrier('before-source-check', attempt)
      const beforePublish = await readStableSnapshot(sourcePath, signal, internals.fs)
      if (fingerprint(beforePublish.identity, beforePublish.bytes) !== sourceFingerprint) continue

      const published = await publishCurrentExclusive(staged, currentPath, internals)
      if (published && internals.platform === 'win32') staged = ''
      await internals.barrier('after-publication', attempt)
      signal?.throwIfAborted()
      const committed = await reopenExpectedCurrent(
        currentPath,
        physical,
        compression,
        format,
        signal,
        !published,
        internals,
      )
      if (staged !== '') {
        await removeCommittedTemporary(staged, internals)
        staged = ''
      }
      return {
        status: 'migrated',
        fromVersion,
        toVersion: format.currentVersion,
        path: currentPath,
        sourcePath,
        snapshot: committed,
      }
    } catch (error: unknown) {
      failure = error
      throw error
    } finally {
      if (staged !== '') await removeTemporary(staged, failure, internals)
    }
  }
}

/**
 * Ensure one resolved generation has a current-format successor. Current input reads one
 * coherent physical snapshot, inspects only its independently readable header,
 * invokes no body decoder or migration callback, and returns that snapshot for
 * the immediate body-reading backend hook. Historical input remains unchanged;
 * only a previously absent current filename can be published.
 * @param options - resolved source and target, configured encoding, format adapter, and cancellation.
 * @returns whether the source was already current or which immutable successor was published.
 */
export function ensureJsonlGenerationCurrent(
  options: EnsureJsonlGenerationOptions,
): Promise<EnsureJsonlGenerationResult> {
  return ensureCurrent(options, defaultInternals)
}

/** Private deterministic filesystem, platform, and race seams for package tests. */
export const __jsonlGenerationTest = {
  ensure(
    options: EnsureJsonlGenerationOptions,
    overrides: JsonlGenerationTestOverrides,
  ): Promise<EnsureJsonlGenerationResult> {
    return ensureCurrent(options, withOverrides(overrides))
  },
}
