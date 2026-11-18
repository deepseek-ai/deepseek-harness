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
  truncated = false

  constructor(private readonly maxBytes: number) {}

  /** Admit one ordered text or image entry against the combined output budget. */
  admit(entry: PtcOutput, sink: PtcOutput[]): boolean {
    if (this.truncated) return false
    const separatorBytes = this.entries > 0 ? 1 : 0
    const remaining = this.maxBytes - this.bytes - separatorBytes
    const bytes = entryBytes(entry, remaining)
    if (bytes === undefined) {
      this.truncated = true
      if (entry.type === 'text') {
        const prefix = truncateJsonStringBytes(entry.text, remaining)
        if (prefix.length > 0) sink.push({ type: 'text', text: prefix })
      }
      return false
    }
    this.bytes += bytes + separatorBytes
    this.entries += 1
    sink.push(entry)
    return true
  }

  /** Finalize a successful absent-or-JSON completion against the combined cap. */
  success(output: PtcOutput[], value?: PtcJsonValue): PtcRunResult {
    const valueBytes = value === undefined ? 0 : jsonValueBytesUpTo(value, this.maxBytes - 2)
    if (valueBytes === undefined) return this.failure(output, { kind: 'output-limit', message: `completion value exceeded ${this.maxBytes} bytes` })
    return { ...this.retain(output, valueBytes), ...value !== undefined ? { value } : {} }
  }

  /** Prioritize the terminal diagnostic without changing its failure kind. */
  failure(output: PtcOutput[], error: PtcRunFailure): PtcRunResult {
    const message = truncateJsonStringBytes(error.message, this.maxBytes - 2)
    if (message !== error.message) this.truncated = true
    return { ...this.retain(output, Buffer.byteLength(JSON.stringify(message))), error: { ...error, message } }
  }

  /** Keep an ordered prefix after reserving bytes for the completion or diagnostic. */
  private retain(output: PtcOutput[], terminalBytes: number): Pick<PtcRunResult, 'output' | 'outputTruncated'> {
    const retained: PtcOutput[] = []
    const ledger = new OutputLedger(this.maxBytes - terminalBytes)
    for (const entry of output) {
      if (!ledger.admit(entry, retained)) break
    }
    this.truncated ||= ledger.truncated
    return { output: retained, ...this.truncated ? { outputTruncated: true } : {} }
  }
}
