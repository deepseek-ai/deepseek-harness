/** Bounded, cancellable reads of Desktop-owned plugin operation history. */
import { open, stat, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate, setTimeout as wait } from 'node:timers/promises'
import { parsePluginOperationRecord, type PluginOperationRecord } from '@deepseek-ai/dsh-plugin-manager/diagnostic'

/** The segment this collector reads first; the other owned segment is its rotation predecessor. */
const CURRENT_SEGMENT = 'operations.jsonl'
/** Windows reports these while another handle temporarily owns an otherwise readable file. */
const WINDOWS_TRANSIENT_OPEN_ERRORS: ReadonlySet<string> = new Set(['EACCES', 'EBUSY', 'EPERM'])
const WINDOWS_OPEN_RETRY_INITIAL_MS = 10
const WINDOWS_OPEN_RETRY_MAX_MS = 40
const WINDOWS_OPEN_RETRY_LIMIT = 4

/** Resource budgets for auxiliary history collection, independent of basic crash report writing. */
export interface OperationHistoryReadLimits {
  readonly bytes: number
  readonly recordBytes: number
  readonly records: number
}

/** Collection facts; incomplete history must not be interpreted as absence of plugin changes. */
export interface OperationHistoryReadResult {
  readonly records: readonly PluginOperationRecord[]
  readonly bytesRead: number
  /** Distinct files from which at least one byte was read. */
  readonly filesRead: number
  readonly truncated: boolean
  readonly invalidRecords: number
  readonly unavailableFiles: number
  readonly cancelled: boolean
}

/**
 * Exact two-name key for one file; both stats are BigInt so a Windows 64-bit file ID
 * round-trips without the precision loss of its Number form.
 * @param info - Stats of the opened segment or of the current segment path.
 * @returns Device and inode as one comparable string.
 */
function fileIdentity(info: { readonly dev: number | bigint; readonly ino: number | bigint }): string {
  return `${String(info.dev)}:${String(info.ino)}`
}

/** Whether Windows reported temporary interference with opening a history segment. */
function isTransientWindowsOpenError(error: unknown): boolean {
  if (process.platform !== 'win32') return false
  return WINDOWS_TRANSIENT_OPEN_ERRORS.has((error as NodeJS.ErrnoException | null)?.code ?? '')
}

/**
 * Open one segment, retrying the temporary Windows sharing and permission failures a scanner
 * causes on a freshly written file. One persistent failure would otherwise drop the whole
 * segment from the report. A signal aborted during the bounded wait ends the retries without
 * another open.
 * @param filename - Absolute path of the owned segment.
 * @param signal - Caller-owned collection deadline or shutdown cancellation.
 * @returns The opened read handle.
 */
async function openSegment(filename: string, signal: AbortSignal): Promise<FileHandle> {
  let delay = WINDOWS_OPEN_RETRY_INITIAL_MS
  for (let retries = 0;; retries += 1) {
    try {
      return await open(filename, 'r')
    } catch (error) {
      if (!isTransientWindowsOpenError(error) || retries >= WINDOWS_OPEN_RETRY_LIMIT || signal.aborted) throw error
      await wait(delay)
      if (signal.aborted) throw error
      delay = Math.min(delay * 2, WINDOWS_OPEN_RETRY_MAX_MS)
    }
  }
}

/**
 * Whether the current segment path stopped naming the file this collection already read.
 * Identity equality alone cannot decide: Windows does not guarantee that its 64-bit file ID
 * is unique, so two distinct segments can report one identity; a rotation is only deduplicated
 * once the current path itself moved on.
 * @param directory - Desktop's operation history directory.
 * @param identity - Identity of the segment already read from the current path.
 * @returns Whether the predecessor is the segment already read.
 */
async function currentSegmentRotated(directory: string, identity: string): Promise<boolean> {
  try {
    return fileIdentity(await stat(join(directory, CURRENT_SEGMENT), { bigint: true })) !== identity
  } catch {
    // A path that no longer resolves cannot still name the segment already read.
    return true
  }
}

/**
 * Read only the bounded tails of the two owned history files, newest segment first.
 * Cancellation is observed between bounded records after yielding to Worker messages and stops subsequent I/O and parsing.
 * A segment is deduplicated as already read only when the current path stopped naming it.
 * An already-issued OS read must settle before its handle closes.
 * @param directory - Desktop's operation history directory; unrelated files are never enumerated.
 * @param limits - Positive byte, record-size and record-count budgets.
 * @param signal - Caller-owned collection deadline or shutdown cancellation.
 * @returns Partial records and explicit omissions; filesystem failures never reject the collection.
 */
export async function readOperationHistory(
  directory: string,
  limits: OperationHistoryReadLimits,
  signal: AbortSignal,
): Promise<OperationHistoryReadResult> {
  if (![limits.bytes, limits.recordBytes, limits.records].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new RangeError('Operation history budgets must be positive safe integers')
  }
  await setImmediate()
  const cancelled = (): boolean => signal.aborted
  const records: PluginOperationRecord[] = []
  let bytesRead = 0
  const seenFiles = new Set<string>()
  let truncated = false
  let invalidRecords = 0
  let unavailableFiles = 0
  for (const name of [CURRENT_SEGMENT, 'operations.previous.jsonl']) {
    if (cancelled()) break
    try {
      await using handle = await openSegment(join(directory, name), signal)
      if (cancelled()) break
      const fileStat = await handle.stat({ bigint: true })
      if (cancelled()) break
      if (!fileStat.isFile()) {
        unavailableFiles++
        continue
      }
      const identity = fileIdentity(fileStat)
      const size = Number(fileStat.size)
      if (seenFiles.has(identity) && await currentSegmentRotated(directory, identity)) {
        truncated = true
        continue
      }
      if (size > 0 && (bytesRead >= limits.bytes || records.length >= limits.records)) {
        truncated = true
        break
      }

      const readLength = Math.min(size, limits.bytes - bytesRead)
      const readStart = size - readLength
      const buffer = Buffer.alloc(readLength)
      let readOffset = 0
      while (readOffset < readLength && !cancelled()) {
        const read = await handle.read(buffer, readOffset, Math.min(16 * 1024, readLength - readOffset), readStart + readOffset)
        bytesRead += read.bytesRead
        if (read.bytesRead === 0) break
        readOffset += read.bytesRead
      }
      if (readOffset > 0) seenFiles.add(identity)
      if (cancelled()) break
      truncated ||= readStart > 0 || readOffset < readLength

      // An unterminated last record can still be in flight; never parse it as a committed record.
      if (readOffset === 0) continue
      let lineEnd = buffer.lastIndexOf(10, readOffset - 1)
      if (lineEnd !== readOffset - 1) truncated = true
      while (lineEnd >= 0 && records.length < limits.records && !cancelled()) {
        await setImmediate()
        if (cancelled()) break
        const previousLineEnd = lineEnd === 0 ? -1 : buffer.lastIndexOf(10, lineEnd - 1)
        if (previousLineEnd < 0 && readStart > 0) {
          truncated = true
          break
        }
        const recordBytes = lineEnd - previousLineEnd - 1
        if (recordBytes > limits.recordBytes) {
          invalidRecords++
        } else if (recordBytes > 0) {
          try {
            const value: unknown = JSON.parse(buffer.subarray(previousLineEnd + 1, lineEnd).toString('utf8'))
            const record = parsePluginOperationRecord(value)
            if (record === undefined) invalidRecords++
            else records.push(record)
          } catch (_error) {
            // A corrupt record does not invalidate independently delimited older records.
            invalidRecords++
          }
        }
        lineEnd = previousLineEnd
      }
      if (lineEnd >= 0) truncated = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unavailableFiles++
    }
  }
  return { records, bytesRead, filesRead: seenFiles.size, truncated, invalidRecords, unavailableFiles, cancelled: cancelled() }
}
