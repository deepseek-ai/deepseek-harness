/** Machine-routable Stagehand browser failures, shared by the host and its browser Worker. @module */

import { HarnessError } from '@deepseek-ai/dsh-error'

/**
 * Every {@link StagehandError} code:
 * - `STAGEHAND_ACT_FAILED` — Stagehand reported that a natural-language action did not succeed; inspect the page and
 *   rephrase or retry.
 * - `STAGEHAND_TAB_NOT_FOUND` — the requested tab, or an active tab, is unavailable; list tabs and select a current pageId.
 * - `STAGEHAND_OPERATION_FAILED` — the Stagehand SDK or browser failed the operation in a way this provider does not
 *   classify; the message carries the SDK's text.
 * - `STAGEHAND_WORKER_FAILED` — the browser Worker exited, closed, or broke its message protocol; a later call reconnects.
 * - `STAGEHAND_CLEANUP_FAILED` — SDK requests did not drain before the Worker terminated; the connection is not reused.
 */
export const STAGEHAND_ERROR_CODES = [
  'STAGEHAND_ACT_FAILED',
  'STAGEHAND_TAB_NOT_FOUND',
  'STAGEHAND_OPERATION_FAILED',
  'STAGEHAND_WORKER_FAILED',
  'STAGEHAND_CLEANUP_FAILED',
] as const

/** One code from {@link STAGEHAND_ERROR_CODES}. */
export type StagehandErrorCode = typeof STAGEHAND_ERROR_CODES[number]

/**
 * Narrow a code received across the Worker boundary.
 * @param code - untrusted code from a Worker reply.
 * @returns whether the code is one of {@link STAGEHAND_ERROR_CODES}.
 */
export function isStagehandErrorCode(code: unknown): code is StagehandErrorCode {
  return (STAGEHAND_ERROR_CODES as readonly unknown[]).includes(code)
}

/** Stagehand browser failure carrying a stable {@link StagehandErrorCode}. */
export class StagehandError extends HarnessError {
  override readonly code: StagehandErrorCode

  /**
   * @param message - names the browser operation and the safe next step.
   * @param code - the failure class consumers route on.
   * @param options - standard `cause` chaining.
   */
  constructor(message: string, code: StagehandErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'StagehandError'
    this.code = code
  }
}

/** SDK requests did not drain before their connection Worker terminated; code `STAGEHAND_CLEANUP_FAILED`. */
export class StagehandDrainError extends StagehandError {
  /**
   * @param message - the drain failure and its underlying cleanup error.
   * @param options - standard `cause` chaining.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'STAGEHAND_CLEANUP_FAILED', options)
    this.name = 'StagehandDrainError'
  }
}
