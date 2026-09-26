/** Filename-to-parser selection kept outside the heavy spreadsheet chunk. */
import { ExcelPreviewError } from './error.ts'

/** File formats admitted by the spreadsheet preview. */
export type ExcelFormat = 'xlsx' | 'xls' | 'csv' | 'tsv'

/**
 * Resolve a registered filename to its parser.
 * @param path - Decoded file path.
 * @returns The supported suffix; rejects unsupported filenames.
 */
export function excelFormat(path: string): ExcelFormat {
  const suffix = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (suffix === 'xlsx' || suffix === 'xls' || suffix === 'csv' || suffix === 'tsv') return suffix
  throw new ExcelPreviewError('invalid')
}
