/**
 * In-memory view of one DeepSeek chat export ZIP archive. Opening reads the
 * central directory; a streaming pass inflates only the entries it is asked
 * for, and a by-name read serves a targeted fetch of one entry.
 */

import { setImmediate as nextTurn } from 'node:timers/promises'
import { Unzip, UnzipInflate, unzip } from 'fflate'
import type { FlateError, Unzipped, UnzipFile, UnzipFileInfo } from 'fflate'
import type { DeepseekChatImportFailureReason } from './types.ts'

/** One entry the archive directory lists. */
export interface ExportEntryInfo {
  /** Entry name, such as `manifest.json` or `chat_sessions/{id}.json`. */
  readonly name: string
  /** Compressed size, in bytes. */
  readonly size: number
  /** Declared uncompressed size, in bytes. */
  readonly originalSize: number
  /** ZIP compression method: 0 is stored, 8 is deflated. */
  readonly compression: number
}

/** How one streaming pass handles each entry it is shown. */
export interface ExportStreamHandler {
  /**
   * Decide whether one entry's bytes are needed, before it is inflated.
   * @param entry - directory record of the entry.
   * @returns true to deliver the bytes to {@link ExportStreamHandler.entry}, false to skip the entry.
   */
  select(entry: ExportEntryInfo): boolean
  /**
   * Consume one entry `select` accepted.
   * @param entry - the accepted entry's directory record.
   * @param data - complete uncompressed bytes.
   * @returns completes when the entry is handled; the pass waits for it before delivering the next entry.
   */
  entry(entry: ExportEntryInfo, data: Uint8Array): Promise<void>
  /**
   * Report one entry the pass could not deliver; the pass continues with the next entry.
   * @param entry - the rejected entry's directory record.
   * @param error - the failed size check or the inflation failure.
   */
  reject(entry: ExportEntryInfo, error: ExportEntryError): void
}

/** The upload cannot be imported as a whole; `reason` selects the user-facing explanation. */
export class ExportSourceError extends Error {
  override readonly name = 'ExportSourceError'

  /**
   * @param reason - failure category shown to the user.
   * @param message - English diagnostic.
   * @param options - underlying cause.
   */
  constructor(readonly reason: DeepseekChatImportFailureReason, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/** One entry cannot be read: it exceeds the per-entry byte limit, or its data is damaged. */
export class ExportEntryError extends Error {
  override readonly name = 'ExportEntryError'

  /**
   * @param message - English diagnostic naming the entry.
   * @param oversized - true when the entry declares or stores more bytes than the per-entry limit, false when it is damaged.
   * @param options - underlying cause.
   */
  constructor(message: string, readonly oversized: boolean, options?: ErrorOptions) {
    super(message, options)
  }
}

/** Read-only view of one export archive. */
export interface ExportArchive {
  /**
   * Run one streaming pass over the archive in entry order. Only the entries
   * `handler.select` accepts are inflated, one at a time; the pass waits for
   * each accepted entry to be handled and yields between archive chunks.
   *
   * Inflation is synchronous, so one archive chunk's output is produced before
   * the pass yields again. An entry that declares a small size but inflates
   * past the per-entry limit keeps inflating until the entry ends: the limit
   * then stops the bytes being kept, not the work being done.
   * @param handler - per-entry decision, consumption, and rejection report.
   * @param signal - cancellation, checked between chunks.
   * @returns completes after the last entry.
   * @throws {ExportSourceError} `unreadable-archive` when a data record is not in the directory
   * or the bytes cannot be read as a ZIP archive.
   */
  stream(handler: ExportStreamHandler, signal: AbortSignal): Promise<void>
  /**
   * Decompress one entry by name. Each call re-parses the whole central
   * directory before inflating the entry, so a caller that needs several
   * entries pays one directory scan per call; {@link ExportArchive.stream} is
   * the linear alternative. Returns at most the size the entry declares: an
   * entry that inflates to more is truncated to that size, while
   * {@link ExportArchive.stream} reports the same condition as a size failure.
   * @param entry - archive name, such as `manifest.json` or a conversation `export_path`.
   * @param signal - cancellation; aborting terminates the decompression.
   * @returns the entry bytes, or undefined when the archive has no such entry.
   * @throws {ExportEntryError} when the entry declares or stores more than the per-entry byte limit,
   * declares a stored size other than the bytes it holds, or cannot be inflated.
   */
  read(entry: string, signal: AbortSignal): Promise<Uint8Array | undefined>
}

/** Bytes consumed from the archive before the pass yields to the event loop. */
const SLICE_BYTES = 64 * 1024

/** One accepted entry whose chunks are still arriving. */
interface Inflating {
  readonly info: ExportEntryInfo
  readonly chunks: Uint8Array[]
  received: number
  /** Set when the decoder itself failed, such as on a damaged deflate stream. */
  error: ExportEntryError | undefined
}

/** One finished entry waiting for the handler, in archive order. */
type Finished =
  | { readonly info: ExportEntryInfo; readonly data: Uint8Array }
  | { readonly info: ExportEntryInfo; readonly error: ExportEntryError }

/**
 * Open an export archive held in memory. Opening reads only the ZIP central
 * directory; entries are inflated when a pass or a read asks for them.
 * @param archive - complete ZIP bytes.
 * @param maxEntryBytes - largest declared uncompressed size of one entry.
 * @param signal - cancellation.
 * @returns a reader over the archive.
 * @throws {ExportSourceError} `unreadable-archive` when the bytes are not a readable ZIP archive
 * or carry more than one entry with the same name.
 */
export async function openExportArchive(archive: Uint8Array, maxEntryBytes: number, signal: AbortSignal): Promise<ExportArchive> {
  const names: string[] = []
  const directory = new Map<string, ExportEntryInfo>()
  try {
    await unzipAsync(archive, (file) => {
      names.push(file.name)
      directory.set(file.name, { name: file.name, size: file.size, originalSize: file.originalSize, compression: file.compression })
      return false
    }, signal)
  } catch (error) {
    signal.throwIfAborted()
    throw new ExportSourceError('unreadable-archive', 'the uploaded file is not a readable ZIP archive', { cause: error })
  }
  // `read` selects by name, so duplicate names would inflate every match and
  // bypass the per-entry limit; the streaming pass relies on unique names too.
  const unique = new Set<string>()
  for (const name of names) {
    if (unique.has(name)) throw new ExportSourceError('unreadable-archive', `the archive has more than one entry named ${name}`)
    unique.add(name)
  }
  return {
    stream: (handler, streamSignal) => streamEntries(archive, directory, maxEntryBytes, handler, streamSignal),
    read: async (entry, readSignal) => {
      let rejected: ExportEntryError | undefined
      let files: Unzipped
      try {
        files = await unzipAsync(archive, (file) => {
          if (file.name !== entry) return false
          rejected = entrySizeError(file, maxEntryBytes)
          return rejected === undefined
        }, readSignal)
      } catch (error) {
        readSignal.throwIfAborted()
        throw new ExportEntryError(`${entry} cannot be decompressed`, false, { cause: error })
      }
      if (rejected !== undefined) throw rejected
      return files[entry]
    },
  }
}

/**
 * One streaming pass over the archive bytes, in entry order. The central
 * directory supplies each entry's declared sizes before its data is inflated;
 * an accepted entry's chunks are accumulated and delivered whole.
 */
async function streamEntries(
  archive: Uint8Array,
  directory: ReadonlyMap<string, ExportEntryInfo>,
  maxEntryBytes: number,
  handler: ExportStreamHandler,
  signal: AbortSignal,
): Promise<void> {
  const finished: Finished[] = []
  const finish = (entry: Inflating): void => {
    const failure = entry.error ?? sizeFailure(entry, maxEntryBytes)
    finished.push(failure === undefined
      ? { info: entry.info, data: concat(entry.chunks, entry.received) }
      : { info: entry.info, error: failure })
  }
  const inflate = (file: UnzipFile, info: ExportEntryInfo): void => {
    const entry: Inflating = { info, chunks: [], received: 0, error: undefined }
    file.ondata = (dataError: FlateError | null, chunk: Uint8Array, final: boolean) => {
      if (dataError !== null) {
        entry.error ??= new ExportEntryError(`${info.name} cannot be decompressed`, false, { cause: dataError })
      } else if (chunk.length > 0) {
        entry.received += chunk.length
        // Bytes past the limit are counted but not kept; the entry is reported
        // as oversized instead of being delivered.
        if (entry.received <= maxEntryBytes) entry.chunks.push(chunk)
      }
      if (final) finish(entry)
    }
    file.start()
  }
  const reader = new Unzip((file) => {
    const info = directory.get(file.name)
    if (info === undefined) {
      throw new ExportSourceError('unreadable-archive', `the archive contains ${file.name}, which its directory does not list`)
    }
    const error = entrySizeError(info, maxEntryBytes)
    if (error !== undefined) {
      handler.reject(info, error)
      return
    }
    if (handler.select(info)) inflate(file, info)
  })
  reader.register(UnzipInflate)
  const deliver = async (): Promise<void> => {
    for (const item of finished.splice(0)) {
      if ('error' in item) handler.reject(item.info, item.error)
      else await handler.entry(item.info, item.data)
    }
  }
  signal.throwIfAborted()
  for (let offset = 0; offset < archive.length; offset += SLICE_BYTES) {
    const end = Math.min(archive.length, offset + SLICE_BYTES)
    try {
      reader.push(archive.subarray(offset, end), end === archive.length)
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof ExportSourceError) throw error
      throw new ExportSourceError('unreadable-archive', 'the uploaded file is not a readable ZIP archive', { cause: error })
    }
    await deliver()
    signal.throwIfAborted()
    await nextTurn()
  }
  await deliver()
}

/** Join accumulated chunks into one buffer of `size` bytes. */
function concat(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const data = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.length
  }
  return data
}

/**
 * Why an inflated entry exceeds the per-entry limit or the size it declared;
 * undefined when the entry yielded exactly what it promised.
 */
function sizeFailure(entry: Inflating, maxEntryBytes: number): ExportEntryError | undefined {
  if (entry.received > maxEntryBytes) {
    return new ExportEntryError(`${entry.info.name} yields more than the ${maxEntryBytes}-byte entry limit`, true)
  }
  if (entry.received > entry.info.originalSize) {
    return new ExportEntryError(`${entry.info.name} yields more bytes than the ${entry.info.originalSize} bytes it declares`, false)
  }
  return undefined
}

/**
 * Why one entry exceeds the per-entry limit or disagrees with its declared
 * size; undefined when the entry is acceptable.
 */
function entrySizeError(entry: UnzipFileInfo, maxEntryBytes: number): ExportEntryError | undefined {
  if (entry.originalSize > maxEntryBytes) {
    return new ExportEntryError(
      `${entry.name} declares ${entry.originalSize} uncompressed bytes, more than the ${maxEntryBytes}-byte entry limit`, true)
  }
  if (entry.size > maxEntryBytes) {
    return new ExportEntryError(`${entry.name} stores ${entry.size} bytes, more than the ${maxEntryBytes}-byte entry limit`, true)
  }
  // A ZIP_STORED entry is copied by its compressed size, which fflate takes
  // as-is; the declared and stored sizes must therefore agree.
  if (entry.compression === 0 && entry.size !== entry.originalSize) {
    return new ExportEntryError(`${entry.name} declares ${entry.originalSize} uncompressed bytes but stores ${entry.size} bytes`, false)
  }
  return undefined
}

/**
 * Promise form of fflate's asynchronous `unzip`. The filter sees each central
 * directory record, including its declared `originalSize`, before anything is
 * inflated.
 */
function unzipAsync(archive: Uint8Array, filter: (file: UnzipFileInfo) => boolean, signal: AbortSignal): Promise<Unzipped> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const onAbort = (): void => {
      terminate()
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Cancellation preserves the exact caller-provided reason.
      reject(signal.reason)
    }
    const terminate = unzip(archive, { filter }, (error, files) => {
      signal.removeEventListener('abort', onAbort)
      if (error === null) resolve(files)
      else reject(error)
    })
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
