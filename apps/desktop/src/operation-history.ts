/** Bounded, cancellable reads of Desktop-owned plugin operation history. */
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { parsePluginOperationRecord, type PluginOperationRecord } from '@deepseek-ai/dsh-plugin-manager/diagnostic'

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
 * Read only the bounded tails of the two owned history files, newest segment first.
 * Cancellation is observed between bounded records after yielding to Worker messages and stops subsequent I/O and parsing.
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
  for (const name of ['operations.jsonl', 'operations.previous.jsonl']) {
    if (cancelled()) break
    try {
      await using handle = await open(join(directory, name), 'r')
      if (cancelled()) break
      const fileStat = await handle.stat()
      if (cancelled()) break
      if (!fileStat.isFile()) {
        unavailableFiles++
        continue
      }
      const identity = `${String(fileStat.dev)}:${String(fileStat.ino)}`
      if (seenFiles.has(identity)) {
        truncated = true
        continue
      }
      if (fileStat.size > 0 && (bytesRead >= limits.bytes || records.length >= limits.records)) {
        truncated = true
        break
      }

      const readLength = Math.min(fileStat.size, limits.bytes - bytesRead)
      const readStart = fileStat.size - readLength
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
