/** Typed `read_image` failures. @module @deepseek-ai/dsh-tool-fs/src/image-error */

import { HarnessError } from '@deepseek-ai/dsh-error'

/**
 * Every `read_image` failure the tool classifies itself, before the attachment store sees the bytes:
 *
 * - `IMAGE_UNSUPPORTED_MODEL`: the calling route does not declare image input; switch to an image-capable model.
 * - `IMAGE_UNSUPPORTED_FORMAT`: the extension, the file signature, or the deployment's accepted media types
 *   exclude the format; convert the file to an accepted format or read another file.
 *
 * Failures the attachment store classifies keep their `AttachmentError` codes.
 */
export const IMAGE_INPUT_ERROR_CODES = [
  'IMAGE_UNSUPPORTED_MODEL',
  'IMAGE_UNSUPPORTED_FORMAT',
] as const

/** One `read_image` failure code. */
export type ImageInputErrorCode = typeof IMAGE_INPUT_ERROR_CODES[number]

/** Typed `read_image` failure; `code` is one of {@link IMAGE_INPUT_ERROR_CODES}. */
export class ImageInputError extends HarnessError {
  override readonly code: ImageInputErrorCode

  /**
   * @param message - model-facing refusal naming the path and the safe next step.
   * @param code - stable failure code.
   * @param options - standard `cause` chaining.
   */
  constructor(message: string, code: ImageInputErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'ImageInputError'
    this.code = code
  }
}
