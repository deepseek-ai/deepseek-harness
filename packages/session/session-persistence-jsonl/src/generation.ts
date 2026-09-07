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
import { performance } from 'node:perf_hooks'
import { pipeline, Readable } from 'node:stream'
import { scheduler } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { constants, createZstdCompress } from 'node:zlib'
import { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { BlockAssembler, expandAssistantStream } from '@deepseek-ai/dsh-llm'
import type {
  SessionFormatArtifact,
  SessionFormatJsonValue,
  SessionFormatRestore,
} from '@deepseek-ai/dsh-session-format'
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import type { JsonlCompression } from './format.ts'
import { generationLogFilename, logSuffix, SessionLogScanner } from './format.ts'
import { publishNewFileWin32 } from './win32.ts'
import {
  compressZstdFrame,
  createZstdFrameDecoder,
  decompressZstdPrefix,
  scanZstdFrames,
} from './zstd.ts'

/** Internal scheduling bounds: preserve old decode cadence and cap each synchronous encode slice. */
const MIGRATION_DECODE_YIELD_INTERVAL_MS = 500
const MIGRATION_WORK_CHUNK_BYTES = 1024 * 1024
const MIGRATION_WRITE_CHUNK_BYTES = 4 * 1024 * 1024
const ZSTD_CHECKSUM_OPTIONS = {
  chunkSize: MIGRATION_WORK_CHUNK_BYTES,
  params: { [constants.ZSTD_c_checksumFlag]: 1 },
}

/** Pure adapter between backend-owned JSONL framing and the format catalog. */
export interface JsonlGenerationFormatAdapter {
  readonly currentVersion: number
  /** Create the single-pass codec and migration state for a historical header. */
  createRestore(header: Record<string, unknown>): SessionFormatRestore
  /** Encode one current header record without materializing body rows. */
  encodeHeader(header: SessionFormatArtifact['header'], inheritedEventCount: number): SessionFormatJsonValue
  /** Encode one current event record. */
  encodeEvent(event: SessionFormatArtifact['events'][number]): SessionFormatJsonValue
  /** Classify a supported-version artifact that policy refuses to migrate. */
  isUnsupportedMigrationError?(error: unknown): error is Error
}

/** Inputs for preparing one historical generation and publishing its current successor later. */
export interface PrepareJsonlMigrationOptions {
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
  /** Validate the staged file in an isolated worker before publication. */
  readonly verifyCurrentFile: (
    path: string,
    compression: JsonlCompression,
    expectedId: string,
    expectedEventCount: number,
    expectedPrefix?: JsonlExpectedPrefix,
    signal?: AbortSignal,
  ) => Promise<JsonlVerifiedGeneration>
  readonly signal?: AbortSignal
}

/** Small physical identity returned by an isolated generation verifier. */
export interface JsonlVerifiedGeneration {
  readonly identity: JsonlPhysicalIdentity
  readonly bytes: number
  readonly digest: string
}

/** Physical byte prefix already proven to be a valid complete generation. */
export interface JsonlExpectedPrefix {
  readonly bytes: number
  readonly digest: string
}

/** A historical source changed after its single decode and migration pass. */
export class JsonlGenerationSourceChangedError extends Error {
  override readonly name = 'JsonlGenerationSourceChangedError'

  /** @param path - historical generation whose revision changed. */
  constructor(readonly path: string) {
    super(`historical session generation changed during migration: "${path}"`)
  }
}

/** Current logical state prepared independently from durable publication. */
export interface PreparedJsonlMigration {
  readonly sourceIdentity: JsonlPhysicalIdentity
  readonly artifact: SessionFormatArtifact
  /** Encode, verify, and exclusively publish once; every call shares the same success or failure. */
  publish(): Promise<JsonlPhysicalIdentity>
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

/** Exact bytes of one stable file revision together with the stat identity that proved it stable. */
export interface StablePhysicalFile {
  readonly bytes: Buffer
  readonly identity: JsonlPhysicalIdentity
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

/** Dependency overrides for an isolated generation runtime. */
export type JsonlGenerationRuntimeOverrides = Partial<Omit<JsonlGenerationInternals, 'fs'>> & {
  readonly fs?: Partial<GenerationFileSystem>
}

/** Bound generation operations used by production defaults and deterministic tests. */
export interface JsonlGenerationRuntime {
  readStable(path: string, signal?: AbortSignal): Promise<StablePhysicalFile>
  prepare(options: PrepareJsonlMigrationOptions): Promise<PreparedJsonlMigration>
  verify(
    path: string,
    compression: JsonlCompression,
    expectedId: string,
    expectedEventCount: number,
    expectedPrefix?: JsonlExpectedPrefix,
  ): Promise<JsonlVerifiedGeneration>
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
  return defaultGenerationRuntime.readStable(path, signal)
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

function parseJson(text: string, subject: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`corrupt session log: ${subject} is not valid JSON`, { cause: error })
  }
}

/** Incremental JSONL parser that retains only one cross-frame record fragment. */
class MigratingJsonlRows {
  private fragments: Buffer[] = []
  private fragmentBytes = 0
  private rowIndex = 0
  private issue: Error | undefined

  constructor(private readonly restore: SessionFormatRestore) {}

  /** Consume plaintext bytes following the independently decoded header. */
  write(chunk: Buffer): void {
    /* jscpd:ignore-start -- migration parsing and readable-log scanning own different recovery and byte-accounting state. */
    let lineStart = 0
    for (
      let newline = chunk.indexOf(0x0A);
      newline !== -1;
      newline = chunk.indexOf(0x0A, lineStart)
    ) {
      const fragment = chunk.subarray(lineStart, newline)
      let line = fragment
      if (this.fragments.length > 0) {
        if (fragment.length > 0) this.fragments.push(fragment)
        line = Buffer.concat(this.fragments, this.fragmentBytes + fragment.length)
        this.fragments = []
        this.fragmentBytes = 0
      }
      this.consume(line)
      lineStart = newline + 1
    }
    if (lineStart < chunk.length) {
      const fragment = Buffer.from(chunk.subarray(lineStart))
      this.fragments.push(fragment)
      this.fragmentBytes += fragment.length
    }
    /* jscpd:ignore-end */
  }

  /** Refuse a record fragment left by structurally complete Zstandard frames. */
  assertCompleteFramesEndOnRecord(): void {
    if (this.fragments.length > 0) {
      throw new Error('corrupt Zstandard session log: complete frame contains a torn JSONL record')
    }
  }

  finish(): SessionFormatArtifact {
    return this.restore.finish()
  }

  private consume(line: Buffer): void {
    const index = this.rowIndex
    this.rowIndex += 1
    let row: unknown
    try {
      row = parseJson(line.toString('utf8'), `row ${index + 1}`)
    } catch (error: unknown) {
      this.issue ??= asError(error)
      return
    }
    if (this.issue !== undefined) {
      if (typeof row === 'object' && row !== null
        && (row as { type?: unknown }).type === 'turn/end') throw this.issue
      return
    }
    this.restore.decodeRow(row)
  }
}

interface StartedMigrationStream {
  readonly parser: MigratingJsonlRows
}

async function startMigrationStream(
  headerRecord: Buffer,
  sourceVersion: number,
  format: JsonlGenerationFormatAdapter,
  validateHistoricalHeader?: PrepareJsonlMigrationOptions['validateHistoricalHeader'],
): Promise<StartedMigrationStream> {
  const value = parseJson(headerRecord.subarray(0, -1).toString('utf8'), 'header line')
  const version = storedVersion(value)
  if (version !== sourceVersion) {
    throw new Error(`resolved JSONL source filename identifies v${sourceVersion}, but its header identifies v${version}`)
  }
  const header = value as Record<string, unknown>
  const validation = validateHistoricalHeader?.(header)
  if (validation !== undefined) await validation
  const stream = format.createRestore(header)
  return { parser: new MigratingJsonlRows(stream) }
}

async function consumeMigrationBytes(
  rows: MigratingJsonlRows,
  chunks: Iterable<Buffer>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  let yieldDeadline = performance.now() + MIGRATION_DECODE_YIELD_INTERVAL_MS
  for (const bytes of chunks) {
    for (let offset = 0; offset < bytes.length; offset += MIGRATION_WORK_CHUNK_BYTES) {
      rows.write(bytes.subarray(offset, offset + MIGRATION_WORK_CHUNK_BYTES))
      if (performance.now() < yieldDeadline) continue
      await scheduler.yield()
      signal?.throwIfAborted()
      yieldDeadline = performance.now() + MIGRATION_DECODE_YIELD_INTERVAL_MS
    }
  }
}

async function decodeStreamingMigration(
  bytes: Buffer,
  compression: JsonlCompression,
  sourceVersion: number,
  format: JsonlGenerationFormatAdapter,
  validateHistoricalHeader: PrepareJsonlMigrationOptions['validateHistoricalHeader'],
  signal?: AbortSignal,
): Promise<SessionFormatArtifact> {
  signal?.throwIfAborted()
  if (compression === 'none') {
    const headerEnd = bytes.indexOf(0x0A)
    if (headerEnd === -1) throw new Error('empty or header-less session log')
    const stream = await startMigrationStream(
      bytes.subarray(0, headerEnd + 1),
      sourceVersion,
      format,
      validateHistoricalHeader,
    )
    signal?.throwIfAborted()
    const bodyEnd = bytes.lastIndexOf(0x0A)
    if (bodyEnd > headerEnd) {
      await consumeMigrationBytes(
        stream.parser,
        [bytes.subarray(headerEnd + 1, bodyEnd + 1)],
        signal,
      )
    }
    return stream.parser.finish()
  }

  const { frames, tornStart } = scanZstdFrames(bytes)
  if (frames.length === 0) throw new Error('empty or header-less Zstandard session log')
  const decoder = createZstdFrameDecoder()
  try {
    const decoded = decoder.decode(bytes, frames)
    const first = decoded.next()
    /* v8 ignore next -- a non-empty structural frame list yields once or throws. */
    if (first.done) throw new Error('empty or header-less Zstandard session log')
    assertIndependentHeaderFrame(first.value)
    const stream = await startMigrationStream(
      first.value,
      sourceVersion,
      format,
      validateHistoricalHeader,
    )
    signal?.throwIfAborted()
    await consumeMigrationBytes(stream.parser, decoded, signal)
    stream.parser.assertCompleteFramesEndOnRecord()
    if (tornStart !== undefined) {
      let recovered: Buffer = Buffer.alloc(0)
      try {
        recovered = await decompressZstdPrefix(bytes.subarray(tornStart))
      } catch {
        /* v8 ignore next -- decoder failure plus concurrent abort is timing-dependent. */
        if (signal?.aborted) signal.throwIfAborted()
      }
      signal?.throwIfAborted()
      const newline = recovered.lastIndexOf(0x0A)
      if (newline !== -1) {
        await consumeMigrationBytes(
          stream.parser,
          [recovered.subarray(0, newline + 1)],
          signal,
        )
      }
    }
    return stream.parser.finish()
  } finally {
    decoder.close()
  }
}

/**
 * Read and validate one complete current generation for an isolated verifier.
 * @param path - staged or competing current-generation path.
 * @param compression - configured physical encoding.
 * @param expectedId - Session identity expected in the header.
 * @param expectedEventCount - exact logical event count expected after decoding.
 * @param expectedPrefix - verified migration prefix; an append tail may be present and is not validated.
 * @returns stable physical identity and digest for publication comparison.
 */
export async function verifyJsonlCurrentGeneration(
  path: string,
  compression: JsonlCompression,
  expectedId: string,
  expectedEventCount: number,
  expectedPrefix?: JsonlExpectedPrefix,
): Promise<JsonlVerifiedGeneration> {
  return defaultGenerationRuntime.verify(path, compression, expectedId, expectedEventCount, expectedPrefix)
}

async function verifyCurrentGeneration(
  path: string,
  compression: JsonlCompression,
  expectedId: string,
  expectedEventCount: number,
  fs: GenerationFileSystem,
  expectedPrefix?: JsonlExpectedPrefix,
): Promise<JsonlVerifiedGeneration> {
  const before = await fs.stat(path)
  const bytes = await fs.readFile(path)
  const after = await fs.stat(path)
  if (expectedPrefix !== undefined) {
    if (bytes.length < expectedPrefix.bytes) {
      throw new Error('target bytes are shorter than the migrated generation')
    }
    const digest = createHash('sha256').update(bytes.subarray(0, expectedPrefix.bytes)).digest('hex')
    if (digest !== expectedPrefix.digest) {
      throw new Error('target bytes do not begin with the migrated generation')
    }
    return { identity: after, bytes: expectedPrefix.bytes, digest }
  }
  if (identity(before) !== identity(after)) {
    throw new Error('current session generation changed during verification')
  }
  const snapshot = { bytes, identity: after }
  const generation = decodeCurrentGeneration(snapshot.bytes, compression)
  validateStoredEvents(generation.meta, generation.events, { kind: 'jsonl', path })
  if (generation.meta.id !== expectedId) {
    throw new Error(`current session generation contains id "${generation.meta.id}", expected "${expectedId}"`)
  }
  if (generation.events.length !== expectedEventCount) {
    throw new Error(
      `current session generation contains ${generation.events.length} events, expected ${expectedEventCount}`,
    )
  }
  Session.fromRestore(
    generation.meta.id,
    generation.events,
    generation.meta,
    generation.inheritedEventCount,
    'detached',
  )
  assertCurrentAssistantStreams(generation.events)
  return {
    identity: snapshot.identity,
    bytes: snapshot.bytes.length,
    digest: createHash('sha256').update(snapshot.bytes).digest('hex'),
  }
}

/** Fully replay embedded streams only inside isolated current-generation verification. */
function assertCurrentAssistantStreams(events: readonly SessionEvent[]): void {
  for (const [index, event] of events.entries()) {
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    const assembler = new BlockAssembler()
    let timed: ReturnType<typeof expandAssistantStream>
    try {
      timed = expandAssistantStream(event.data.stream)
      for (const member of timed) assembler.push(member.chunk)
    } catch (error: unknown) {
      throw new Error(`seed ${event.type} at index ${index} has an invalid embedded stream`, { cause: error })
    }
    if (event.type === 'assistant/attempt' || timed.length === 0) continue
    const content = event.data.interrupted === true ? assembler.interruptedBlocks() : assembler.blocks()
    if (!isDeepStrictEqual(event.data.message.content, content)) {
      throw new Error(`seed assistant/message at index ${index} content disagrees with its embedded stream`)
    }
    if (!isDeepStrictEqual(event.data.usage, assembler.usage)) {
      throw new Error(`seed assistant/message at index ${index} usage disagrees with its embedded stream`)
    }
    if (!isDeepStrictEqual(event.data.message.source.replayState, assembler.replayState)) {
      throw new Error(`seed assistant/message at index ${index} replay state disagrees with its embedded stream`)
    }
  }
}

function decodeCurrentGeneration(
  bytes: Buffer,
  compression: JsonlCompression,
): ReturnType<SessionLogScanner['finish']> {
  if (compression === 'none') {
    const headerEnd = bytes.indexOf(0x0A)
    if (headerEnd === -1) throw new Error('empty or header-less session log')
    const scanner = new SessionLogScanner(bytes.subarray(0, headerEnd + 1), 'strict')
    scanner.write(bytes.subarray(headerEnd + 1))
    return finishCurrentGenerationScan(scanner)
  }
  const { frames, tornStart } = scanZstdFrames(bytes)
  if (frames.length === 0) throw new Error('empty or header-less Zstandard session log')
  if (tornStart !== undefined) throw new Error('current session generation has a torn physical tail')
  const decoder = createZstdFrameDecoder()
  try {
    const plaintext = decoder.decode(bytes, frames)
    const header = plaintext.next()
    /* v8 ignore next -- a non-empty structural frame list yields once or throws. */
    if (header.done) throw new Error('empty or header-less Zstandard session log')
    assertIndependentHeaderFrame(header.value)
    const scanner = new SessionLogScanner(header.value, 'strict')
    for (const chunk of plaintext) scanner.write(chunk)
    return finishCurrentGenerationScan(scanner)
  } finally {
    decoder.close()
  }
}

function finishCurrentGenerationScan(
  scanner: SessionLogScanner,
): ReturnType<SessionLogScanner['finish']> {
  const inputBytes = scanner.checkpoint().inputBytes
  const decoded = scanner.finish()
  if (decoded.committedBytes !== inputBytes) throw new Error('current session generation has a torn physical tail')
  return decoded
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

function assertIndependentHeaderFrame(plaintext: Buffer): void {
  if (plaintext.length === 0 || plaintext.indexOf(0x0A) !== plaintext.length - 1) {
    throw new Error('corrupt Zstandard session log: first frame is not exactly one header line')
  }
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

interface StreamedMigrationStage {
  readonly path: string
  readonly bytes: number
  readonly digest: string
}

/** Produce bounded JSONL chunks while yielding between main-thread encoding slices. */
async function* encodeMigrationRows(
  artifact: SessionFormatArtifact,
  format: JsonlGenerationFormatAdapter,
  signal?: AbortSignal,
): AsyncGenerator<Buffer, void, void> {
  signal?.throwIfAborted()
  let lines: string[] = []
  let bytes = 0
  for (const value of artifact.events) {
    const line = `${stringifyJson(format.encodeEvent(value), `migrated Session event ${value.seq}`)}\n`
    const lineBytes = Buffer.byteLength(line)
    if (bytes > 0 && bytes + lineBytes > MIGRATION_WORK_CHUNK_BYTES) {
      yield Buffer.from(lines.join(''))
      await scheduler.yield()
      signal?.throwIfAborted()
      lines = []
      bytes = 0
    }
    lines.push(line)
    bytes += lineBytes
  }
  yield Buffer.from(lines.join(''))
}

async function writeMigrationChunks(
  chunks: AsyncIterable<Buffer>,
  write: (chunk: Buffer) => Promise<void>,
): Promise<void> {
  let pending: Buffer[] = []
  let bytes = 0
  for await (const chunk of chunks) {
    pending.push(chunk)
    bytes += chunk.length
    if (bytes < MIGRATION_WRITE_CHUNK_BYTES) continue
    await write(pending.length === 1 ? pending[0] as Buffer : Buffer.concat(pending, bytes))
    pending = []
    bytes = 0
  }
  if (bytes > 0) await write(pending.length === 1 ? pending[0] as Buffer : Buffer.concat(pending, bytes))
}

/** Encode directly into one synced stage without a whole-artifact row or byte buffer. */
async function writeSyncedTemp(
  currentPath: string,
  suffix: string,
  compression: JsonlCompression,
  artifact: SessionFormatArtifact,
  format: JsonlGenerationFormatAdapter,
  signal: AbortSignal | undefined,
  internals: JsonlGenerationInternals,
): Promise<StreamedMigrationStage> {
  signal?.throwIfAborted()
  let path: string
  let handle: FileHandle
  for (;;) {
    path = join(dirname(currentPath), `session.migration.${internals.randomToken()}${suffix}.tmp`)
    try {
      handle = await internals.fs.open(path, 'wx', 0o600)
      break
    } catch (error) {
      if (isEEXIST(error)) continue
      throw error
    }
  }
  const hash = createHash('sha256')
  let bytes = 0
  const write = async (chunk: Buffer): Promise<void> => {
    await handle.writeFile(chunk)
    hash.update(chunk)
    bytes += chunk.length
  }
  let failure: unknown
  try {
    const headerValue = format.encodeHeader(artifact.header, artifact.inheritedEventCount)
    const header = Buffer.from(`${stringifyJson(headerValue, 'migrated session header')}\n`)
    await write(compression === 'zstd' ? await compressZstdFrame(header) : header)
    if (artifact.events.length > 0) {
      const rows = encodeMigrationRows(artifact, format, signal)
      if (compression === 'none') {
        await writeMigrationChunks(rows, write)
      } else {
        await new Promise<void>((resolve, reject) => {
          pipeline(
            Readable.from(rows, { objectMode: false, highWaterMark: MIGRATION_WORK_CHUNK_BYTES }),
            createZstdCompress(ZSTD_CHECKSUM_OPTIONS),
            async (source) => { await writeMigrationChunks(source as AsyncIterable<Buffer>, write) },
            (error: Error | null | undefined) => {
              if (error instanceof Error) reject(error)
              else resolve()
            },
          )
        })
      }
    }
    signal?.throwIfAborted()
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
    await removeTemporary(path, writeError, internals)
    throw writeError
  }
  return { path, bytes, digest: hash.digest('hex') }
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

async function inspectExpectedCurrent<T>(
  currentPath: string,
  internals: JsonlGenerationInternals,
  inspect: () => Promise<T>,
): Promise<T> {
  try {
    const expectedName = basename(currentPath)
    const names = await internals.fs.readdir(dirname(currentPath))
    if (!names.includes(expectedName)) {
      const noncanonical = names.find(name => name.toLowerCase() === expectedName.toLowerCase())
      if (noncanonical !== undefined) {
        throw new Error(`target resolves to noncanonical directory entry "${noncanonical}"`)
      }
    }
    const info = await internals.fs.lstat(currentPath)
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`target is a ${info.isSymbolicLink() ? 'symbolic link' : 'non-regular file'}`)
    }
    return await inspect()
  } catch (error: unknown) {
    if (isErrnoException(error)) throw error
    throw new JsonlGenerationTargetConflictError(currentPath, asError(error))
  }
}

function withOverrides(overrides: JsonlGenerationRuntimeOverrides): JsonlGenerationInternals {
  return {
    ...defaultInternals,
    ...overrides,
    fs: { ...defaultFileSystem, ...overrides.fs },
  }
}

async function publishPreparedMigration(
  options: PrepareJsonlMigrationOptions,
  suffix: string,
  artifact: SessionFormatArtifact,
  sourceIdentity: JsonlPhysicalIdentity,
  internals: JsonlGenerationInternals,
): Promise<JsonlPhysicalIdentity> {
  await scheduler.yield()
  const { sourcePath, currentPath, compression, verifyCurrentFile } = options
  const eventCount = artifact.events.length
  let staged = await writeSyncedTemp(currentPath, suffix, compression, artifact, options.format, undefined, internals)
  try {
    const verifiedStage = await verifyCurrentFile(
      staged.path,
      compression,
      artifact.header.id,
      eventCount,
    )
    if (verifiedStage.bytes !== staged.bytes || verifiedStage.digest !== staged.digest) {
      throw new Error('staged session generation changed during verification')
    }
    await internals.barrier('before-source-check', 1)
    const beforePublish = await internals.fs.stat(sourcePath)
    if (identity(beforePublish) !== identity(sourceIdentity)) {
      throw new JsonlGenerationSourceChangedError(sourcePath)
    }
    const published = await publishCurrentExclusive(staged.path, currentPath, internals)
    if (published && internals.platform === 'win32') staged = { ...staged, path: '' }
    await internals.barrier('after-publication', 1)
    let currentIdentity: JsonlPhysicalIdentity
    if (published) {
      if (staged.path !== '') {
        await removeCommittedTemporary(staged.path, internals)
        staged = { ...staged, path: '' }
      }
      currentIdentity = await internals.fs.stat(currentPath)
    } else {
      const winner = await inspectExpectedCurrent(currentPath, internals, async () => {
        const candidate = await verifyCurrentFile(
          currentPath,
          compression,
          artifact.header.id,
          eventCount,
          staged,
        )
        if (candidate.bytes !== staged.bytes || candidate.digest !== staged.digest) {
          throw new Error('target bytes differ from the migrated generation')
        }
        return candidate
      })
      currentIdentity = winner.identity
      await removeCommittedTemporary(staged.path, internals)
      staged = { ...staged, path: '' }
    }
    return currentIdentity
  } catch (error: unknown) {
    if (staged.path !== '') await removeTemporary(staged.path, error, internals)
    throw error
  }
}

async function prepareMigration(
  options: PrepareJsonlMigrationOptions,
  internals: JsonlGenerationInternals,
): Promise<PreparedJsonlMigration> {
  const { sourcePath, sourceVersion, currentPath, compression, format, signal } = options
  const suffix = assertGenerationPaths(
    sourcePath,
    sourceVersion,
    currentPath,
    format.currentVersion,
    compression,
  )
  if (sourceVersion >= format.currentVersion) {
    throw new Error(`migration preparation requires a historical source, got v${sourceVersion}`)
  }
  const source = await readStableSnapshot(sourcePath, signal, internals.fs)
  let artifact: SessionFormatArtifact
  try {
    artifact = await decodeStreamingMigration(
      source.bytes,
      compression,
      sourceVersion,
      format,
      options.validateHistoricalHeader,
      signal,
    )
  } catch (error: unknown) {
    if (format.isUnsupportedMigrationError?.(error) === true) {
      throw new JsonlGenerationUnsupportedMigrationError(sourceVersion, error)
    }
    throw error
  }
  if (artifact.header.version !== format.currentVersion) {
    throw new Error(`format migration returned v${artifact.header.version}, expected v${format.currentVersion}`)
  }
  const sourceIdentity = source.identity
  let publication: Promise<JsonlPhysicalIdentity> | undefined
  return {
    sourceIdentity,
    artifact,
    publish() {
      if (publication === undefined) {
        publication = publishPreparedMigration(
          options,
          suffix,
          artifact,
          sourceIdentity,
          internals,
        )
      }
      return publication
    },
  }
}

/**
 * Decode and migrate one historical generation without writing its successor.
 * @param options - resolved source, current target, format adapter, and load cancellation.
 * @returns the current artifact and an idempotent explicit publication operation.
 */
export function prepareJsonlMigration(
  options: PrepareJsonlMigrationOptions,
): Promise<PreparedJsonlMigration> {
  return defaultGenerationRuntime.prepare(options)
}

/**
 * Create one generation runtime with fixed filesystem and publication dependencies.
 * @param overrides - deterministic filesystem, platform, and race dependencies.
 * @returns bound generation operations.
 */
export function createJsonlGenerationRuntime(
  overrides: JsonlGenerationRuntimeOverrides = {},
): JsonlGenerationRuntime {
  const internals = withOverrides(overrides)
  return {
    readStable: (path, signal) => readStableSnapshot(path, signal, internals.fs),
    prepare: options => prepareMigration(options, internals),
    verify: (path, compression, expectedId, expectedEventCount, expectedPrefix) => verifyCurrentGeneration(
      path, compression, expectedId, expectedEventCount, internals.fs, expectedPrefix,
    ),
  }
}

const defaultGenerationRuntime = createJsonlGenerationRuntime()
