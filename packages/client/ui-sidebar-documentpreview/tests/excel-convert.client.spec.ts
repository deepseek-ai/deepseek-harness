/** XLSX formatting, cached formula results, and resource admission. */
import ExcelJS from 'exceljs'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { convertExcel } from '../src/client/excel/convert.ts'
import { Config } from '../src/config.ts'
import { excelFixture, meetingMinutesFixture } from './excel-fixture.ts'

const limits = Config({}).excel

describe('Excel conversion', () => {
  it('keeps values, dates, cached formulas, styles, merges, dimensions, visibility, and frozen headings', async () => {
    const input = await excelFixture()
    const { sheets, missingResults } = await convertExcel(input, 'xlsx', limits)
    expect(input.byteLength).toBeGreaterThan(0)
    expect(sheets.map(sheet => sheet.name)).toEqual(['季度预算', '公式与格式', '隐藏页'])
    const first = sheets[0]!
    const cell = (r: number, c: number) => first.celldata!.find(value => value.r === r && value.c === c)!.v
    expect(cell(0, 0)).toMatchObject({ v: 'DeepSeek · 项目预算', bl: 1, fs: 18, fc: '#FFFFFF', bg: '#3B5CCC', ht: 0, vt: 0, mc: { r: 0, c: 0, rs: 1, cs: 4 } })
    expect(cell(0, 1)).toMatchObject({ mc: { r: 0, c: 0 } })
    expect(cell(0, 1)).not.toHaveProperty('v')
    expect(cell(2, 3)).toMatchObject({ f: '=C3/B3', v: 0.8, m: '80.0%', ct: { fa: '0.0%', t: 'n' } })
    expect(cell(4, 1)).toMatchObject({ f: '=SUM(B3:B4)', v: 57000, m: '57,000.00' })
    expect(first.config).toMatchObject({ rowlen: { 0: 48 }, columnlen: { 0: 173 }, merge: { '0_0': { rs: 1, cs: 4 } } })
    expect(first.config!.borderInfo).toContainEqual({ rangeType: 'cell', value: { row_index: 1, col_index: 0, b: { style: 1, color: '#DCE2ED' } } })
    expect(first.frozen).toEqual({ type: 'rangeBoth', range: { row_focus: 1, column_focus: 0 } })
    expect(first.luckysheet_select_save).toEqual([{ row: [0, 0], column: [0, 3], row_focus: 0, column_focus: 0 }])
    const second = sheets[1]!
    const secondCell = (r: number, c: number) => second.celldata!.find(value => value.r === r && value.c === c)!.v!
    expect(second.luckysheet_select_save).toEqual([{ row: [0, 0], column: [0, 0], row_focus: 0, column_focus: 0 }])
    expect(secondCell(0, 0)).toMatchObject({ f: '=_xlfn.XLOOKUP(1,{1},{42})', v: 42, m: '42' })
    expect(secondCell(1, 0)).toMatchObject({ f: '=SUM(1,2)', m: '' })
    expect(secondCell(0, 1)).toMatchObject({ m: '2026-09-16' })
    expect(secondCell(0, 2)).toMatchObject({ v: '富文本 示例', ct: { t: 'inlineStr' } })
    expect(secondCell(0, 2).ct?.s).toBeInstanceOf(Array)
    expect(secondCell(0, 3)).toMatchObject({ v: 'Link text' })
    expect(secondCell(1, 3)).toMatchObject({ v: 'Rich link', ct: { t: 'inlineStr' } })
    expect(secondCell(2, 0)).toMatchObject({ f: '=SUM(1,2)', v: 3 })
    expect(secondCell(3, 0)).toMatchObject({ v: true })
    expect(secondCell(4, 0)).toMatchObject({ v: '#DIV/0!' })
    expect(secondCell(0, 5)).toMatchObject({ f: '=1-1', v: 0, m: '0' })
    expect(secondCell(1, 5)).toMatchObject({ f: '=1=2', v: false, m: 'false' })
    expect(second.config).toMatchObject({ rowhidden: { 6: 0 }, colhidden: { 4: 0 }, rowlen: { 6: 40 * 96 / 72 } })
    expect(sheets[2]).toMatchObject({ hide: 1, status: 0 })
    expect(missingResults).toBe(1)
  })

  it('opens workbooks with missing results and Chinese worksheet references', async () => {
    const { sheets, missingResults } = await convertExcel(await meetingMinutesFixture(), 'xlsx', limits)
    expect(sheets.map(sheet => sheet.name)).toEqual(['会议信息', '会议议程', '决议事项', '行动计划', '待确认问题', '风险与依赖', '统计看板', '填写说明'])
    const dashboard = sheets[6]!
    const cell = (r: number, c: number) => dashboard.celldata!.find(value => value.r === r && value.c === c)!.v
    expect(cell(4, 1)).toMatchObject({ f: '=COUNTIF(行动计划!$G$4:$G$23,$A5)', m: '' })
    expect(cell(4, 2)).toMatchObject({ f: '=IF($B5=0,"",REPT("█",MAX(1,ROUND($B5/MAX(1,$B$5)*16,0))))', m: '' })
    expect(cell(4, 3)).toMatchObject({ f: '=IFERROR($B5/$B$10,0)', m: '' })
    expect(missingResults).toBe(27)
  })

  it('rejects damaged files, byte limits and sparse worksheets that would allocate a large matrix', async () => {
    await expect(convertExcel(new Uint8Array([1, 2, 3]), 'xlsx', limits)).rejects.toMatchObject({ code: 'invalid' })
    const input = await excelFixture()
    await expect(convertExcel(input, 'xlsx', { ...limits, maxBytes: input.byteLength - 1 })).rejects.toMatchObject({ code: 'tooLarge' })
    const framed = new Uint8Array(input.byteLength + 2)
    framed.set(input, 1)
    await expect(convertExcel(framed.subarray(1, -1), 'xlsx', limits)).resolves.toMatchObject({ missingResults: 1 })
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('Sparse').getCell('Z1000').value = 1
    await expect(convertExcel(new Uint8Array(await workbook.xlsx.writeBuffer()), 'xlsx', { ...limits, maxCells: 25_000 })).rejects.toMatchObject({ code: 'tooLarge' })
    const styled = new ExcelJS.Workbook()
    styled.addWorksheet('Styled').getCell('A1').value = 1
    styled.getWorksheet('Styled')!.getCell('XFD1000').font = { bold: true }
    await expect(convertExcel(new Uint8Array(await styled.xlsx.writeBuffer()), 'xlsx', limits)).rejects.toMatchObject({ code: 'tooLarge' })
  })

  it('opens an empty worksheet and rejects workbooks with no visible sheet', async () => {
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('Empty')
    const result = await convertExcel(new Uint8Array(await workbook.xlsx.writeBuffer()), 'xlsx', limits)
    expect(result.sheets[0]).toMatchObject({ name: 'Empty', row: 1, column: 1, status: 1 })
    workbook.getWorksheet('Empty')!.state = 'veryHidden'
    await expect(convertExcel(new Uint8Array(await workbook.xlsx.writeBuffer()), 'xlsx', limits)).rejects.toMatchObject({ code: 'invalid' })
  })

  it('ignores row and column layout outside emitted cell bounds', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Layout')
    for (let row = 1; row <= 30; row += 1) sheet.getCell(row, 1).value = row
    sheet.getColumn(16_384).width = 20
    sheet.getRow(1000).height = 40
    const result = await convertExcel(new Uint8Array(await workbook.xlsx.writeBuffer()), 'xlsx', limits)
    expect(result.sheets[0]).toMatchObject({ row: 30, column: 1 })
    expect(result.sheets[0]!.config!.columnlen).not.toHaveProperty('16383')
    expect(result.sheets[0]!.config!.rowlen).not.toHaveProperty('999')
  })

  it.each([false, true])('retains dates for the 1904 epoch flag %s', async (date1904) => {
    const workbook = new ExcelJS.Workbook()
    workbook.properties.date1904 = date1904
    const cell = workbook.addWorksheet('Dates').getCell('A1')
    cell.value = new Date('2024-02-29T12:00:00Z')
    cell.numFmt = 'yyyy-mm-dd hh:mm'
    const result = await convertExcel(new Uint8Array(await workbook.xlsx.writeBuffer()), 'xlsx', limits)
    expect(result.sheets[0]!.celldata![0]!.v).toMatchObject({ m: '2024-02-29 12:00' })
  })

  it('maps custom colors, tints, alignment, decoration, and default dimensions', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Styles')
    sheet.properties.defaultColWidth = 12
    sheet.getColumn(1).width = 0.5
    const light = { theme: 4, tint: 0.5 }
    const dark = { theme: 4, tint: -0.5 }
    sheet.getCell('A1').value = 'Light'
    sheet.getCell('A1').font = { color: light, strike: true, underline: true }
    sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: dark }
    sheet.getCell('A1').alignment = { horizontal: 'right', vertical: 'top', wrapText: true, textRotation: 'vertical' }
    sheet.getCell('B1').value = 'Rotated'
    sheet.getCell('B1').alignment = { horizontal: 'left', vertical: 'bottom', textRotation: 45 }
    sheet.getCell('B1').border = { top: { style: 'double' } }
    sheet.getCell('C1').value = 'Automatic color'
    sheet.getCell('C1').font = { color: { indexed: 64 } as Partial<ExcelJS.Color> }
    sheet.getCell('D1').value = 'Invalid color'
    sheet.getCell('D1').font = { color: { argb: 'invalid' } }
    sheet.getCell('E1').value = 'Untinted'
    sheet.getCell('E1').font = { color: { argb: 'FFFF0000', tint: 0 } as Partial<ExcelJS.Color> }
    sheet.getCell('F1').value = 42
    sheet.getCell('F1').alignment = { vertical: 'middle' }
    sheet.getCell('G1').value = 'No underline'
    sheet.getCell('G1').font = { underline: 'none' }
    const result = await convertExcel(new Uint8Array(await workbook.xlsx.writeBuffer()), 'xlsx', limits)
    expect(result.sheets[0]).toMatchObject({ defaultColWidth: 89, config: { columnlen: { 0: 6 } } })
    const cells = result.sheets[0]!.celldata!
    expect(cells[0]!.v).toMatchObject({ fc: '#a7c0de', bg: '#28415f', cl: 1, un: 1, ht: 2, vt: 1, tb: '2', tr: '3' })
    expect(cells[1]!.v).toMatchObject({ ht: 1, vt: 2, rt: 45 })
    expect(cells[2]!.v).not.toHaveProperty('fc')
    expect(cells[3]!.v).not.toHaveProperty('fc')
    expect(cells[4]!.v).toMatchObject({ fc: '#FF0000' })
    expect(cells[5]!.v).toMatchObject({ v: 42, ht: 2, vt: 0, ct: { t: 'n' } })
    expect(cells[6]!.v).toMatchObject({ v: 'No underline', un: 0 })
  })

  it.each([{ ySplit: 2 }, { xSplit: 1 }, {}])('maps one-axis or empty freeze settings %j', async (freeze) => {
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('Frozen', { views: [{ state: 'frozen', ...freeze, showGridLines: false }] }).getCell('A1').value = 1
    const result = await convertExcel(new Uint8Array(await workbook.xlsx.writeBuffer()), 'xlsx', limits)
    expect(result.sheets[0]!.showGridLines).toBe(false)
    expect(result.sheets[0]!.frozen?.type).toBe('ySplit' in freeze ? 'rangeRow' : 'xSplit' in freeze ? 'rangeColumn' : undefined)
  })

  it('accepts workbooks without a theme and ignores absent theme colors', async () => {
    const files = unzipSync(await excelFixture())
    delete files['xl/theme/theme1.xml']
    expect((await convertExcel(new Uint8Array(zipSync(files)), 'xlsx', limits)).sheets).toHaveLength(3)
    files['xl/theme/theme1.xml'] = strToU8('<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="Custom"><a:lt1><a:sysClr val="window" lastClr="FEFEFE"/></a:lt1></a:clrScheme></a:themeElements></a:theme>')
    expect((await convertExcel(new Uint8Array(zipSync(files)), 'xlsx', limits)).sheets).toHaveLength(3)
  })
})
