/** Structured failures for observation submission and automation-task delivery. */
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { SourceErrorCode } from './source-types.ts'

/** A task-delivery or cleanup failure with its original cause. */
export class SourceError extends HarnessError {
  declare readonly code: SourceErrorCode

  // oxlint-disable-next-line eslint/no-useless-constructor -- Narrows the inherited string error code.
  constructor(message: string, code: SourceErrorCode, options?: ErrorOptions) {
    super(message, code, options)
  }
}
