/** Matcher for liveshare fork guard refusals. */
import { expect } from 'vitest'
import type { LiveshareForkDeniedCode } from '../src/host/fork-errors.ts'

/**
 * Match a guard refusal by its reason text and recorded code.
 * @param reason - Text the model-facing reason contains, or a pattern it matches.
 * @param code - The refusal's recorded code.
 * @returns An asymmetric matcher for `toEqual`.
 */
export function denial(reason: string | RegExp, code: LiveshareForkDeniedCode): unknown {
  return {
    reason: (typeof reason === 'string' ? expect.stringContaining(reason) : expect.stringMatching(reason)) as string,
    info: { name: 'LiveshareForkDeniedError', code },
  }
}
