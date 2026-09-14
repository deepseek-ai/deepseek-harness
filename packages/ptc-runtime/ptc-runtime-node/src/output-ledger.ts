/** Combined byte accounting for retained program output. */
import type { PtcJsonValue, PtcRunFailure, PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import { jsonStringBytesUpTo, jsonValueBytesUpTo, truncateJsonStringBytes } from './output-json.ts'

/** One run's combined outer-output ledger; binding values never enter it. */
export class OutputLedger {
  private bytes = 2 // JSON serialization of the empty logs array: []
  private entries = 0

  constructor(private readonly maxBytes: number) {}

  /** Admit one exact log entry, or report that the hard cap was crossed. */
  admit(text: string, sink: string[]): boolean {
    const separatorBytes = this.entries > 0 ? 1 : 0
    const stringBytes = jsonStringBytesUpTo(text, this.maxBytes - this.bytes - separatorBytes)
    if (stringBytes === undefined) return false
    this.bytes += stringBytes + separatorBytes
    this.entries += 1
    sink.push(text)
    return true
  }

  /** Finalize a successful absent-or-JSON completion against the combined cap. */
  success(logs: string[], value?: PtcJsonValue): PtcRunResult {
    if (value !== undefined && jsonValueBytesUpTo(value, this.maxBytes - this.bytes) === undefined) return this.limit(logs)
    return { logs, ...value !== undefined ? { value } : {} }
  }

  /** Finalize a failure diagnostic, with output-limit taking precedence when combined bytes exceed the cap. */
  failure(logs: string[], error: PtcRunFailure): PtcRunResult {
    if (jsonStringBytesUpTo(error.message, this.maxBytes - this.bytes) === undefined) return this.limit(logs)
    return { logs, error }
  }

  /** Build the explicit output-limit failure while retaining a fitting prefix of the final log. */
  limit(logs: string[]): PtcRunResult {
    const fullMessage = `outer output exceeded ${this.maxBytes} bytes`
    // The fixed diagnostic is ASCII, so every character is one byte plus the quotes.
    const messageBytes = fullMessage.length + 2
    const retained: string[] = []
    let retainedBytes = 2
    const logBudget = this.maxBytes - messageBytes
    for (const text of logs) {
      const separatorBytes = retained.length > 0 ? 1 : 0
      const availableBytes = logBudget - retainedBytes - separatorBytes
      const stringBytes = jsonStringBytesUpTo(text, availableBytes)
      if (stringBytes !== undefined) {
        retained.push(text)
        retainedBytes += stringBytes + separatorBytes
        continue
      }
      const prefix = truncateJsonStringBytes(text, availableBytes)
      if (prefix.length > 0) {
        const prefixBytes = jsonStringBytesUpTo(prefix, availableBytes)
        /* v8 ignore next -- truncateJsonStringBytes guarantees its returned prefix fits the same budget. */
        if (prefixBytes === undefined) throw new Error('output ledger produced an oversized log prefix')
        retained.push(prefix)
        retainedBytes += prefixBytes + separatorBytes
      }
      break
    }
    const availableMessageBytes = this.maxBytes - retainedBytes
    const message = truncateJsonStringBytes(fullMessage, availableMessageBytes)
    return { logs: retained, error: { kind: 'output-limit', message } }
  }
}
