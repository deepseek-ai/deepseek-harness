/** Shared display cells, resource limits, and parser failure categories. */
import { update as formatNumber, type Cell, type Sheet, type SheetConfig } from '@fortune-sheet/core'

/** Resource limits applied before allocating FortuneSheet's dense cell matrices. */
export interface ExcelLimits {
  /** Maximum source file bytes. */
  maxBytes: number
  /** Maximum combined rectangular cell area across worksheets. */
  maxCells: number
  /** Maximum time allowed for one parser Worker. */
  timeoutMs: number
}

/** Content categories reported in stable order when XLSX preview omits them. */
export const EXCEL_UNSUPPORTED_FEATURES = ['charts', 'images', 'shapes', 'conditionalFormatting'] as const

/** A detected workbook feature that the spreadsheet preview does not display. */
export type ExcelUnsupportedFeature = typeof EXCEL_UNSUPPORTED_FEATURES[number]

/** Preview data, missing formula results, and detected content that is not displayed. */
export interface ExcelPreview {
  sheets: Sheet[]
  missingResults: number
  unsupportedFeatures: ExcelUnsupportedFeature[]
}

/**
 * Retain an addressable A1 selection, including an A1 merge.
 * @param config - Worksheet layout.
 * @returns The initial selection used when activating a worksheet.
 */
export function initialSelection(config: SheetConfig): NonNullable<Sheet['luckysheet_select_save']> {
  const merge = config.merge?.['0_0']
  return [{ row: [0, (merge?.rs ?? 1) - 1], column: [0, (merge?.cs ?? 1) - 1], row_focus: 0, column_focus: 0 }]
}

/**
 * Apply number formatting and default alignment without evaluating formulas.
 * @param cell - Owned display cell to complete.
 * @param numberFormat - Excel number format code.
 * @returns The same cell with its display text and value type.
 */
export function formatCell(cell: Cell, numberFormat: string): Cell {
  if (cell.ht === undefined) cell.ht = typeof cell.v === 'number' ? 2 : typeof cell.v === 'boolean' ? 0 : 1
  if (cell.ct === undefined) cell.ct = { fa: numberFormat, t: typeof cell.v === 'number' ? 'n' : typeof cell.v === 'boolean' ? 'b' : 's' }
  const formatted = typeof cell.v === 'number' ? formatNumber(numberFormat, cell.v) as string | number : cell.v
  cell.m = formatted === undefined ? '' : String(formatted)
  return cell
}
