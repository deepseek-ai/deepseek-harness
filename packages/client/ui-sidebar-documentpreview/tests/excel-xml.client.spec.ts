/** XML decoding and OPC discovery preserve cells, metadata and preview notices. */
import { createRequire } from 'node:module'
import ExcelJS from 'exceljs'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.ts'
import { convertExcel } from '../src/client/excel/convert.ts'
import { XlsxPreviewArchive } from '../src/client/excel/xlsx-archive.ts'
import { excelXmlCases, excelXmlFixture } from './excel-xml-fixture.ts'

const require = createRequire(import.meta.url)
const browserExcel = require('exceljs/dist/exceljs.js') as typeof ExcelJS
const limits = Config({}).excel

describe.each([['Node', ExcelJS], ['browser bundle', browserExcel]] as const)('%s XML reader', (_name, parser) => {
  it.each(excelXmlCases)('preserves comments and Tables in %s', async (name) => {
    const source = await excelXmlFixture(name)
    const original = source.slice()
    const archive = new XlsxPreviewArchive(source)
    const retained = archive.withoutDrawings()
    const workbook = new parser.Workbook()
    await workbook.xlsx.load(retained.buffer, { ignoreNodes: ['drawing'] })
    const sheet = workbook.getWorksheet('数据')!
    expect(sheet.getCell('A5').value).toBe(' <chart/> & 中文😀\n tail ')
    expect(sheet.getCell('A6').value).toEqual({ formula: 'SUM(B2:B3)', result: 57 })
    expect(sheet.getCell('B2').note).toMatchObject({ texts: [{ text: '生成的批注' }] })
    expect(sheet.getTable('Table1')).toMatchObject({ table: { name: 'Table1', tableRef: 'A1:B3' } })
    expect(sheet.getCell('B2').font).toMatchObject({ bold: true, color: { argb: 'FF112233' } })
    expect(workbook.getWorksheet('隐藏页')!.state).toBe('hidden')
    const originalParts = unzipSync(source)
    for (const [path, bytes] of Object.entries(unzipSync(retained))) expect(bytes, path).toEqual(originalParts[path])
    expect(source).toEqual(original)
  })
})

it.each(excelXmlCases)('preserves the complete preview for %s', async (name) => {
  const expected = await convertExcel(await excelXmlFixture('rich'), 'xlsx', limits)
  expect(await convertExcel(await excelXmlFixture(name), 'xlsx', limits)).toEqual(expected)
  expect(expected.unsupportedFeatures).toEqual(['charts', 'images', 'shapes', 'conditionalFormatting'])
  const sheet = expected.sheets[0]!
  expect(sheet.celldata!.find(cell => cell.r === 1 && cell.c === 1)!.v).toMatchObject({ v: 42, bl: 1, fc: '#112233', bg: '#FFFF00' })
  expect(sheet.config).toMatchObject({ merge: { '29_7': { r: 29, c: 7, rs: 1, cs: 3 } }, rowhidden: { 2: 0 }, colhidden: { 1: 0 } })
  expect(sheet.frozen).toMatchObject({ type: 'rangeBoth', range: { row_focus: 0, column_focus: 0 } })
})

it.each(['utf-16le', 'utf-16be'] as const)('decodes %s parts and relationships with and without a BOM', async (encoding) => {
  const source = await excelXmlFixture('rich')
  const expected = await convertExcel(source, 'xlsx', limits)
  for (const bom of [false, true]) {
    const files = unzipSync(source)
    for (const [path, bytes] of Object.entries(files)) {
      if (!/\.(xml|rels|vml)$/.test(path)) continue
      const xml = strFromU8(bytes).replace(/encoding="UTF-8"/i, 'encoding="UTF-16"')
      const encoded = Buffer.from(`${bom ? '\uFEFF' : ''}${xml}`, 'utf16le')
      if (encoding === 'utf-16be') encoded.swap16()
      files[path] = encoded
    }
    expect(await convertExcel(new Uint8Array(zipSync(files)), 'xlsx', limits)).toEqual(expected)
  }
})

it.each(['xl/workbook.xml', 'xl/styles.xml', 'xl/sharedStrings.xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels'])('rejects missing core part %s', async (path) => {
  const files = unzipSync(await excelXmlFixture('rich'))
  Reflect.deleteProperty(files, path)
  await expect(convertExcel(new Uint8Array(zipSync(files)), 'xlsx', limits)).rejects.toMatchObject({ code: 'invalid' })
})

it('ignores unrelated binary parts without trying to decode them as XML', async () => {
  const source = await excelXmlFixture('rich')
  const files = unzipSync(source)
  files['xl/vbaProject.bin'] = Uint8Array.of(0xff, 0x80, 0x81)
  expect(await convertExcel(new Uint8Array(zipSync(files)), 'xlsx', limits)).toEqual(await convertExcel(source, 'xlsx', limits))
})

it('preserves text split across escaped text and CDATA segments', async () => {
  const source = await excelXmlFixture('rich')
  const files = unzipSync(source)
  const path = 'xl/sharedStrings.xml'
  files[path] = strToU8(strFromU8(files[path]!).replace('Item</t>', 'I<![CDATA[t]]>em</t>'))
  expect(await convertExcel(new Uint8Array(zipSync(files)), 'xlsx', limits)).toEqual(await convertExcel(source, 'xlsx', limits))
})

it('finds a drawing owned by a part at the package root', () => {
  const archive = new XlsxPreviewArchive(new Uint8Array(zipSync({
    '_rels/root.xml.rels': strToU8('<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="drawing.xml"/></Relationships>'),
    'drawing.xml': strToU8('<wsDr><chart/></wsDr>'),
    '_rels/drawing.xml.rels': strToU8('<Relationships/>'),
  })))
  expect(Object.keys(unzipSync(archive.withoutDrawings()))).toEqual(['_rels/root.xml.rels'])
  expect([...archive.unsupportedFeatures]).toEqual(['charts'])
})

it('rejects a worksheet relationship with no target', async () => {
  const files = unzipSync(await excelXmlFixture('rich'))
  const path = 'xl/_rels/workbook.xml.rels'
  files[path] = strToU8(strFromU8(files[path]!).replace('Target="worksheets/sheet1.xml"', ''))
  await expect(convertExcel(new Uint8Array(zipSync(files)), 'xlsx', limits)).rejects.toMatchObject({ code: 'invalid' })
})

it.each(['missing', 'external', 'duplicate'] as const)('rejects a %s officeDocument relationship', async (defect) => {
  const files = unzipSync(await excelXmlFixture('rich'))
  const xml = strFromU8(files['_rels/.rels']!)
  const relation = xml.match(/<Relationship\b[^>]*officeDocument"[^>]*\/>/)![0]
  files['_rels/.rels'] = strToU8(xml.replace(relation, defect === 'missing' ? '' : defect === 'duplicate' ? relation + relation : relation.replace('/>', ' TargetMode="External"/>')))
  await expect(convertExcel(new Uint8Array(zipSync(files)), 'xlsx', limits)).rejects.toMatchObject({ code: 'invalid' })
})

it('rejects malformed UTF-16 without replacing invalid code units', async () => {
  const files = unzipSync(await excelXmlFixture('rich'))
  files['xl/worksheets/sheet1.xml'] = Uint8Array.of(0xff, 0xfe, 0x3c)
  await expect(convertExcel(new Uint8Array(zipSync(files)), 'xlsx', limits)).rejects.toMatchObject({ code: 'invalid' })
})
