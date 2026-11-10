/** Combined byte accounting for retained program output. */
import type { PtcOutput, PtcJsonValue, PtcRunFailure, PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import { jsonStringBytesUpTo, jsonValueBytesUpTo, truncateJsonStringBytes } from './output-json.ts'

/** Measure a text entry or an image descriptor against the remaining JSON-byte budget. */
function entryBytes(entry: PtcOutput, available: number): number | undefined {
  return entry.type === 'text' ? jsonStringBytesUpTo(entry.text, available)
    : jsonValueBytesUpTo({ ...entry, attachment: { ...entry.attachment } }, available)
}

/** One run's combined outer-output ledger; binding values never enter it. */
export class OutputLedger {
  private bytes = 2 // JSON serialization of the empty output array: []
  private entries = 0

  constructor(private readonly maxBytes: number, private readonly overflowMessage?: string) {}

  /** Admit one ordered text or image entry against the combined output budget. */
  admit(entry: PtcOutput, sink: PtcOutput[]): boolean {
    const separatorBytes = this.entries > 0 ? 1 : 0
    const remaining = this.maxBytes - this.bytes - separatorBytes
    const bytes = entryBytes(entry, remaining)
    if (bytes === undefined) return false
    this.bytes += bytes + separatorBytes
    this.entries += 1
    sink.push(entry)
    return true
  }

  /** Finalize a successful absent-or-JSON completion against the combined cap. */
  success(output: PtcOutput[], value?: PtcJsonValue): PtcRunResult {
    if (value !== undefined && jsonValueBytesUpTo(value, this.maxBytes - this.bytes) === undefined) return this.limit(output)
    return { output, ...value !== undefined ? { value } : {} }
  }

  /** Finalize a failure diagnostic, with output-limit taking precedence when combined bytes exceed the cap. */
  failure(output: PtcOutput[], error: PtcRunFailure): PtcRunResult {
    if (jsonStringBytesUpTo(error.message, this.maxBytes - this.bytes) === undefined) return this.limit(output)
    return { output, error }
  }

  /** Build the explicit output-limit failure while retaining a fitting ordered output prefix. */
  limit(output: PtcOutput[]): PtcRunResult {
    const fullMessage = this.overflowMessage ?? `outer output exceeded ${this.maxBytes} bytes`
    // The fixed diagnostic is ASCII, so every character is one byte plus the quotes.
    const messageBytes = fullMessage.length + 2
    const retained: PtcOutput[] = []
    let retainedBytes = 2
    const logBudget = this.maxBytes - messageBytes
    for (const entry of output) {
      const separatorBytes = retained.length > 0 ? 1 : 0
      const availableBytes = logBudget - retainedBytes - separatorBytes
      const bytes = entryBytes(entry, availableBytes)
      if (bytes !== undefined) {
        retained.push(entry)
        retainedBytes += bytes + separatorBytes
        continue
      }
      if (entry.type === 'image') break
      const prefix = truncateJsonStringBytes(entry.text, availableBytes)
      if (prefix.length > 0) {
        const prefixBytes = jsonStringBytesUpTo(prefix, availableBytes)
        /* v8 ignore next -- truncateJsonStringBytes guarantees its returned prefix fits the same budget. */
        if (prefixBytes === undefined) throw new Error('output ledger produced an oversized log prefix')
        retained.push({ type: 'text', text: prefix })
        retainedBytes += prefixBytes + separatorBytes
      }
      break
    }
    const availableMessageBytes = this.maxBytes - retainedBytes
    const message = truncateJsonStringBytes(fullMessage, availableMessageBytes)
    return { output: retained, error: { kind: 'output-limit', message } }
  }
}
