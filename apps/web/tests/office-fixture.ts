/** Small binary Office and OOXML documents for exercising the installed converter through the Web preview. */
import { readFileSync } from 'node:fs'
import { strToU8, zipSync } from 'fflate'

const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const CONTENT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'
const TEXT = 'Office preview 中文文档'

/**
 * Create a valid Office document containing Latin and Chinese text; generated Word and PowerPoint documents have two pages.
 * @param extension - Office application and format to exercise.
 * @param font - Latin family requested by generated OOXML documents; binary fixtures retain their stored fonts.
 * @returns Compressed document bytes accepted by the production converter.
 */
export function realOfficeBytes(extension: 'doc' | 'docx' | 'xls' | 'xlsx' | 'ppt' | 'pptx', font = 'Liberation Sans'): Uint8Array {
  const files: Record<string, string> = {}
  let main: string
  let parts: Record<string, string>
  switch (extension) {
    case 'doc': case 'xls': case 'ppt':
      return readFileSync(new URL(`./fixtures/office/preview.${extension}`, import.meta.url))
    case 'docx':
      main = 'word/document.xml'
      parts = { [main]: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml' }
      files[main] = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${[0, 1].map(index => `<w:p><w:r><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="宋体"/></w:rPr>${index === 1 ? '<w:br w:type="page"/>' : ''}<w:t>${TEXT}</w:t></w:r></w:p>`).join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`
      break
    case 'xlsx':
      main = 'xl/workbook.xml'
      parts = {
        [main]: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
        'xl/worksheets/sheet1.xml': 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
      }
      files[main] = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${OFFICE_REL_NS}"><sheets><sheet name="Preview" sheetId="1" r:id="rId1"/></sheets></workbook>`
      files['xl/_rels/workbook.xml.rels'] = `<Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${OFFICE_REL_NS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`
      files['xl/worksheets/sheet1.xml'] = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="45" customWidth="1"/></cols><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${TEXT}</t></is></c></row></sheetData></worksheet>`
      break
    case 'pptx':
      main = 'ppt/presentation.xml'
      parts = {
        [main]: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
        'ppt/slides/slide1.xml': 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
        'ppt/slides/slide2.xml': 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
      }
      files[main] = `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${OFFICE_REL_NS}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
      files['ppt/_rels/presentation.xml.rels'] = `<Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${OFFICE_REL_NS}/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="${OFFICE_REL_NS}/slide" Target="slides/slide2.xml"/></Relationships>`
      files['ppt/slides/slide1.xml'] = `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Preview"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="7315200" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="2400"><a:latin typeface="${font}"/><a:ea typeface="宋体"/></a:rPr><a:t>${TEXT}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
      files['ppt/slides/slide2.xml'] = files['ppt/slides/slide1.xml']
      break
  }
  files['_rels/.rels'] = `<Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${OFFICE_REL_NS}/officeDocument" Target="${main}"/></Relationships>`
  files['[Content_Types].xml'] = `<Types xmlns="${CONTENT_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${Object.entries(parts).map(([part, type]) => `<Override PartName="/${part}" ContentType="${type}"/>`).join('')}</Types>`
  return zipSync(Object.fromEntries(Object.entries(files).map(([path, content]) => [path, strToU8(content)])))
}
