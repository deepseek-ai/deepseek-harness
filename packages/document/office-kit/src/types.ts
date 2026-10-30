/** Authorized Office input and complete PDF output, for the shared Host converter. */
import type { WorkspaceFileBytes } from '@deepseek-ai/dsh-api-workspace-files/types'
import type {} from '@deepseek-ai/dsh-typert-protocol'
import type { OfficeSourceKey, OfficeKitGeneration, OfficeKitKey } from './identity.ts'
export type { OfficeSourceKey, OfficeKitGeneration, OfficeKitKey } from './identity.ts'

/** Binary Office and Office Open XML formats supported by Office-to-PDF conversion. */
export type OfficeExtension = 'doc' | 'docx' | 'xls' | 'xlsx' | 'ppt' | 'pptx'

/** Foreground previews and explicit QA precede speculative background conversion. */
export type OfficeKitPriority = 'foreground' | 'background'

/** Source authorization and metadata lookup must finish before submitting a request. */
export interface OfficeKitRequest {
  readonly extension: OfficeExtension
  readonly priority: OfficeKitPriority
  readonly source: {
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

/** Failures a conversion consumer can present without exposing engine diagnostics. */
export type OfficeKitErrorCode =
  | 'input-too-large' | 'output-too-large' | 'invalid-document' | 'unsupported-format'
  | 'invalid-output' | 'timeout' | 'unavailable' | 'failed' | 'busy' | 'source-changed'

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
