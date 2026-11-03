/**
 * Canonical Office tool results and their model-facing content.
 * @module @deepseek-ai/dsh-tool-office/content
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { AttachmentId, type ImageAttachmentRef, type ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { OfficeConversionFormat, OfficeRecalculationFormat } from '@deepseek-ai/dsh-office-kit'

/**
 * One rendered image and the document location it shows. The attachment fields are those of the stored reference;
 * storage normalization keeps a rendered PNG or re-encodes it as JPEG or WebP, so `mediaType` names the stored encoding.
 */
export interface OfficeRenderedImage extends Pick<ImageAttachmentRef, 'bytes' | 'width' | 'height' | 'originalDimensions'> {
  mediaType: Exclude<ImageMediaType, 'image/gif'>
  /** One-based page or slide; absent for worksheet areas. */
  page?: number
  /** Worksheet of a worksheet area. */
  sheet?: string
  /** A1 rectangle of a worksheet area. */
  range?: string
  attachmentId: string
}

/** Canonical result of `render`. */
export interface OfficeRenderValue {
  operation: 'render'
  /** Canonical absolute input path in the filesystem execution world. */
  path: string
  /** Pages or slides of a document, or visible worksheets of a workbook. */
  pageCount: number
  dpi: number
  images: OfficeRenderedImage[]
  /** Requested font families that were substituted. */
  missingFonts: string[]
}

/** Output format of each file-producing operation. */
export interface OfficeFileFormats {
  convert: OfficeConversionFormat
  recalculate: OfficeRecalculationFormat
}

/** Canonical result of `convert` and `recalculate`. */
export interface OfficeFileValue<Operation extends 'convert' | 'recalculate' = 'convert' | 'recalculate'> {
  operation: Operation
  /** Canonical absolute input path in the filesystem execution world. */
  path: string
  /** Absolute path of the temporary output file in the filesystem execution world. */
  file: string
  format: OfficeFileFormats[Operation]
  bytes: number
  /** Page count the converter reports for the output. */
  pageCount?: number
  /** Requested font families that were substituted. */
  missingFonts: string[]
}

function fontsLine(missingFonts: readonly string[]): string {
  return missingFonts.length === 0 ? '' : `\nFonts not installed and substituted: ${missingFonts.join(', ')}.`
}

function location(image: OfficeRenderedImage): string {
  if (image.page !== undefined) return `Page ${image.page}`
  if (image.sheet === undefined) return 'Image'
  return image.range === undefined ? `Sheet "${image.sheet}"` : `Sheet "${image.sheet}" ${image.range}`
}

/**
 * Project a render into a summary, then one label and image per rendered page or area.
 * @param value - canonical render result.
 * @returns text and image blocks in document order.
 */
export function renderImagesContent(value: OfficeRenderValue): ContentBlock[] {
  const count = value.images.length
  const blocks: ContentBlock[] = [{
    type: 'text',
    text: `Rendered ${count} image${count === 1 ? '' : 's'} of ${value.path} (${value.pageCount} in the document) at ${value.dpi} DPI.${fontsLine(value.missingFonts)}`,
  }]
  for (const image of value.images) {
    blocks.push({ type: 'text', text: `${location(image)}: ${image.width}x${image.height} px` })
    blocks.push({ type: 'image', attachment: {
      attachmentId: AttachmentId(image.attachmentId), mediaType: image.mediaType, bytes: image.bytes,
      width: image.width, height: image.height,
      ...image.originalDimensions === undefined ? {} : { originalDimensions: { ...image.originalDimensions } },
    } })
  }
  return blocks
}

/**
 * Project a conversion or recalculation into its temporary file and the copy instruction.
 * @param value - canonical file result.
 * @returns one text block naming the temporary file.
 */
export function renderFileContent(value: OfficeFileValue): ContentBlock[] {
  const verb = value.operation === 'convert' ? 'Converted' : 'Recalculated'
  const pages = value.pageCount === undefined ? '' : `, ${value.pageCount} page${value.pageCount === 1 ? '' : 's'}`
  return [{ type: 'text', text: `${verb} ${value.path} to ${value.format} (${value.bytes} bytes${pages}): ${value.file}\n`
    + `Copy this temporary file to its destination with the shell now; it may be deleted after a retention period or to free space, and is deleted when this conversation ends.${fontsLine(value.missingFonts)}` }]
}
