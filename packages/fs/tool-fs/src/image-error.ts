/** Typed `read_image` failures. @module @deepseek-ai/dsh-tool-fs/src/image-error */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/**
 * Every machine-routable `read_image` failure code:
 *
 * - `IMAGE_UNSUPPORTED_MODEL`: the calling route does not declare image input; switch to an image-capable model.
 * - `IMAGE_UNSUPPORTED_FORMAT`: the extension, the file signature, or the deployment's accepted media types
 *   exclude the format; convert the file to an accepted format or read another file.
 * - `IMAGE_TYPE_MISMATCH`: the extension or file signature declares one format but the bytes decode as another; rename or convert the file.
 * - `IMAGE_INVALID`: bytes in a supported format do not decode; the file is truncated or corrupt.
 * - `IMAGE_TOO_LARGE`: a side, the decoded pixel count, or the stored byte budget exceeds the deployment limit;
 *   downscale the image and read the smaller copy.
 * - `IMAGE_CONVERSION_FAILED`: a 16-bit PNG could not be normalized to 8-bit sRGB; convert it to an 8-bit format.
 * - `IMAGE_STORE_FAILED`: the attachment store could not commit the image for another reason; report the cause
 *   instead of retrying unchanged.
 */
export const IMAGE_INPUT_ERROR_CODES = [
  'IMAGE_UNSUPPORTED_MODEL',
  'IMAGE_UNSUPPORTED_FORMAT',
  'IMAGE_TYPE_MISMATCH',
  'IMAGE_INVALID',
  'IMAGE_TOO_LARGE',
  'IMAGE_CONVERSION_FAILED',
  'IMAGE_STORE_FAILED',
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
