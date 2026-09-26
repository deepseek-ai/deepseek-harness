/** Unsupported XLSX drawings cannot prevent cell preview or mutate retained file bytes. */
import ExcelJS from 'exceljs'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { expect, it } from 'vitest'
import { Config } from '../src/config.ts'
import { convertExcel } from '../src/client/excel/convert.ts'
import { XlsxPreviewArchive } from '../src/client/excel/xlsx-archive.ts'
import { excelDrawingFixture } from './excel-drawing-fixture.ts'
import { excelFixture, excelHtmlFixture } from './excel-fixture.ts'

const limits = Config({}).excel
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

it.each(['', 'xdr', 'drawing'])('opens charts with DrawingML prefix %j while retaining every displayed cell', async (prefix) => {
  const source = await excelDrawingFixture(prefix)
  const before = source.slice()
  const result = await convertExcel(source, 'xlsx', limits)
  const baseline = await convertExcel(await excelFixture(), 'xlsx', limits)
  expect(result.sheets).toEqual(baseline.sheets)
  expect(result.missingResults).toBe(baseline.missingResults)
  expect(result.unsupportedFeatures).toEqual(['charts', 'conditionalFormatting'])
  expect(source).toEqual(before)
})

it('removes drawing parts and their relationships without rewriting retained XML', async () => {
  const source = await excelDrawingFixture()
  const before = unzipSync(source)
  const archive = new XlsxPreviewArchive(source)
  const after = unzipSync(archive.withoutDrawings())
  expect(after['xl/drawings/drawing1.xml']).toBeUndefined()
  expect(after['xl/drawings/_rels/drawing1.xml.rels']).toBeUndefined()
  for (const [path, bytes] of Object.entries(after)) expect(bytes).toEqual(before[path])
  expect(unzipSync(archive.withoutDrawings())).toEqual(after)
  expect([...archive.unsupportedFeatures].sort()).toEqual(['charts', 'conditionalFormatting'])
})

it('keeps ordinary archives byte-identical and does not interpret cell text as drawing markup', async () => {
  const source = await excelHtmlFixture()
  const archive = new XlsxPreviewArchive(source)
  expect(archive.withoutDrawings()).toBe(source)
  expect(archive.unsupportedFeatures.size).toBe(0)
  expect((await convertExcel(source, 'xlsx', limits)).unsupportedFeatures).toEqual([])
})

it.each([false, true])('reports images with background=%s without hiding cell content', async (background) => {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Image')
  sheet.getCell('A1').value = 'Image data'
  const id = workbook.addImage({ base64: png, extension: 'png' })
  if (background) sheet.addBackgroundImage(id)
  else sheet.addImage(id, 'B2:D5')
  const result = await convertExcel(new Uint8Array(await workbook.xlsx.writeBuffer()), 'xlsx', limits)
  expect(result.unsupportedFeatures).toEqual(['images'])
  expect(result.sheets[0]!.celldata![0]!.v).toMatchObject({ v: 'Image data' })
})

it.each(['sp', 'grpSp', 'cxnSp'])('reports %s shapes once alongside charts and conditional formatting', async (tag) => {
  const files = unzipSync(await excelDrawingFixture())
  const path = 'xl/drawings/drawing1.xml'
  files[path] = strToU8(strFromU8(files[path]!).replace('</wsDr>', `<absoluteAnchor><pos x="0" y="0"/><ext cx="100" cy="100"/><${tag}><nvSpPr><cNvPr id="2" name="Rectangle"/><cNvSpPr/></nvSpPr><spPr/></${tag}><clientData/></absoluteAnchor></wsDr>`))
  const result = await convertExcel(new Uint8Array(zipSync(files)), 'xlsx', limits)
  expect(result.unsupportedFeatures).toEqual(['charts', 'shapes', 'conditionalFormatting'])
})

it('retains comment VML and does not report it as a chart or image', async () => {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Notes')
  sheet.getCell('A1').value = 'Annotated cell'
  sheet.getCell('A1').note = 'Cell note'
  const source = new Uint8Array(await workbook.xlsx.writeBuffer())
  const archive = new XlsxPreviewArchive(source)
  expect(archive.withoutDrawings()).toBe(source)
  expect((await convertExcel(source, 'xlsx', limits)).unsupportedFeatures).toEqual([])
})
