/** XLSX preview copies without DrawingML parts; worksheet XML and source bytes remain untouched. */
import { unzipSync, zipSync, type Unzipped } from 'fflate'
import { XMLParser } from 'fast-xml-parser'
import type { ExcelUnsupportedFeature } from './model.ts'

/** Owns the unpacked preview copy and its detected unsupported content. */
export class XlsxPreviewArchive {
  /** Detected workbook content that the preview does not display. */
  readonly unsupportedFeatures = new Set<ExcelUnsupportedFeature>()
  private readonly files: Unzipped
  private readonly parts = new Map<string, Uint8Array>()

  /**
   * Read an archive without modifying the borrowed source buffer.
   * @param bytes - Complete XLSX source bytes.
   * @throws When ZIP entries have ASCII case-equivalent names.
   */
  constructor(private readonly bytes: Uint8Array<ArrayBuffer>) {
    this.files = unzipSync(bytes)
    for (const [path, bytes] of Object.entries(this.files)) {
      if (path.endsWith('/')) continue
      const key = partKey(path)
      if (this.parts.has(key)) throw new Error(`Ambiguous XLSX part: ${path}`)
      this.parts.set(key, bytes)
    }
  }

  /**
   * Omit DrawingML parts before ExcelJS parses them; callers must also ignore worksheet drawing references.
   * @returns Source bytes when no parts were omitted, otherwise an uncompressed temporary ZIP.
   */
  withoutDrawings(): Uint8Array<ArrayBuffer> {
    const entries = Object.entries(this.files)
    const omitted = new Set<string>()
    for (const [path, bytes] of entries) {
      // ExcelJS also discovers unreferenced drawings in its conventional directory.
      if (/^xl\/drawings\/(?:[^/]+\.xml|_rels\/[^/]+\.xml\.rels)$/i.test(path)) omitted.add(partKey(path))
      const match = /^(.*\/)?_rels\/([^/]+)\.rels$/i.exec(path)
      if (match === null) continue
      const owner = `${match[1] ?? ''}${match[2]}`
      new XMLParser({
        removeNSPrefix: true, ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false,
        updateTag: (tag: string, _path, attributes: Record<string, unknown>) => {
          const type = typeof attributes.Type === 'string'
            ? attributes.Type.replace(/^http:\/\/purl\.oclc\.org\/ooxml\/officeDocument\/relationships\//, 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/') : undefined
          if (tag !== 'Relationship' || attributes.TargetMode === 'External') return tag
          const drawing = type === 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing'
          if (!drawing && type !== 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet') return tag
          if (typeof attributes.Target !== 'string') throw new Error('Missing XLSX relationship target')
          const target = resolvePart(owner, attributes.Target)
          const content = this.parts.get(partKey(target))
          if (content === undefined) throw new Error(`Missing XLSX part: ${target}`)
          this.inspectContent(content)
          if (drawing) {
            omitted.add(partKey(target))
            const split = target.lastIndexOf('/')
            omitted.add(partKey(`${target.slice(0, split + 1)}_rels/${target.slice(split + 1)}.rels`))
          }
          return tag
        },
      }).parse(decodeXml(bytes))
    }
    const retained = entries.filter(([path]) => !omitted.has(partKey(path)))
    return retained.length === entries.length ? this.bytes : new Uint8Array(zipSync(Object.fromEntries(retained), { level: 0 }))
  }

  private inspectContent(bytes: Uint8Array): void {
    new XMLParser({
      removeNSPrefix: true,
      processEntities: false,
      parseTagValue: false,
      stopNodes: ['*.sheetData'],
      updateTag: (tag: string) => {
        if (tag === 'chart') this.unsupportedFeatures.add('charts')
        if (tag === 'pic' || tag === 'picture') this.unsupportedFeatures.add('images')
        if (tag === 'sp' || tag === 'grpSp' || tag === 'cxnSp') this.unsupportedFeatures.add('shapes')
        if (tag === 'conditionalFormatting') this.unsupportedFeatures.add('conditionalFormatting')
        if (tag === 'sheetData') return false
        return tag
      },
    }).parse(decodeXml(bytes))
  }
}

/** OPC compares part names using ASCII case equivalence, leaving ZIP names intact. */
function partKey(path: string): string {
  return path.replace(/[A-Z]/g, character => character.toLowerCase())
}

/** Decode the mandatory XML encodings without rewriting the archived bytes. */
function decodeXml(bytes: Uint8Array): string {
  const encoding = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0)
    ? 'utf-16le'
    : (bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c)
      ? 'utf-16be' : 'utf-8'
  return new TextDecoder(encoding, { fatal: true }).decode(bytes)
}

/** Resolve internal relationship targets without accepting traversal above the package root. */
function resolvePart(owner: string, target: string): string {
  const parts = target.startsWith('/') ? [] : owner.split('/').slice(0, -1)
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length === 0) throw new Error('XLSX relationship escapes package')
      parts.pop()
    } else parts.push(segment)
  }
  return parts.join('/')
}
