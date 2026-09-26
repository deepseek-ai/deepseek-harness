/** OPC part resolution and namespace aliases preserve independent-writer workbook contents. */
import { createRequire } from 'node:module'
import ExcelJS from 'exceljs'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.ts'
import { convertExcel } from '../src/client/excel/convert.ts'
import { XlsxPreviewArchive } from '../src/client/excel/xlsx-archive.ts'
import { excelOpcCases, excelOpcFixture } from './excel-opc-fixture.ts'
import { excelFixture, excelHtmlFixture } from './excel-fixture.ts'

const require = createRequire(import.meta.url)
const browserExcel = require('exceljs/dist/exceljs.js') as typeof ExcelJS
const limits = Config({}).excel
const relsPath = 'xl/worksheets/_rels/budget.xml.rels'

describe.each([['Node', ExcelJS], ['browser bundle', browserExcel]] as const)('%s ExcelJS entry', (_name, parser) => {
  it.each(excelOpcCases)('opens %s without changing source bytes', async (name) => {
    const source = await excelOpcFixture(name)
    const before = source.slice()
    const archive = new XlsxPreviewArchive(source)
    const input = archive.withoutDrawings()
    const workbook = new parser.Workbook()
    await workbook.xlsx.load(input.buffer, { ignoreNodes: ['drawing'] })
    const sheet = workbook.getWorksheet('数据')!
    expect(sheet.getCell('A1').value).toBe('Item')
    expect(sheet.getCell('B2').value).toBe(42)
    if (name === 'comments' || name === 'combined') {
      expect(sheet.getCell('B2').note).toBe('生成的批注')
    }
    if (name === 'table' || name === 'combined') {
      expect(sheet.getTable('DataTable')).toMatchObject({ table: { name: 'DataTable', tableRef: 'A1:B3' } })
    }
    expect(source).toEqual(before)
  })

  it('binds comment VML independently of relationship order and ZIP entry order', async () => {
    const source = await excelOpcFixture('combined')
    const files = unzipSync(new XlsxPreviewArchive(source).withoutDrawings())
    const comments = 'xl/comments/comment1.xml'
    files[comments] = strToU8(strFromU8(files[comments]!).replace('<text><t>', '<text><r><rPr><b/></rPr><t>').replace('</t></text>', '</t></r></text>'))
    const vml = 'xl/drawings/commentsDrawing1.vml'
    files[vml] = strToU8(strFromU8(files[vml]!).replace('insetmode="auto"', 'insetmode="custom"'))
    const xml = strFromU8(files[relsPath]!)
    const relations = xml.match(/<Relationship\b[^>]*\/>/g)!
    files[relsPath] = strToU8(xml.replace(relations.join(''), [...relations].reverse().join('')))
    const workbook = new parser.Workbook()
    await workbook.xlsx.load(new Uint8Array(zipSync(Object.fromEntries(Object.entries(files).reverse()))).buffer, { ignoreNodes: ['drawing'] })
    expect(workbook.getWorksheet('数据')!.getCell('B2').note).toMatchObject({
      texts: [{ text: '生成的批注', font: { bold: true } }], margins: { insetmode: 'custom' },
    })
  })
})

it('retains styles, formulas, hidden sheets and notices in the combined workbook', async () => {
  const source = await excelOpcFixture('combined')
  const result = await convertExcel(source, 'xlsx', limits)
  const sheet = result.sheets[0]!
  expect(result.sheets.map(sheet => [sheet.name, sheet.hide])).toEqual([['数据', 0], ['隐藏页', 1]])
  expect(sheet.celldata!.find(cell => cell.r === 1 && cell.c === 1)!.v).toMatchObject({ v: 42, bl: 1, fc: '#112233', bg: '#FFFF00' })
  expect(sheet.celldata!.find(cell => cell.r === 4 && cell.c === 0)!.v?.v).toBe(' <s:pic/> & 中文😀\n  tail ')
  expect(sheet.celldata!.find(cell => cell.r === 5 && cell.c === 0)!.v?.f).toBe('=SUM(B2:B3)')
  expect(sheet.config).toMatchObject({ merge: { '29_7': { r: 29, c: 7, rs: 1, cs: 3 } }, rowhidden: { 2: 0 }, colhidden: { 1: 0 } })
  expect(sheet.frozen).toMatchObject({ type: 'rangeBoth', range: { row_focus: 0, column_focus: 0 } })
  expect(result.unsupportedFeatures).toEqual(['charts', 'conditionalFormatting'])
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(new XlsxPreviewArchive(source).withoutDrawings().buffer, { ignoreNodes: ['drawing'] })
  expect(workbook.getWorksheet('数据')!.getCell('A2').hyperlink).toBe('https://example.com/?a=1&b=2')
})

it.each([excelFixture, excelHtmlFixture])('preserves cells and attributes under equivalent namespace aliases', async (fixture) => {
  const source = await fixture()
  const files = unzipSync(source)
  for (const [path, bytes] of Object.entries(files)) {
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(path)) continue
    files[path] = strToU8(strFromU8(bytes)
      .replace('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"', 'xmlns:s="http://schemas.openxmlformats.org/spreadsheetml/2006/main"')
      .replace(/<(\/?)([A-Za-z_][\w.-]*)(?=[\s/>])/g, '<$1s:$2')
      .replaceAll('xmlns:r=', 'xmlns:link=').replaceAll(' r:id=', ' link:id='))
  }
  expect(await convertExcel(new Uint8Array(zipSync(files)), 'xlsx', limits)).toEqual(await convertExcel(source, 'xlsx', limits))
})

it.each(['part', 'relationship', 'escape', 'external'] as const)('rejects a missing or invalid worksheet %s instead of dropping the sheet', async (defect) => {
  const files = unzipSync(await excelFixture())
  if (defect === 'part') delete files['xl/worksheets/sheet2.xml']
  else {
    const path = 'xl/_rels/workbook.xml.rels'
    const xml = strFromU8(files[path]!)
    files[path] = strToU8(defect === 'relationship' ? xml.replace(/<Relationship\b[^>]*Target="worksheets\/sheet2.xml"[^>]*\/>/, '')
      : xml.replace('Target="worksheets/sheet2.xml"', defect === 'escape' ? 'Target="../../sheet2.xml"' : 'Target="https://example.com/sheet2.xml" TargetMode="External"'))
  }
  await expect(convertExcel(new Uint8Array(zipSync(files)), 'xlsx', limits)).rejects.toMatchObject({ code: 'invalid' })
})

it.each(['xl/comments/comment1.xml', 'xl/tables/table1.xml', 'xl/drawings/commentsDrawing1.vml'])('rejects missing referenced metadata %s', async (path) => {
  const files = unzipSync(await excelOpcFixture('combined'))
  Reflect.deleteProperty(files, path)
  await expect(convertExcel(new Uint8Array(zipSync(files)), 'xlsx', limits)).rejects.toMatchObject({ code: 'invalid' })
})
