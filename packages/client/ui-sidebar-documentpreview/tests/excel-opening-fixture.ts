/** Opening regressions derived from the independent-writer combined workbook. */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { excelOpcFixture } from './excel-opc-fixture.ts'

/** Supported URI aliases, ASCII case-equivalent part names and orphan DrawingML. */
export const excelOpeningCases = ['strict', 'case-root', 'case-parts', 'orphan-drawing'] as const

/**
 * Change only the package property under test in an independent-writer workbook.
 * @param name - Opening regression to construct.
 * @returns Complete XLSX bytes owned by the caller.
 */
export async function excelOpeningFixture(name: typeof excelOpeningCases[number]): Promise<Uint8Array<ArrayBuffer>> {
  const files = unzipSync(await excelOpcFixture('combined'))
  const result: Record<string, Uint8Array> = {}
  for (const [path, bytes] of Object.entries(files)) {
    let xml = /\.(xml|rels|vml)$/.test(path) ? strFromU8(bytes) : undefined
    let target = path
    if (xml !== undefined) {
      if (name === 'strict') {
        xml = xml.replaceAll('http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main')
          .replaceAll('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships')
      } else if (name === 'case-root' && path === '_rels/.rels') {
        xml = xml.replace('Target="xl/workbook.xml"', 'Target="XL/WORKBOOK.XML"')
      } else if (name === 'case-parts') {
        if (!path.startsWith('docProps/') && !path.startsWith('xl/theme/')) target = path.toUpperCase()
        if (path.endsWith('.rels')) xml = xml.replace(/Target="([^"]+)"/g, (attribute, value: string) => value.includes('://') ? attribute : `Target="${value.toLowerCase()}"`)
      } else if (name === 'orphan-drawing') {
        if (path.endsWith('.rels')) xml = xml.replace(/<Relationship\b[^>]*Type="[^"]*\/drawing"[^>]*\/>/g, '')
        if (path.startsWith('xl/worksheets/')) xml = xml.replace(/<(?:\w+:)?drawing\b[^>]*\/>/g, '')
      }
    }
    result[target] = xml === undefined ? bytes : strToU8(xml)
  }
  return new Uint8Array(zipSync(result))
}
