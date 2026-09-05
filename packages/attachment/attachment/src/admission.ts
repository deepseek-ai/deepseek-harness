/** Wire-form admission of base64-encoded image uploads. @module @deepseek-ai/dsh-attachment/admission */

import { Buffer } from 'node:buffer'
import { AttachmentError } from './error.ts'
import type { AttachmentStore } from './index.ts'
import type {
  EncodedFileAttachment,
  EncodedImageAttachment,
  FileAttachmentRef,
  ImageAttachmentRef,
  SaveImageAttachment,
} from './types.ts'

/** Decode one upload payload while rejecting non-canonical base64 forms. */
function decodeCanonicalBase64(data: string, empty: 'reject' | 'accept', code: 'INVALID_IMAGE_BASE64' | 'INVALID_FILE_BASE64'): Uint8Array {
  const decoded = Buffer.from(data, 'base64')
  if ((data.length === 0 && empty === 'reject') || decoded.toString('base64') !== data) {
    throw new AttachmentError(
      code === 'INVALID_IMAGE_BASE64' ? 'Image upload is not canonical base64.' : 'File upload is not canonical base64.',
      code,
    )
  }
  return new Uint8Array(decoded)
}

function decodeBase64(data: string): Uint8Array {
  return decodeCanonicalBase64(data, 'reject', 'INVALID_IMAGE_BASE64')
}

/** Store input for one decoded upload. */
function saveInput(image: EncodedImageAttachment): SaveImageAttachment {
  return {
    data: decodeBase64(image.data),
    mediaType: image.mediaType,
    ...image.name === undefined ? {} : { name: image.name },
  }
}

/**
 * Admit one wire image batch: enforce canonical base64 on every member, then
 * delegate batch admission — count and aggregate-byte limits, media-type and
 * per-image validation, ordered commit — to {@link AttachmentStore.saveImages}.
 * The shared entry for every RPC endpoint accepting browser uploads.
 * @param attachments - the deployment attachment store owning batch policy.
 * @param images - base64-encoded uploads in caller order.
 * @returns durable references in the same order as `images`.
 * @throws AttachmentError on a non-canonical payload or a refused batch.
 */
export async function admitEncodedImages(
  attachments: AttachmentStore,
  images: readonly EncodedImageAttachment[],
): Promise<readonly ImageAttachmentRef[]> {
  return attachments.saveImages(images.map(saveInput))
}

/**
 * Admit one wire file upload: enforce canonical base64 (an empty file is a
 * valid zero-byte payload), then delegate verbatim commit to
 * {@link AttachmentStore.saveFile}. The shared entry for every RPC endpoint
 * accepting browser file uploads.
 * @param attachments - the deployment attachment store.
 * @param file - base64-encoded upload and optional display name.
 * @returns the durable content-addressed file reference.
 * @throws AttachmentError on a non-canonical payload or a storage failure.
 */
export async function admitEncodedFile(
  attachments: AttachmentStore,
  file: EncodedFileAttachment,
): Promise<FileAttachmentRef> {
  return attachments.saveFile({
    data: decodeCanonicalBase64(file.data, 'accept', 'INVALID_FILE_BASE64'),
    ...file.name === undefined ? {} : { name: file.name },
  })
}
