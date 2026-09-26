/** One workbook per disposable parser Worker; formulas and external links are never executed. */
import { convertExcel } from './convert.ts'
import type { ExcelFormat } from './format.ts'
import { ExcelPreviewError } from './error.ts'
import type { ExcelLimits } from './model.ts'

globalThis.onmessage = (event: MessageEvent<{ bytes: Uint8Array<ArrayBuffer>; format: ExcelFormat; limits: ExcelLimits }>) => {
  void convertExcel(event.data.bytes, event.data.format, event.data.limits).then(
    (value) => { globalThis.postMessage({ ok: true, value }) },
    (error: unknown) => { globalThis.postMessage({ ok: false, code: error instanceof ExcelPreviewError ? error.code : 'invalid' }) },
  )
}
