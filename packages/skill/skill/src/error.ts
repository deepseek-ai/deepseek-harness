/** Typed skill failures shared by the registry, providers, and the `skill` tool. */

import { HarnessError } from '@deepseek-ai/dsh-error'

/**
 * Every {@link SkillError} code:
 * - `SKILL_NOT_FOUND`: no visible skill has the name, or it disappeared; the model picks another skill.
 * - `SKILL_NOT_MODEL_INVOCABLE`: the skill exists but its invocation policy excludes model calls.
 * - `SKILL_INVALID_DEFINITION`: a provider returned a candidate, definition, or catalog observation that violates the registry contract.
 * - `SKILL_READ_FAILED`: reading a skill file failed for a reason other than its absence; `cause` is the original error.
 */
export const SKILL_ERROR_CODES = [
  'SKILL_NOT_FOUND',
  'SKILL_NOT_MODEL_INVOCABLE',
  'SKILL_INVALID_DEFINITION',
  'SKILL_READ_FAILED',
] as const

/** One {@link SkillError} code. */
export type SkillErrorCode = typeof SKILL_ERROR_CODES[number]

/** Typed skill failure; `code` is one of {@link SKILL_ERROR_CODES}. */
export class SkillError extends HarnessError {
  override readonly code: SkillErrorCode

  constructor(message: string, code: SkillErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'SkillError'
    this.code = code
  }
}
