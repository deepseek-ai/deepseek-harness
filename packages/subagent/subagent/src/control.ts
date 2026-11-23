/**
 * Browser-facing subagent request validation and stable control failures.
 *
 * @module @deepseek-ai/dsh-subagent
 */

import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { SubagentError } from './error.ts'

const SESSION_ID_SCHEMA = z.string().min(1)
const CONTROL_ID_SCHEMAS = {
  'subagent.prompt': z.object({
    childSessionId: SESSION_ID_SCHEMA,
    delivery: z.enum(['queue', 'steer']),
  }),
  'subagent.interrupt': z.object({
    childSessionId: SESSION_ID_SCHEMA,
  }),
  'subagent.selectModel': z.object({
    childSessionId: SESSION_ID_SCHEMA,
    provider: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: z.string().min(1).optional(),
  }),
} as const

/**
 * Apply the subagent payload checks that are stricter than generated
 * branded-string codecs.
 * @param method - method name carried in the failure message.
 * @param payload - decoded control fields to validate.
 * @throws {RemoteError} `gateway/bad-request` with the original Zod issues.
 */
export function validateControlRequest(
  method: keyof typeof CONTROL_ID_SCHEMAS,
  payload: unknown,
): void {
  const parsed = CONTROL_ID_SCHEMAS[method].safeParse(payload)
  if (!parsed.success) {
    throw new RemoteError('gateway/bad-request', `invalid payload for ${method}`, { issues: parsed.error.issues })
  }
}

/**
 * Refuse one continuation prompt without exposing provider detail: admission
 * failures the caller can act on keep their own code, everything else is
 * internal.
 * @param error - the thrown value.
 * @param childSessionId - the addressed child.
 * @param signal - the caller's cancellation.
 * @returns Never — the refusal is thrown.
 * @throws {RemoteError} always.
 */
export function rejectPrompt(error: unknown, childSessionId: SessionId, signal: AbortSignal): never {
  if (isCancellation(error, signal)) {
    throw new RemoteError('gateway/cancelled', 'subagent prompt was cancelled', {}, { cause: error })
  }
  if (error instanceof AttachmentError) {
    throw new RemoteError('subagent/attachment-invalid', error.message, { reason: error.code }, { cause: error })
  }
  if (error instanceof SubagentError) {
    switch (error.code) {
      case 'MODEL_DOES_NOT_SUPPORT_IMAGES':
        throw new RemoteError(
          'subagent/attachment-invalid',
          error.message,
          { reason: error.code },
          { cause: error },
        )
      case 'NOT_RESUMABLE':
        throw new RemoteError(
          'subagent/not-resumable',
          'subagent cannot be resumed',
          { childSessionId },
          { cause: error },
        )
      case 'UNAUTHORIZED':
        throw new RemoteError(
          'subagent/unauthorized',
          'subagent membership in the active tree could not be verified',
          { childSessionId },
          { cause: error },
        )
      case 'DRAINING':
      case 'ACTIVATION_CLOSING':
      case 'ACTIVATION_LIMIT_REACHED':
      case 'CONTINUATION_UNAVAILABLE':
      case 'PERSISTENCE_UNAVAILABLE':
        throw new RemoteError(
          'subagent/delivery-unavailable',
          'subagent follow-up is temporarily unavailable',
          { childSessionId },
          { cause: error },
        )
      // A code outside the admission vocabulary is not the caller's move to make.
      default:
        break
    }
  }
  throw new RemoteError('gateway/internal', 'subagent prompt failed', {}, { cause: error })
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof SubagentError && error.code === 'CANCELLED')
}

/**
 * Report selection failures while preserving an uncertain persistence outcome.
 * @param error - failure from model selection or its durability barrier.
 * @param childSessionId - addressed child.
 * @param signal - caller cancellation before recording.
 * @returns Never — the refusal is thrown.
 * @throws {RemoteError} always; persistence uncertainty takes precedence over cancellation.
 */
export function rejectModelSelection(error: unknown, childSessionId: SessionId, signal: AbortSignal): never {
  if (error instanceof SubagentError && error.code === 'PERSISTENCE_UNCONFIRMED') {
    throw new RemoteError(
      'subagent/model-selection-unconfirmed',
      'the child model choice may have changed, but persistence is unconfirmed; reload its state before retrying',
      { childSessionId },
      { cause: error },
    )
  }
  if (isCancellation(error, signal)) {
    throw new RemoteError('gateway/cancelled', 'subagent model selection was cancelled', {}, { cause: error })
  }
  // LLM validation names the rejected provider, model, or effort.
  if (error instanceof LlmError) {
    throw new RemoteError('subagent/model-unavailable', error.message, { childSessionId }, { cause: error })
  }
  if (error instanceof SubagentError) {
    switch (error.code) {
      case 'MODEL_UNAVAILABLE':
        throw new RemoteError(
          'subagent/model-unavailable', 'the selected subagent model is unavailable; choose another model or retry',
          { childSessionId }, { cause: error },
        )
      case 'UNAUTHORIZED':
        throw new RemoteError(
          'subagent/unauthorized', 'subagent model selection is not authorized',
          { childSessionId }, { cause: error },
        )
      case 'NOT_RESUMABLE':
      case 'UNSUPPORTED_CAPABILITY':
      case 'NOT_CONTINUABLE':
        throw new RemoteError(
          'subagent/not-resumable', 'subagent does not support model selection',
          { childSessionId }, { cause: error },
        )
      case 'DRAINING':
      case 'ACTIVATION_CLOSING':
      case 'CONTINUATION_UNAVAILABLE':
      case 'PERSISTENCE_UNAVAILABLE':
        throw new RemoteError(
          'subagent/model-selection-unavailable', 'subagent model selection is temporarily unavailable',
          { childSessionId }, { cause: error },
        )
      // Other backend failures do not expose provider details through Remote.
      default:
        break
    }
  }
  throw new RemoteError('gateway/internal', 'subagent model selection failed', {}, { cause: error })
}
