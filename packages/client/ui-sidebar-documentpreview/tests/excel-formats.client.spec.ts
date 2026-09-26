/** Additional spreadsheet formats retain layout and literal delimited fields. */
import { readFileSync } from 'node:fs'
import { utils, write } from 'xlsx'
import { expect, it } from 'vitest'
import { Config } from '../src/config.ts'
import { convertExcel } from '../src/client/excel/convert.ts'
import { excelFormat } from '../src/client/excel/format.ts'
import { mapXlsWorkbook } from '../src/client/excel/xls.ts'
import { legacyWorkbook, xlsFixture } from './xls-fixture.ts'

const limits = Config({}).excel
const encode = (text: string) => new TextEncoder().encode(text)

it.each(['xlsx', 'xls', 'csv', 'tsv'] as const)('resolves mixed-case %s paths and enforces byte limits', async (format) => {
  expect(excelFormat(`/dir.name/sheet.${format.toUpperCase()}`)).toBe(format)
  await expect(convertExcel(new Uint8Array(2), format, { ...limits, maxBytes: 1 })).rejects.toMatchObject({ code: 'tooLarge' })
})

it('rejects unsupported filename suffixes', () => {
  expect(() => excelFormat('file.xlsm')).toThrow('invalid')
})

it.each([false, true])('reads BIFF values, formulas, merges, layout, and dates with 1904 epoch %s', async (date1904) => {
  const { sheets, missingResults } = await convertExcel(xlsFixture(legacyWorkbook(date1904)), 'xls', limits)
  expect(sheets.map(sheet => [sheet.name, sheet.hide, sheet.status])).toEqual([['预算', 0, 1], ['明细', 0, 0], ['隐藏', 1, 0]])
  const first = sheets[0]!
  const cell = (r: number, c: number) => first.celldata!.find(cell => cell.r === r && cell.c === c)!.v!
  expect(cell(0, 0)).toMatchObject({ v: '旧版预算', mc: { r: 0, c: 0, rs: 1, cs: 3 } })
  expect(cell(0, 1)).toEqual({ mc: { r: 0, c: 0 } })
  expect(cell(2, 1)).toMatchObject({ v: 1234.5, m: '1,234.50' })
  expect(cell(2, 2)).toMatchObject({ v: 0.25, m: '25.0%' })
  expect(cell(3, 1)).toMatchObject({ f: '=1+2', v: 3, m: '3' })
  expect(cell(4, 1)).toMatchObject({ m: '2024-03-01' })
  expect(cell(4, 2)).toMatchObject({ v: true })
  expect(first.config).toMatchObject({ colhidden: { 2: 0 } })
  expect(first.config!.columnlen![0]).toBeGreaterThan(100)
  expect(first.luckysheet_select_save).toEqual([{ row: [0, 0], column: [0, 2], row_focus: 0, column_focus: 0 }])
  expect(missingResults).toBe(0)
})

it('reads an independently generated Office XLS fixture', async () => {
  const bytes = readFileSync(new URL('../../../../apps/web/tests/fixtures/office/preview.xls', import.meta.url))
  const result = await convertExcel(new Uint8Array(bytes), 'xls', limits)
  expect(result.sheets.flatMap(sheet => sheet.celldata).some(cell => String(cell?.v?.v).includes('Office preview'))).toBe(true)
})

it('maps optional row metadata, empty formula caches, errors, and Date values', () => {
  // SheetJS reads row metadata but its BIFF writer omits ROW records.
  const workbook = legacyWorkbook()
  const sheet = workbook.Sheets['预算']!
  sheet['!rows'] = [{ hpt: 30 }, { hpx: 18 }, { hidden: true }, {}]
  sheet['!cols'] = [{ wpx: 130 }, { hidden: true }, {}]
  sheet['B4'] = { t: 'n', f: '1+2' }
  sheet['B5'] = { t: 'd', v: new Date('2024-03-01T00:00:00Z'), z: 'yyyy-mm-dd' }
  sheet['C5'] = { t: 'e', v: 7, w: '#DIV/0!' }
  const { sheets, missingResults } = mapXlsWorkbook(workbook, limits)
  const cell = (r: number, c: number) => sheets[0]!.celldata!.find(value => value.r === r && value.c === c)!.v!
  expect(sheets[0]!.config).toMatchObject({ rowlen: { 0: 40, 1: 18 }, rowhidden: { 2: 0 }, columnlen: { 0: 130 }, colhidden: { 1: 0 } })
  expect(cell(3, 1)).toMatchObject({ f: '=1+2', m: '' })
  expect(cell(4, 1)).toMatchObject({ m: '2024-03-01' })
  expect(cell(4, 2)).toMatchObject({ v: '#DIV/0!' })
  expect(missingResults).toBe(1)
})

it('rejects damaged, renamed, hidden-only, and oversized legacy workbooks', async () => {
  for (const bytes of [encode('a,b\n1,2'), encode('<html>not a workbook</html>'), new Uint8Array([9, 8, 0]), new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])]) {
    await expect(convertExcel(bytes, 'xls', limits)).rejects.toMatchObject({ code: 'invalid' })
  }
  const workbook = legacyWorkbook()
  const metadata = workbook.Workbook?.Sheets
  if (metadata === undefined) throw new Error('legacy fixture has no workbook sheet metadata')
  metadata.forEach((sheet) => { sheet.Hidden = 1 })
  await expect(convertExcel(xlsFixture(workbook), 'xls', limits)).rejects.toMatchObject({ code: 'invalid' })
  await expect(convertExcel(xlsFixture(), 'xls', { ...limits, maxCells: 10 })).rejects.toMatchObject({ code: 'tooLarge' })
  const sparse = utils.book_new()
  utils.book_append_sheet(sparse, { '!ref': 'A1:Z1000', Z1000: { t: 'n', v: 1 } }, 'Sparse')
  await expect(convertExcel(xlsFixture(sparse), 'xls', { ...limits, maxCells: 25_999 })).rejects.toMatchObject({ code: 'tooLarge' })
  const missing = utils.book_new()
  missing.SheetNames.push('Missing')
  expect(() => mapXlsWorkbook(missing, limits)).toThrow('invalid')
})

it('opens raw BIFF and empty legacy worksheets', async () => {
  const workbook = utils.book_new()
  utils.book_append_sheet(workbook, utils.aoa_to_sheet([['BIFF']]), 'Sheet')
  const biff = new Uint8Array(write(workbook, { type: 'array', bookType: 'biff2' }) as ArrayBuffer)
  expect((await convertExcel(biff, 'xls', limits)).sheets[0]!.celldata![0]!.v!.v).toBe('BIFF')
  workbook.Sheets['Sheet'] = {}
  expect((await convertExcel(xlsFixture(workbook), 'xls', limits)).sheets[0]).toMatchObject({ row: 1, column: 1, status: 1 })
  const sheet = workbook.Sheets['Sheet']
  if (sheet === undefined) throw new Error('legacy fixture has no Sheet worksheet')
  delete sheet['!ref']
  expect(mapXlsWorkbook(workbook, limits).sheets[0]).toMatchObject({ row: 1, column: 1 })
  workbook.Sheets['Sheet'] = { '!ref': 'A1', A1: { t: 'n', v: 12 } }
  workbook.Workbook = { WBProps: { date1904: true } }
  expect(mapXlsWorkbook(workbook, limits).sheets[0]!.celldata![0]!.v!.v).toBe(12)
})

it.each(['csv', 'tsv'] as const)('preserves %s strings, quoted separators, newlines, empty fields, and ragged rows', async (format) => {
  const delimiter = format === 'csv' ? ',' : '\t'
  const text = ['编号', '说明', '值'].join(delimiter) + '\r\n'
    + ['00123', `"中文${delimiter}字段\n第二行 ""引号"""`, '=SUM(1,2)'].map((field, index) => index === 2 ? '"' + field + '"' : field).join(delimiter) + '\r\n'
    + ['2024-03-01', '', 'TRUE', '99999999999999999999'].join(delimiter) + '\r\nshort\r\n\r\n'
  const result = await convertExcel(encode(text), format, limits)
  const sheet = result.sheets[0]!
  const cell = (r: number, c: number) => sheet.celldata!.find(cell => cell.r === r && cell.c === c)!.v!
  expect(sheet.column).toBe(4)
  expect(cell(0, 0).v).toBe('编号')
  expect(cell(1, 0)).toMatchObject({ v: '00123', ct: { t: 's', fa: '@' } })
  expect(cell(1, 1).v).toBe(`中文${delimiter}字段\n第二行 "引号"`)
  expect(cell(1, 2)).toMatchObject({ v: '=SUM(1,2)', m: '=SUM(1,2)' })
  expect(cell(1, 2)).not.toHaveProperty('f')
  expect(cell(2, 0).v).toBe('2024-03-01')
  expect(cell(2, 1).v).toBe('')
  expect(cell(2, 2).v).toBe('TRUE')
  expect(cell(2, 3).v).toBe('99999999999999999999')
  expect(cell(3, 0).v).toBe('short')
  expect(sheet.row).toBeGreaterThan(4)
  expect(result.missingResults).toBe(0)
})

it.each(['utf8', 'le', 'be'] as const)('decodes BOM-marked %s text', async (encoding) => {
  const text = '\ufeff名称,编号\n中文,001'
  const bytes = encoding === 'utf8' ? encode(text) : new Uint8Array(Buffer.from(text, 'utf16le'))
  if (encoding === 'be') for (let i = 0; i < bytes.length; i += 2) [bytes[i], bytes[i + 1]] = [bytes[i + 1]!, bytes[i]!]
  const sheet = (await convertExcel(bytes, 'csv', limits)).sheets[0]!
  expect(sheet.celldata![0]!.v!.v).toBe('名称')
  expect(sheet.celldata!.find(cell => cell.r === 1 && cell.c === 0)!.v!.v).toBe('中文')
})

it('handles empty text and rejects invalid encoding, broken quoting, and excess area', async () => {
  expect((await convertExcel(encode(''), 'csv', limits)).sheets[0]).toMatchObject({ row: 1, column: 1 })
  for (const bytes of [new Uint8Array([0xff]), new Uint8Array([0xff, 0xfe, 1])]) {
    await expect(convertExcel(bytes, 'csv', limits)).rejects.toMatchObject({ code: 'encoding' })
  }
  await expect(convertExcel(encode('a,"unclosed'), 'csv', limits)).rejects.toMatchObject({ code: 'invalid' })
  await expect(convertExcel(encode('a,b\nc,d'), 'csv', { ...limits, maxCells: 3 })).rejects.toMatchObject({ code: 'tooLarge' })
  expect((await convertExcel(encode('a,b\nc,d'), 'csv', { ...limits, maxCells: 4 })).sheets[0]).toMatchObject({ row: 2, column: 2 })
})
