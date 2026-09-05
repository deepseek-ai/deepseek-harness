/** Browser-safe request and receipt types for staged file uploads. */

import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Canonical encoded upload accepted by the Remote fallback. */
export interface EncodedFileUploadRequest {
  /** Canonical base64 encoding of the exact file bytes. */
  readonly data: string
  /** Optional display name; the Host sanitizes it into the stored leaf name. */
  readonly name?: string
}

/** Durable receipt for one staged file upload. */
export interface FileUploadValue {
  /** Per-upload authority accepted only inside the receiving Agent scope. */
  readonly receiptId: FileUploadReceiptId
  readonly file: FileAttachmentRef
}

/** Host-minted authority for one staged file upload in one Agent scope. */
export type FileUploadReceiptId = Branded<'file-upload-receipt-id'>

/**
 * Fetch-shaped carrier installed by a page that owns its Host transport.
 * @param input - absolute same-origin upload URL.
 * @param init - raw request body, headers, and cancellation signal.
 * @returns the Host response.
 */
export type FileUploadFetch = (input: URL, init: RequestInit) => Promise<Response>

/** Pre-Cordis hook supplied by a page whose Host runs in another execution context. */
export interface ClientFileUploadHooks {
  readonly fetch: FileUploadFetch
}
