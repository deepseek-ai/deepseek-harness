/** Typed Office tool failures. @module @deepseek-ai/dsh-tool-office/src/error */

import { HarnessError } from '@deepseek-ai/dsh-error'
import type { OfficeKitErrorCode } from '@deepseek-ai/dsh-office-kit'

/**
 * Every Office tool failure this package classifies itself:
 *
 * - `OFFICE_UNAVAILABLE`: the Office service is not mounted, not installed, or was disposed; report it or retry later.
 * - `OFFICE_BUSY`: the Office service reached its admission limit; retry after other document operations finish.
 * - `OFFICE_INPUT_TOO_LARGE`: the source exceeds the input byte limit; use a smaller file.
 * - `OFFICE_OUTPUT_TOO_LARGE`: the output or one rendered image exceeds a byte, count, or pixel limit; select fewer
 *   pages, a smaller range, or a lower dpi.
 * - `OFFICE_INVALID_DOCUMENT`: the source cannot be opened as the declared document type.
 * - `OFFICE_UNSUPPORTED_FORMAT`: the engine cannot read the source format or write the requested format.
 * - `OFFICE_INVALID_REQUEST`: the engine rejected a page, sheet, range, resolution, or format selection; correct it.
 * - `OFFICE_INVALID_OUTPUT`: the engine produced an unreadable or incomplete output.
 * - `OFFICE_TIMEOUT`: the conversion exceeded its deadline.
 * - `OFFICE_SOURCE_CHANGED`: the source changed after its read was authorized; retry on the current file.
 * - `OFFICE_CONVERSION_FAILED`: the engine failed without a more specific class.
 * - `OFFICE_UNSUPPORTED_REMOTE_WORKSPACE`: `office_convert` and `office_recalculate` cannot return a file the
 *   execution world reads, because the workspace is on a remote host.
 * - `MODEL_DOES_NOT_SUPPORT_IMAGES`: the calling model route does not declare image input, so `office_render` cannot
 *   return images; switch to an image-capable model. The value matches the attachment refusal reason of the same
 *   name.
 */
export const OFFICE_TOOL_ERROR_CODES = [
  'OFFICE_UNAVAILABLE',
  'OFFICE_BUSY',
  'OFFICE_INPUT_TOO_LARGE',
  'OFFICE_OUTPUT_TOO_LARGE',
  'OFFICE_INVALID_DOCUMENT',
  'OFFICE_UNSUPPORTED_FORMAT',
  'OFFICE_INVALID_REQUEST',
  'OFFICE_INVALID_OUTPUT',
  'OFFICE_TIMEOUT',
  'OFFICE_SOURCE_CHANGED',
  'OFFICE_CONVERSION_FAILED',
  'OFFICE_UNSUPPORTED_REMOTE_WORKSPACE',
  'MODEL_DOES_NOT_SUPPORT_IMAGES',
] as const

/** One Office tool failure code. */
export type OfficeToolErrorCode = typeof OFFICE_TOOL_ERROR_CODES[number]

/** Tool failure code for each Office service failure code; the `OfficeKitError` stays the `cause`. */
export const OFFICE_KIT_FAILURE_CODES: Readonly<Record<OfficeKitErrorCode, OfficeToolErrorCode>> = {
  'unavailable': 'OFFICE_UNAVAILABLE',
  'busy': 'OFFICE_BUSY',
  'input-too-large': 'OFFICE_INPUT_TOO_LARGE',
  'output-too-large': 'OFFICE_OUTPUT_TOO_LARGE',
  'invalid-document': 'OFFICE_INVALID_DOCUMENT',
  'unsupported-format': 'OFFICE_UNSUPPORTED_FORMAT',
  'invalid-request': 'OFFICE_INVALID_REQUEST',
  'invalid-output': 'OFFICE_INVALID_OUTPUT',
  'timeout': 'OFFICE_TIMEOUT',
  'source-changed': 'OFFICE_SOURCE_CHANGED',
  'failed': 'OFFICE_CONVERSION_FAILED',
}

/** Typed Office tool failure; `code` is one of {@link OFFICE_TOOL_ERROR_CODES}. */
export class OfficeToolError extends HarnessError {
  override readonly code: OfficeToolErrorCode

  /**
   * @param message - model-facing refusal naming the operation, the path, and the safe next step.
   * @param code - stable failure code.
   * @param options - standard `cause` chaining; an Office service failure keeps its `OfficeKitError`.
   */
  constructor(message: string, code: OfficeToolErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'OfficeToolError'
    this.code = code
  }
}
