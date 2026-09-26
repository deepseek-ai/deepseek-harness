/** Legacy BIFF workbooks mapped to saved values and basic spreadsheet layout. */
import { read, set_cptable, utils, SSF, type CellObject, type WorkBook } from 'xlsx'
import * as codepages from 'xlsx/dist/cpexcel.full.mjs'
import type { Cell, Sheet, SheetConfig } from '@fortune-sheet/core'
import { ExcelPreviewError } from './error.ts'
import { formatCell, initialSelection, type ExcelLimits, type ExcelPreview } from './model.ts'

set_cptable(codepages)
// SheetJS publishes SSF as `any`; this is the one formatter capability used by the adapter.
const spreadsheetFormatter = SSF as { is_date(format: string): boolean }
const isDateFormat = (format: string) => spreadsheetFormatter.is_date(format)

/**
 * Decode a binary XLS workbook without accepting renamed text or HTML files.
 * @param bytes - Borrowed complete workbook bytes.
 * @param limits - Maximum combined worksheet area.
 * @returns Saved values, formulas, and supported workbook layout.
 */
export function convertXls(bytes: Uint8Array<ArrayBuffer>, limits: ExcelLimits): ExcelPreview {
  const compound = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((value, index) => bytes[index] === value)
  const biffVersion = bytes.at(1)
  const biff = bytes[0] === 0x09 && biffVersion !== undefined && [0x00, 0x02, 0x04, 0x08].includes(biffVersion)
  if (!compound && !biff) throw new ExcelPreviewError('invalid')
  let workbook: ReturnType<typeof read>
  try { workbook = read(bytes, { type: 'array', cellNF: true, cellStyles: true, cellFormula: true, sheetStubs: true }) }
  catch (error) { throw new ExcelPreviewError('invalid', { cause: error }) }
  return mapXlsWorkbook(workbook, limits)
}

/**
 * Map SheetJS values and optional BIFF layout metadata without retaining the workbook.
 * @param workbook - Parsed legacy workbook.
 * @param limits - Maximum combined worksheet area.
 * @returns FortuneSheet display data.
 */
export function mapXlsWorkbook(workbook: WorkBook, limits: ExcelLimits): ExcelPreview {
  let area = 0
  let missingResults = 0
  const visibleSheets = workbook.SheetNames.map((_name, order) => !workbook.Workbook?.Sheets?.[order]?.Hidden)
  const activeOrder = visibleSheets.indexOf(true)
  if (activeOrder === -1) throw new ExcelPreviewError('invalid')
  const sheets = workbook.SheetNames.map((name, order): Sheet => {
    const source = workbook.Sheets[name]
    if (source === undefined) throw new ExcelPreviewError('invalid')
    const range = utils.decode_range(source['!ref'] ?? 'A1')
    for (const merge of source['!merges'] ?? []) {
      range.e.r = Math.max(range.e.r, merge.e.r)
      range.e.c = Math.max(range.e.c, merge.e.c)
    }
    const row = Math.max(range.e.r + 1, source['!rows']?.length ?? 1)
    const column = Math.max(range.e.c + 1, source['!cols']?.length ?? 1)
    area += row * column
    if (!Number.isSafeInteger(area) || area > limits.maxCells) throw new ExcelPreviewError('tooLarge')
    const config: Required<Pick<SheetConfig, 'merge' | 'rowlen' | 'columnlen' | 'rowhidden' | 'colhidden'>> = {
      merge: {}, rowlen: {}, columnlen: {}, rowhidden: {}, colhidden: {},
    }
    source['!rows']?.forEach((value, index) => {
      const height = value.hpx ?? (value.hpt === undefined ? undefined : value.hpt * 96 / 72)
      if (height !== undefined) config.rowlen[index] = height
      if (value.hidden) config.rowhidden[index] = 0
    })
    source['!cols']?.forEach((value, index) => {
      if (value.wpx !== undefined) config.columnlen[index] = value.wpx
      if (value.hidden) config.colhidden[index] = 0
    })
    const cells = new Map<string, { r: number; c: number; v: Cell }>()
    for (const address of Object.keys(source)) {
      if (address.startsWith('!')) continue
      const cell = source[address] as CellObject
      const v: Cell = {}
      if (cell.f !== undefined) v.f = `=${cell.f}`
      if (cell.t === 'e') v.v = utils.format_cell(cell)
      else if (cell.v instanceof Date) v.v = cell.v.getTime() / 86_400_000 + 25569
      else if (cell.t !== 'z' && cell.v !== undefined) {
        v.v = cell.v
        if (typeof v.v === 'number' && workbook.Workbook?.WBProps?.date1904 && isDateFormat(String(cell.z ?? 'General'))) v.v += 1462
      }
      if (v.f !== undefined && v.v === undefined) missingResults += 1
      const { r, c } = utils.decode_cell(address)
      cells.set(`${r}_${c}`, { r, c, v: formatCell(v, String(cell.z ?? 'General')) })
    }
    for (const { s, e } of source['!merges'] ?? []) {
      const merge = { r: s.r, c: s.c, rs: e.r - s.r + 1, cs: e.c - s.c + 1 }
      config.merge[`${s.r}_${s.c}`] = merge
      for (let r = s.r; r <= e.r; r += 1) for (let c = s.c; c <= e.c; c += 1) {
        const key = `${r}_${c}`
        const cell = cells.get(key) ?? { r, c, v: {} }
        if (r === s.r && c === s.c) cell.v.mc = merge
        else cell.v = { mc: { r: s.r, c: s.c } }
        cells.set(key, cell)
      }
    }
    const visible = visibleSheets[order] === true
    const status = order === activeOrder ? 1 : 0
    return { id: String(order + 1), name, order, status, hide: visible ? 0 : 1, row, column,
      config, celldata: [...cells.values()], luckysheet_select_save: initialSelection(config) }
  })
  return { sheets, missingResults, unsupportedFeatures: [] }
}
