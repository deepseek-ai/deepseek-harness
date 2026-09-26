/** Browser lifetime for the isolated spreadsheet parser. */
import workerSource from './worker.ts?raw'
import type { ExcelFormat } from './format.ts'
import { EXCEL_UNSUPPORTED_FEATURES, type ExcelLimits, type ExcelPreview } from './model.ts'

/**
 * Parse workbook bytes in a disposable Worker, copying the retained preview buffer.
 * @param bytes - Borrowed complete file bytes.
 * @param format - Format selected by the registered filename suffix.
 * @param limits - File, matrix, and elapsed-time limits.
 * @param signal - Document body's lifetime.
 * @returns Parsed sheets; rejects with a locale key on parser failures.
 */
export function parseExcel(
  bytes: Uint8Array<ArrayBuffer>, format: ExcelFormat, limits: ExcelLimits, signal: AbortSignal,
): Promise<ExcelPreview> {
  signal.throwIfAborted()
  if (bytes.byteLength > limits.maxBytes) return Promise.reject(new Error('tooLarge'))
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }))
    let worker: Worker
    try {
      worker = new Worker(url, { name: 'dsh-excel' })
    } catch (error) {
      URL.revokeObjectURL(url)
      reject(new Error('invalid', { cause: error }))
      return
    }
    const finish = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
      URL.revokeObjectURL(url)
    }
    const abort = (): void => { finish(); reject(new DOMException('Excel preview closed', 'AbortError')) }
    const fail = (): void => { finish(); reject(new Error('invalid')) }
    const timer = setTimeout(() => { finish(); reject(new Error('timeout')) }, limits.timeoutMs)
    worker.onerror = fail
    worker.onmessageerror = fail
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data
      if (typeof message !== 'object' || message === null || !('ok' in message)) { fail(); return }
      if (message.ok === true && 'value' in message && validPreview(message.value)) {
        finish()
        resolve(message.value)
      } else if (message.ok === false && 'code' in message && ['invalid', 'tooLarge', 'timeout', 'encoding'].includes(String(message.code))) {
        finish()
        reject(new Error(String(message.code)))
      } else fail()
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const copy = bytes.slice()
      worker.postMessage({ bytes: copy, format, limits }, [copy.buffer])
    } catch (error) { finish(); reject(new Error('invalid', { cause: error })) }
  })
}

function validPreview(value: unknown): value is ExcelPreview {
  if (typeof value !== 'object' || value === null || !('sheets' in value) || !('missingResults' in value)) return false
  return typeof value.missingResults === 'number' && Number.isSafeInteger(value.missingResults) && value.missingResults >= 0
    && 'unsupportedFeatures' in value && Array.isArray(value.unsupportedFeatures)
    && value.unsupportedFeatures.every((feature: unknown) => EXCEL_UNSUPPORTED_FEATURES.some(known => known === feature))
    && Array.isArray(value.sheets) && value.sheets.length > 0
    && value.sheets.every((sheet: unknown) => typeof sheet === 'object' && sheet !== null && 'name' in sheet && typeof sheet.name === 'string'
      && 'celldata' in sheet && Array.isArray(sheet.celldata))
}
