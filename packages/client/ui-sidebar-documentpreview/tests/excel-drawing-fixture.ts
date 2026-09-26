/** A chart workbook using the default DrawingML namespace emitted by Openpyxl. */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { excelFixture } from './excel-fixture.ts'

/**
 * Add a chart and conditional formatting to the styled workbook without rewriting its cells.
 * @param prefix - Optional DrawingML namespace prefix.
 * @returns Complete XLSX bytes with worksheet, drawing, and chart relationships.
 */
export async function excelDrawingFixture(prefix = ''): Promise<Uint8Array<ArrayBuffer>> {
  const files = unzipSync(await excelFixture())
  const relationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const packageRelationships = 'http://schemas.openxmlformats.org/package/2006/relationships'
  const drawingNamespace = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
  const chartNamespace = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
  const drawing = `<wsDr xmlns="${drawingNamespace}"><oneCellAnchor><from><col>0</col><colOff>0</colOff><row>7</row><rowOff>0</rowOff></from><ext cx="6480000" cy="3060000"/><graphicFrame><nvGraphicFramePr><cNvPr id="1" name="Budget chart"/><cNvGraphicFramePr/></nvGraphicFramePr><xfrm/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="${chartNamespace}"><c:chart xmlns:c="${chartNamespace}" xmlns:r="${relationships}" r:id="rId1"/></a:graphicData></a:graphic></graphicFrame><clientData/></oneCellAnchor></wsDr>`
  files['xl/drawings/drawing1.xml'] = strToU8(prefix === '' ? drawing : drawing
    .replace(`xmlns="${drawingNamespace}"`, `xmlns:${prefix}="${drawingNamespace}"`)
    .replace(/<(\/?)([A-Za-z_][\w.-]*)(?=[\s/>])/g, `<$1${prefix}:$2`))
  files['xl/drawings/_rels/drawing1.xml.rels'] = strToU8(`<Relationships xmlns="${packageRelationships}"><Relationship Type="${relationships}/chart" Target="/xl/charts/chart1.xml" Id="rId1"/></Relationships>`)
  files['xl/worksheets/_rels/sheet1.xml.rels'] = strToU8(`<Relationships xmlns="${packageRelationships}"><Relationship Type="${relationships}/drawing" Target="/xl/drawings/drawing1.xml" Id="rId1"/></Relationships>`)
  files['xl/charts/chart1.xml'] = strToU8(`<c:chartSpace xmlns:c="${chartNamespace}"><c:chart><c:plotArea><c:pieChart><c:ser><c:idx val="0"/><c:order val="0"/><c:cat><c:strLit><c:ptCount val="2"/><c:pt idx="0"><c:v>Design</c:v></c:pt><c:pt idx="1"><c:v>Engineering</c:v></c:pt></c:strLit></c:cat><c:val><c:numLit><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>12000</c:v></c:pt><c:pt idx="1"><c:v>45000</c:v></c:pt></c:numLit></c:val></c:ser></c:pieChart></c:plotArea></c:chart></c:chartSpace>`)
  files['xl/worksheets/sheet1.xml'] = strToU8(strFromU8(files['xl/worksheets/sheet1.xml']!).replace('</worksheet>',
    `<conditionalFormatting sqref="D3:D4"><cfRule type="colorScale" priority="1"><colorScale><cfvo type="min"/><cfvo type="max"/><color rgb="FFFF0000"/><color rgb="FF00FF00"/></colorScale></cfRule></conditionalFormatting><drawing xmlns:r="${relationships}" r:id="rId1"/></worksheet>`))
  files['[Content_Types].xml'] = strToU8(strFromU8(files['[Content_Types].xml']!).replace('</Types>', '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>'))
  return new Uint8Array(zipSync(files))
}
