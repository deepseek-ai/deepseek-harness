/** Format-specific parsing into one read-only FortuneSheet representation. */
import type { ExcelFormat } from './format.ts'
import { ExcelPreviewError } from './error.ts'
import type { ExcelLimits, ExcelPreview } from './model.ts'
import { convertXlsx } from './xlsx.ts'
import { convertXls } from './xls.ts'
import { convertDelimited } from './delimited.ts'

/**
 * Decode spreadsheet bytes without recalculating saved formulas.
 * @param bytes - Borrowed complete file bytes.
 * @param format - Format selected by the registered filename suffix.
 * @param limits - File and matrix allocation limits.
 * @returns Display sheets and missing formula-cache count.
 */
export async function convertExcel(bytes: Uint8Array<ArrayBuffer>, format: ExcelFormat, limits: ExcelLimits): Promise<ExcelPreview> {
  if (bytes.byteLength > limits.maxBytes) throw new ExcelPreviewError('tooLarge')
  if (format === 'xlsx') return convertXlsx(bytes, limits)
  if (format === 'xls') return convertXls(bytes, limits)
  return convertDelimited(bytes, format, limits)
}
