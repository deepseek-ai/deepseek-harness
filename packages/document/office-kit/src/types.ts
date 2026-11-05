/** Authorized Office input and complete outputs of the shared Host converter. */
import type { WorkspaceFileBytes } from '@deepseek-ai/dsh-api-workspace-files/types'
import type {} from '@deepseek-ai/dsh-typert-protocol'
import type { OfficeSourceKey, OfficeKitGeneration, OfficeKitKey } from './identity.ts'
export type { OfficeSourceKey, OfficeKitGeneration, OfficeKitKey } from './identity.ts'

/** Binary Office and Office Open XML formats accepted by PDF previews, image rendering, and format conversion. */
export type OfficeExtension = 'doc' | 'docx' | 'xls' | 'xlsx' | 'ppt' | 'pptx'

/** Foreground previews and explicit QA precede speculative background conversion. */
export type OfficeKitPriority = 'foreground' | 'background'

/** Authorized source metadata and its deferred bounded read. */
export interface OfficeKitSource {
  readonly key: OfficeSourceKey
  readonly version: string
  /** Authorized stat size; omission reserves the provider's entire input limit. */
  readonly bytes?: number
  /**
   * Read only after provider admission; do not capture already-buffered input in queued production requests.
   * @param signal - shared conversion lifetime, independent of an individual reader.
   * @param maxBytes - reserved source capacity; read at most this plus one overflow sentinel byte.
   * @returns owned bytes and the actual read version; a changed version rejects conversion.
   */
  read(signal: AbortSignal, maxBytes: number): Promise<{ readonly bytes: Uint8Array; readonly version: string }>
}

/** Source authorization and metadata lookup must finish before submitting a request. */
export interface OfficeKitRequest {
  readonly extension: OfficeExtension
  readonly priority: OfficeKitPriority
  readonly source: OfficeKitSource
}

/** Office, OpenDocument, and PDF inputs accepted by image rendering. */
export type OfficeImageInputExtension = OfficeDocumentExtension | 'pdf'

/** Office and OpenDocument inputs accepted by format conversion. */
export type OfficeDocumentExtension = OfficeExtension | 'odt' | 'ods' | 'odp'

/** Workbook inputs accepted by recalculation. */
export type OfficeWorkbookExtension = 'xls' | 'xlsx' | 'ods'

/** Format-conversion outputs; the engine accepts only the outputs of the input's document family. */
export type OfficeConversionFormat = 'pdf' | 'docx' | 'odt' | 'txt' | 'xlsx' | 'ods' | 'csv' | 'pptx' | 'odp'

/** Recalculated workbook outputs. */
export type OfficeRecalculationFormat = 'xlsx' | 'ods'

/**
 * Render selected pages, slides, or worksheet areas of one document as PNG images.
 * Worksheets select `sheet` and an optional A1 `range` and reject `pages`; other documents reject `sheet` and `range`.
 */
export interface OfficeImagesRequest {
  readonly extension: OfficeImageInputExtension
  readonly source: OfficeKitSource
  /** Distinct one-based pages or slides; omission renders every page. */
  readonly pages?: readonly number[]
  /** Exact worksheet name; omission renders each visible worksheet's data area. */
  readonly sheet?: string
  /** A1 rectangle inside `sheet`. */
  readonly range?: string
  /** Raster resolution from 24 to 600; omission uses the engine default. */
  readonly dpi?: number
  /** Inclusive count of returned images, including worksheet fragments; a larger selection rejects. */
  readonly maxImages: number
  /** Inclusive pixel count of each image. */
  readonly maxPixels: number
  /** Inclusive width and height of each image. */
  readonly maxDimension: number
  /** Inclusive PNG bytes across all returned images. */
  readonly maxBytes: number
}

/** One rendered PNG and the document location it shows. */
export interface OfficeImage {
  /** Caller-owned PNG bytes. */
  readonly png: Uint8Array
  readonly width: number
  readonly height: number
  /** One-based page or slide; absent for worksheet areas. */
  readonly page?: number
  /** Worksheet name for worksheet areas. */
  readonly sheet?: string
  /** A1 rectangle for worksheet areas. */
  readonly range?: string
}

/** Successful image rendering; failed and interrupted renders reject instead. */
export interface OfficeImagesResult {
  /** Images in document order. */
  readonly images: readonly OfficeImage[]
  /** Pages, slides, or visible worksheets in the document. */
  readonly pageCount: number
  /** Raster resolution used. */
  readonly dpi: number
  /** Requested OOXML font families unavailable to this rendering. */
  readonly missingFonts: string[]
}

/** Owner and file name of a converted or recalculated output saved in the provider's output store. */
export interface OfficeOutputTarget {
  /** Opaque owner, normally a Session id; disposing the Session with this id deletes its outputs, and other Sessions' disposal does not. */
  readonly owner: string
  /** File name without directories, including the output extension. */
  readonly name: string
}

/** Convert one document to the format named by `format`; CSV requires `sheet` for a workbook with several sheets. */
export interface OfficeConversionRequest {
  readonly extension: OfficeDocumentExtension
  readonly format: OfficeConversionFormat
  /** Exact worksheet name; accepted only for CSV output. */
  readonly sheet?: string
  readonly source: OfficeKitSource
  readonly output: OfficeOutputTarget
}

/** Recalculate every formula of one workbook and save it with refreshed cached results. */
export interface OfficeRecalculationRequest {
  readonly extension: OfficeWorkbookExtension
  readonly format: OfficeRecalculationFormat
  readonly source: OfficeKitSource
  readonly output: OfficeOutputTarget
}

/** Successful conversion or recalculation saved in the output store; failed and interrupted operations reject instead. */
export interface OfficeFileResult {
  /** Absolute Host path of the saved file, readable by the same OS user until retention, release, or disposal deletes it. */
  readonly path: string
  /** Complete file bytes, bounded by `maxOutputBytes`. */
  readonly bytes: number
  /** Page count the converter reports for the output. */
  readonly pageCount?: number
  /** Requested OOXML font families unavailable to this operation. */
  readonly missingFonts: string[]
}

/** Successful conversion; failed and interrupted conversions reject instead. */
export interface OfficeKitResult {
  /** Caller-owned complete PDF, valid after provider disposal. */
  readonly pdf: Uint8Array
  /** Requested OOXML font families unavailable to this conversion; binary Office formats return an empty list. */
  readonly missingFonts: string[]
  readonly cacheKey: OfficeKitKey
  readonly generation: OfficeKitGeneration
}

/**
 * Failures a conversion consumer can present without exposing engine diagnostics. `invalid-request` carries the
 * engine's description of a rejected page, sheet, range, resolution, or format selection.
 */
export type OfficeKitErrorCode =
  | 'input-too-large' | 'output-too-large' | 'invalid-document' | 'unsupported-format'
  | 'invalid-output' | 'timeout' | 'unavailable' | 'failed' | 'busy' | 'source-changed' | 'invalid-request'

/** PDF content carries the original Office file's identity and multipart-transferred bytes. */
export interface RenderedDocumentBytes extends WorkspaceFileBytes {
  readonly missingFonts: string[]
  readonly generation: OfficeKitGeneration
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The source was authorized, but its conversion failed. */
    'document-render/failed': { readonly reason: OfficeKitErrorCode }
  }
}
